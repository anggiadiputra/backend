import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { authMiddleware, sellerOnly } from '../middleware/auth';
import { createAuthClient, supabaseAdmin } from '../services/supabase.service';
import { rdashService } from '../services/rdash.service';
import { env } from '../config/env';
import { LoggerService } from '../services/logger.service';
import { getClientIp } from '../middleware/security';

const pricing = new Hono();

// Default seller margin (20%)
const DEFAULT_MARGIN = 0.20;

// Get seller margin from database
async function getSellerMargin(): Promise<number> {
  try {
    const { data } = await supabaseAdmin
      .from('users')
      .select('margin')
      .eq('id', env.SELLER_ID)
      .single();

    return data?.margin || DEFAULT_MARGIN;
  } catch {
    return DEFAULT_MARGIN;
  }
}

// Calculate sell price with markup
// Priority: markup_amount (nominal) > markup_percentage > global margin
// Rounds to nearest 1000 (ribuan) for cleaner pricing
function calculateSellPrice(
  basePrice: number,
  markupAmount: number | null,
  markupPercentage: number | null,
  globalMargin: number
): number {
  let sellPrice: number;

  if (markupAmount && markupAmount > 0) {
    // Use fixed amount markup
    sellPrice = basePrice + markupAmount;
  } else if (markupPercentage !== null) {
    // Use percentage markup
    sellPrice = basePrice * (1 + markupPercentage);
  } else {
    // Use global margin
    sellPrice = basePrice * (1 + globalMargin);
  }

  // Round to nearest 1000 (ribuan)
  return Math.ceil(sellPrice / 1000) * 1000;
}

// Get TLD pricing (public)
const listPricingSchema = z.object({
  page: z.string().optional().default('1'),
  limit: z.string().optional().default('100'),
  search: z.string().optional(),
  category: z.string().optional(),
});

