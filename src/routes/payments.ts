import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { authMiddleware, sellerOnly } from '../middleware/auth';
import { supabaseAdmin } from '../services/supabase.service';
import { rdashService } from '../services/rdash.service';
import { PaymentService } from '../services/payment.service';
import { env } from '../config/env';
import { LoggerService } from '../services/logger.service';
import { getClientIp } from '../middleware/security';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

const payments = new Hono();

// Helper to convert status code
const toStatusCode = (code: number): ContentfulStatusCode => code as ContentfulStatusCode;

// Get payment methods (public) - Hybrid approach: cache + API fallback
payments.get('/methods', async (c) => {
  try {
    const amount = parseInt(c.req.query('amount') || '10000');
    const paymentService = new PaymentService(supabaseAdmin);
    const result = await paymentService.getPaymentMethods(amount);

    if (!result.success) {
      return c.json({ success: false, error: result.error }, toStatusCode(result.statusCode || 500));
    }

    return c.json({
      success: true,
      data: result.data || [],
    });
  } catch (error) {
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// Sync payment methods from Duitku (seller only)
payments.post('/methods/sync', authMiddleware, sellerOnly, async (c) => {
  try {
    const paymentService = new PaymentService(supabaseAdmin);
    const result = await paymentService.syncPaymentMethods();

    if (!result.success) {
      return c.json({ success: false, error: result.error }, toStatusCode(result.statusCode || 500));
    }

    return c.json({
      success: true,
      message: `Sync complete: ${result.data?.synced} success, ${result.data?.failed} failed`,
      synced: result.data?.synced,
      failed: result.data?.failed,
    });
  } catch (error) {
    return c.json({ success: false, error: 'Failed to sync payment methods' }, 500);
  }
});


// Create payment
const createPaymentSchema = z.object({
  order_id: z.string(),
  payment_method: z.string(),
  amount: z.number(),
  customer_email: z.string().email(),
  customer_name: z.string(),
});

payments.post('/create', authMiddleware, zValidator('json', createPaymentSchema), async (c) => {
  const { order_id, payment_method, amount, customer_email, customer_name } = c.req.valid('json');

  try {
    const merchantOrderId = `ORD-${order_id}-${Date.now()}`;
    const timestamp = Math.floor(Date.now() / 1000).toString();

    // Generate invoice number (matches frontend logic: INV/YYYYMM/SHORT_UUID)
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    // order_id is UUID string
    const shortId = order_id.slice(0, 8).toUpperCase();
    const invoiceNumber = `INV/${year}${month}/${shortId}`;

    const signature = await generateDuitkuSignature(
      env.DUITKU_MERCHANT_CODE,
      amount.toString(),
      timestamp,
      env.DUITKU_API_KEY
    );

    const response = await fetch(`${env.DUITKU_BASE_URL}/merchant/v2/inquiry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        merchantCode: env.DUITKU_MERCHANT_CODE,
        paymentAmount: amount,
        paymentMethod: payment_method,
        merchantOrderId,
        productDetails: `Order #${order_id}`,
        email: customer_email,
        customerVaName: customer_name,
        callbackUrl: `${env.BACKEND_URL}/api/payments/callback`,
        returnUrl: `${env.FRONTEND_URL}/orders/${order_id}`,
        signature,
        expiryPeriod: 1440, // 24 hours
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      return c.json({ success: false, error: 'Failed to create payment' }, 500);
    }

    const paymentData = await response.json() as { reference?: string; paymentUrl?: string; vaNumber?: string; qrString?: string; amount?: number };

    // Save payment record
    const { data: savedTx, error: saveError } = await supabaseAdmin
      .from('payment_transactions')
      .insert({
        order_id,
        merchant_order_id: merchantOrderId,
        invoice_number: invoiceNumber,
        reference: paymentData.reference,
        payment_method,
        amount,
        status: 'pending',
        payment_url: paymentData.paymentUrl,
        va_number: paymentData.vaNumber,
        qr_string: paymentData.qrString,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        created_at: new Date().toISOString(),
      })
      .select('id, invoice_number')
      .single();

    if (saveError) {
    }

    await LoggerService.logAction({
      user_id: c.get('user').id,
      ip_address: getClientIp(c),
      action: 'create_payment',
      resource: `order/${order_id}`,
      payload: {
        amount,
        payment_method,
        merchant_order_id: merchantOrderId,
        reference: paymentData.reference
      },
      status: 'success'
    });

    return c.json({
      success: true,
      data: {
        reference: paymentData.reference,
        payment_url: paymentData.paymentUrl,
        va_number: paymentData.vaNumber,
        qr_string: paymentData.qrString,
        amount: paymentData.amount,
        transaction_id: savedTx?.id,
        invoice_number: savedTx?.invoice_number,
      },
    });
  } catch (error) {
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// Payment callback (from Duitku) - This replaces the Supabase Edge Function
// Duitku sends callback here after payment is completed
payments.post('/callback', async (c) => {
  console.log('[Payment Callback] Received callback from Duitku');

  try {
    // Parse callback data - Duitku sends as form-urlencoded or JSON
    let callbackData: {
      merchantCode: string;
      amount: string;
      merchantOrderId: string;
      productDetail?: string;
      additionalParam?: string;
      paymentCode: string;
      resultCode: string;
      merchantUserId?: string;
      reference: string;
      signature: string;
      publisherOrderId?: string;
      spUserHash?: string;
      settlementDate?: string;
      issuerCode?: string;
    };

    const contentType = c.req.header('content-type') || '';

    if (contentType.includes('application/json')) {
      callbackData = await c.req.json();
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      const formData = await c.req.parseBody();
      callbackData = {
        merchantCode: (formData.merchantCode as string) || '',
        amount: (formData.amount as string) || '',
        merchantOrderId: (formData.merchantOrderId as string) || '',
        productDetail: (formData.productDetail as string) || '',
        additionalParam: (formData.additionalParam as string) || '',
        paymentCode: (formData.paymentCode as string) || '',
        resultCode: (formData.resultCode as string) || '',
        merchantUserId: (formData.merchantUserId as string) || '',
        reference: (formData.reference as string) || '',
        signature: (formData.signature as string) || '',
        publisherOrderId: (formData.publisherOrderId as string) || '',
        spUserHash: (formData.spUserHash as string) || '',
        settlementDate: (formData.settlementDate as string) || '',
        issuerCode: (formData.issuerCode as string) || '',
      };
    } else {
      // Try JSON as default
      callbackData = await c.req.json();
    }

    console.log('[Payment Callback] Data:', {
      merchantOrderId: callbackData.merchantOrderId,
      resultCode: callbackData.resultCode,
      amount: callbackData.amount,
      reference: callbackData.reference,
    });

    // Validate required fields
    if (!callbackData.merchantOrderId || !callbackData.signature || !callbackData.amount) {
      console.error('[Payment Callback] Missing required fields');
      return c.json({ success: false, error: 'Missing required fields' }, 400);
    }

    // Verify signature
    const expectedSignature = await generateDuitkuCallbackSignature(
      callbackData.merchantCode,
      callbackData.amount,
      callbackData.merchantOrderId,
      env.DUITKU_API_KEY
    );

    if (callbackData.signature.toLowerCase() !== expectedSignature.toLowerCase()) {
      console.error('[Payment Callback] Invalid signature');
      return c.json({ success: false, error: 'Invalid signature' }, 401);
    }

    // Map result code to status
    const newStatus = callbackData.resultCode === '00' ? 'success' : 'failed';
    console.log('[Payment Callback] Payment status:', newStatus);

    // Update payment_transactions table
    const updateData: Record<string, unknown> = {
      status: newStatus,
      status_code: callbackData.resultCode,
      duitku_reference: callbackData.reference,
      callback_data: callbackData,
      updated_at: new Date().toISOString(),
    };

    if (newStatus === 'success') {
      updateData.paid_at = new Date().toISOString();
    }

    const { data: transaction, error: updateError } = await supabaseAdmin
      .from('payment_transactions')
      .update(updateData)
      .eq('merchant_order_id', callbackData.merchantOrderId)
      .select()
      .single();

    if (updateError) {
      console.error('[Payment Callback] Failed to update transaction:', updateError.message);
      // Still return success to Duitku to prevent retries
      return c.json({ success: true });
    }

    console.log('[Payment Callback] Transaction updated:', transaction?.id);

    // If payment successful, process the domain order via Rdash API
    if (newStatus === 'success' && transaction?.order_id) {
      // Fetch order details
      const { data: order, error: orderFetchError } = await supabaseAdmin
        .from('orders')
        .select('*')
        .eq('id', transaction.order_id)
        .single();

      if (orderFetchError || !order) {
        console.error('[Payment Callback] Order not found:', transaction.order_id);
      } else {
        console.log('[Payment Callback] Processing order:', order.id, 'Action:', order.action);

        let rdashResult: { success: boolean; data?: any; message?: string };

        // Register, transfer, or renew domain based on action
        if (order.action === 'transfer') {
          console.log('[Payment Callback] Transferring domain:', order.domain_name);
          rdashResult = await rdashService.transferDomain({
            domain: order.domain_name,
            customer_id: order.rdash_customer_id,
            auth_code: order.auth_code || '',
            period: order.period || 1,
            whois_protection: order.whois_protection || false,
          });
        } else if (order.action === 'renew') {
          console.log('[Payment Callback] Renewing domain:', order.rdash_domain_id);
          rdashResult = await rdashService.renewDomain({
            domain_id: order.rdash_domain_id,
            period: order.period || 1,
            current_date: order.renew_current_date,
            whois_protection: order.whois_protection || false,
          });
        } else {
          console.log('[Payment Callback] Registering domain:', order.domain_name);
          rdashResult = await rdashService.registerDomain({
            domain: order.domain_name,
            customer_id: order.rdash_customer_id,
            period: order.period || 1,
            whois_protection: order.whois_protection || false,
          });
        }

        console.log('[Payment Callback] Rdash result:', rdashResult.success, rdashResult.message);

        // Update order status based on Rdash result
        const orderUpdateData: Record<string, unknown> = {
          duitku_reference: callbackData.reference,
          payment_method: callbackData.paymentCode,
          updated_at: new Date().toISOString(),
          notes: `Pembayaran via ${callbackData.paymentCode}. Ref: ${callbackData.reference}. Settlement: ${callbackData.settlementDate || '-'}`,
        };

        const actionLabel = order.action === 'transfer' ? 'ditransfer' : order.action === 'renew' ? 'diperpanjang' : 'didaftarkan';

        if (rdashResult.success) {
          orderUpdateData.status = 'completed';
          orderUpdateData.completed_at = new Date().toISOString();
          orderUpdateData.rdash_response = rdashResult.data;
          orderUpdateData.notes = `${orderUpdateData.notes}. Domain berhasil ${actionLabel}.`;

          // Save domain to rdash_domains table for register/transfer
          if (order.action !== 'renew' && rdashResult.data) {
            await saveDomainToDatabase(rdashResult.data, order.seller_id, order.rdash_customer_id);
          }
        } else {
          orderUpdateData.status = 'paid'; // Payment received but domain registration failed
          orderUpdateData.rdash_error = rdashResult.message;
          orderUpdateData.notes = `${orderUpdateData.notes}. Domain gagal diproses: ${rdashResult.message}`;
        }

        await supabaseAdmin
          .from('orders')
          .update(orderUpdateData)
          .eq('id', transaction.order_id);

        console.log('[Payment Callback] Order updated:', transaction.order_id, orderUpdateData.status);
      }
    }

    // Log payment callback
    if (transaction?.order_id) {
      // Fetch order to get user_id (not ideal but callback is server-to-server)
      const { data: order } = await supabaseAdmin.from('orders').select('user_id').eq('id', transaction.order_id).single();

      await LoggerService.logAction({
        user_id: order?.user_id, // Might be undefined if order fetch failed or anonymous
        ip_address: getClientIp(c),
        action: 'payment_callback',
        resource: `transaction/${callbackData.merchantOrderId}`,
        payload: {
          status: newStatus,
          amount: callbackData.amount,
          reference: callbackData.reference,
          resultCode: callbackData.resultCode
        },
        status: newStatus === 'success' ? 'success' : 'failure'
      });
    }

    // Return success response to Duitku
    return c.json({ success: true });
  } catch (error) {
    console.error('[Payment Callback] Error:', error);
    // Return success to prevent Duitku from retrying
    return c.json({ success: true });
  }
});

// Helper function to save domain to database
async function saveDomainToDatabase(
  domainData: Record<string, unknown>,
  sellerId: string,
  rdashCustomerId: number
) {
  try {
    const domainRecord = {
      id: domainData.id,
      seller_id: sellerId,
      customer_id: rdashCustomerId,
      name: domainData.name || domainData.domain,
      status: domainData.status || 'active',
      status_label: domainData.status_label || 'Active',
      status_badge: domainData.status_badge,
      is_premium: domainData.is_premium || false,
      is_locked: domainData.is_locked || false,
      is_locked_label: domainData.is_locked_label,
      is_registrar_locked: domainData.is_registrar_locked || false,
      is_registrar_locked_label: domainData.is_registrar_locked_label,
      reseller_id: domainData.reseller_id,
      nameserver_1: domainData.nameserver_1 || domainData.ns1,
      nameserver_2: domainData.nameserver_2 || domainData.ns2,
      nameserver_3: domainData.nameserver_3 || domainData.ns3,
      nameserver_4: domainData.nameserver_4 || domainData.ns4,
      nameserver_5: domainData.nameserver_5 || domainData.ns5,
      expired_at: domainData.expired_at || domainData.expiry_date,
      rdash_created_at: domainData.created_at,
      rdash_updated_at: domainData.updated_at,
      synced_at: new Date().toISOString(),
    };

    console.log('[Payment Callback] Saving domain:', domainRecord.name);

    const { error } = await supabaseAdmin
      .from('rdash_domains')
      .upsert(domainRecord, { onConflict: 'id' });

    if (error) {
      console.error('[Payment Callback] Failed to save domain:', error.message);
    } else {
      console.log('[Payment Callback] Domain saved successfully:', domainRecord.name);
    }
  } catch (err) {
    console.error('[Payment Callback] Error saving domain:', err);
  }
}

// Helper functions
async function generateDuitkuSignature(
  merchantCode: string,
  amount: string,
  timestamp: string,
  apiKey: string
): Promise<string> {
  const data = merchantCode + amount + timestamp + apiKey;
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest('MD5', dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function generateDuitkuCallbackSignature(
  merchantCode: string,
  amount: string,
  merchantOrderId: string,
  apiKey: string
): Promise<string> {
  const data = merchantCode + amount + merchantOrderId + apiKey;
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest('MD5', dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export default payments;
