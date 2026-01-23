import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { authMiddleware, sellerOnly } from '../middleware/auth';
import { rdashService } from '../services/rdash.service';

const transactions = new Hono();

// Apply auth middleware
transactions.use('*', authMiddleware);

// Get Rdash transactions (seller only)
const listTransactionsSchema = z.object({
  page: z.string().optional().default('1'),
  limit: z.string().optional().default('10'),
  type: z.string().optional(),
  tld: z.string().optional(),
  date_range: z.string().optional(),
});

transactions.get('/rdash', sellerOnly, zValidator('query', listTransactionsSchema), async (c) => {
  const { page, limit, type, tld, date_range } = c.req.valid('query');

  try {
    const response = await rdashService.getTransactions({
      page: parseInt(page),
      limit: parseInt(limit),
      type: type ? parseInt(type) : undefined,
      tld,
      date_range,
    });

    return c.json({
      success: true,
      data: response.data || [],
      meta: response.meta,
    });
  } catch (error) {
    return c.json({ success: false, error: 'Failed to fetch transactions' }, 500);
  }
});

export default transactions;