// Alias for /tlds endpoint - returns prices with markup for customers
pricing.get('/tlds', zValidator('query', listPricingSchema), async (c) => {
  const { page, limit, search, category } = c.req.valid('query');

  try {
    // Get seller margin
    const margin = await getSellerMargin();

    let query = supabaseAdmin
      .from('tld_pricing')
      .select('*', { count: 'exact' })
      .eq('is_active', true);

    if (search) {
      query = query.ilike('tld', `%${search}%`);
    }

    if (category) {
      query = query.eq('category', category);
    }

    const from = (parseInt(page) - 1) * parseInt(limit);
    const to = from + parseInt(limit) - 1;
    query = query.range(from, to).order('register_price', { ascending: true });

    const { data, error, count } = await query;

    if (error) {
      return c.json({ success: false, error: 'Failed to fetch TLDs' }, 500);
    }

    // Add sell prices with markup (per-TLD or global)
    const dataWithSellPrices = (data || []).map((item: any) => {
      const markupAmount = item.markup_amount || 0;
      const markupPercentage = item.markup_percentage;

      // Determine markup type used
      let markupType = 'global';
      if (markupAmount > 0) {
        markupType = 'amount';
      } else if (markupPercentage !== null) {
        markupType = 'percentage';
      }

      return {
        ...item,
        // Markup info
        markup_type: markupType,
        effective_margin: markupPercentage !== null ? markupPercentage : margin,
        // Sell prices (with markup)
        sell_register_price: calculateSellPrice(item.register_price, markupAmount, markupPercentage, margin),
        sell_renew_price: calculateSellPrice(item.renew_price, markupAmount, markupPercentage, margin),
        sell_transfer_price: calculateSellPrice(item.transfer_price, markupAmount, markupPercentage, margin),
        sell_proxy_price: item.proxy_price > 0
          ? calculateSellPrice(item.proxy_price, markupAmount, markupPercentage, margin)
          : 0,
        // Promo sell prices (with markup)
        sell_promo_register_price: item.is_promo && item.promo_register_price > 0
          ? calculateSellPrice(item.promo_register_price, markupAmount, markupPercentage, margin)
          : 0,
      };
    });

    return c.json({
      success: true,
      data: dataWithSellPrices,
      total: count || 0,
      page: parseInt(page),
      totalPages: count ? Math.ceil(count / parseInt(limit)) : 0,
    });
  } catch (error) {
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

pricing.get('/', zValidator('query', listPricingSchema), async (c) => {
  const { page, limit, search, category } = c.req.valid('query');

  try {
    let query = supabaseAdmin
      .from('tld_pricing')
      .select('*', { count: 'exact' });

    if (search) {
      query = query.ilike('tld', `%${search}%`);
    }

    if (category) {
      query = query.eq('category', category);
    }

    const from = (parseInt(page) - 1) * parseInt(limit);
    const to = from + parseInt(limit) - 1;
    query = query.range(from, to).order('tld');

    const { data, error, count } = await query;

    if (error) {
      return c.json({ success: false, error: 'Failed to fetch pricing' }, 500);
    }

    return c.json({
      success: true,
      data: data || [],
      total: count || 0,
      page: parseInt(page),
      totalPages: count ? Math.ceil(count / parseInt(limit)) : 0,
    });
  } catch (error) {
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});


// Get single TLD pricing
pricing.get('/:tld', async (c) => {
  const tld = c.req.param('tld');

  try {
    const { data, error } = await supabaseAdmin
      .from('tld_pricing')
      .select('*')
      .eq('tld', tld)
      .single();

    if (error || !data) {
      return c.json({ success: false, error: 'TLD not found' }, 404);
    }

    return c.json({ success: true, data });
  } catch (error) {
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// Sync pricing from Rdash (seller only)
pricing.post('/sync', authMiddleware, sellerOnly, async (c) => {
  try {
    const response = await rdashService.getPricing();

    if (!response.success || !response.data) {
      return c.json({ success: false, error: 'Failed to fetch pricing from Rdash' }, 500);
    }

    let successCount = 0;
    let failedCount = 0;

    for (const item of response.data as any[]) {
      try {
        const { error } = await supabaseAdmin
          .from('tld_pricing')
          .upsert({
            tld: item.tld,
            register_price: item.register_price,
            renew_price: item.renew_price,
            transfer_price: item.transfer_price,
            currency: item.currency || 'IDR',
            is_active: true,
            synced_at: new Date().toISOString(),
          }, { onConflict: 'tld' });

        if (error) {
          failedCount++;
        } else {
          successCount++;
        }
      } catch {
        failedCount++;
      }
    }

    await LoggerService.logAction({
      user_id: c.get('user')?.id,
      ip_address: getClientIp(c),
      action: 'pricing_sync',
      resource: 'rdash',
      payload: { successCount, failedCount },
      status: 'success'
    });

    return c.json({
      success: true,
      message: `Sync complete: ${successCount} success, ${failedCount} failed`,
      synced: successCount,
      failed: failedCount,
    });
  } catch (error) {
    return c.json({ success: false, error: 'Failed to sync pricing' }, 500);
  }
});

// Update TLD pricing (seller only)
const updatePricingSchema = z.object({
  register_price: z.number().optional(),
  renew_price: z.number().optional(),
  transfer_price: z.number().optional(),
  markup_percentage: z.number().nullable().optional(),
  markup_amount: z.number().optional(),
  is_active: z.boolean().optional(),
});

pricing.put('/:tld', authMiddleware, sellerOnly, zValidator('json', updatePricingSchema), async (c) => {
  const tld = c.req.param('tld');
  const updates = c.req.valid('json');

  try {
    const { data, error } = await supabaseAdmin
      .from('tld_pricing')
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq('tld', tld)
      .select()
      .single();

    if (error) {
      await LoggerService.logAction({
        user_id: c.get('user')?.id,
        ip_address: getClientIp(c),
        action: 'pricing_update',
        resource: tld,
        payload: { updates, error: error.message },
        status: 'failure'
      });
      return c.json({ success: false, error: 'Failed to update pricing' }, 500);
    }

    await LoggerService.logAction({
      user_id: c.get('user')?.id,
      ip_address: getClientIp(c),
      action: 'pricing_update',
      resource: tld,
      payload: updates,
      status: 'success'
    });

    return c.json({
      success: true,
      data,
      message: 'Pricing updated successfully',
    });
  } catch (error) {
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export default pricing;
