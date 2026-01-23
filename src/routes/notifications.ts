import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { authMiddleware, sellerOnly } from '../middleware/auth';
import { strictLimiter } from '../middleware/security';
import { env } from '../config/env';
import { emailService } from '../services/email.service';

const notifications = new Hono();

// Apply auth middleware
notifications.use('*', authMiddleware);

// Send email (seller only)
const sendEmailSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  html: z.string().min(1),
  text: z.string().optional(),
});

notifications.post('/email', strictLimiter, sellerOnly, zValidator('json', sendEmailSchema), async (c) => {
  const { to, subject, html, text } = c.req.valid('json');

  try {
    const result = await emailService.sendEmail({
      to,
      subject,
      html,
      text: text || html.replace(/<[^>]*>/g, ''),
    });

    if (!result.success) {
      return c.json({ success: false, error: result.error }, 500);
    }

    return c.json({
      success: true,
      message: 'Email sent successfully',
      messageId: result.messageId,
    });
  } catch (error) {
    return c.json({ success: false, error: 'Failed to send email' }, 500);
  }
});

// Send order confirmation email
const orderConfirmationSchema = z.object({
  order_id: z.number(),
  customer_email: z.string().email(),
  customer_name: z.string(),
  order_details: z.object({
    items: z.array(z.object({
      domain: z.string(),
      action: z.string(),
      years: z.number(),
      price: z.number(),
    })),
    total: z.number(),
  }),
});

notifications.post('/order-confirmation', strictLimiter, sellerOnly, zValidator('json', orderConfirmationSchema), async (c) => {
  const { order_id, customer_email, customer_name, order_details } = c.req.valid('json');

  try {
    const itemsHtml = order_details.items.map(item =>
      `<tr>
        <td style="padding: 8px; border-bottom: 1px solid #eee;">${item.domain}</td>
        <td style="padding: 8px; border-bottom: 1px solid #eee;">${item.action}</td>
        <td style="padding: 8px; border-bottom: 1px solid #eee;">${item.years} tahun</td>
        <td style="padding: 8px; border-bottom: 1px solid #eee;">Rp ${item.price.toLocaleString('id-ID')}</td>
      </tr>`
    ).join('');

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #333;">Konfirmasi Pesanan #${order_id}</h2>
        <p>Halo ${customer_name},</p>
        <p>Terima kasih atas pesanan Anda. Berikut detail pesanan:</p>
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <thead>
            <tr style="background: #f5f5f5;">
              <th style="padding: 8px; text-align: left;">Domain</th>
              <th style="padding: 8px; text-align: left;">Aksi</th>
              <th style="padding: 8px; text-align: left;">Durasi</th>
              <th style="padding: 8px; text-align: left;">Harga</th>
            </tr>
          </thead>
          <tbody>${itemsHtml}</tbody>
          <tfoot>
            <tr>
              <td colspan="3" style="padding: 8px; font-weight: bold;">Total</td>
              <td style="padding: 8px; font-weight: bold;">Rp ${order_details.total.toLocaleString('id-ID')}</td>
            </tr>
          </tfoot>
        </table>
        <p>Silakan lakukan pembayaran untuk memproses pesanan Anda.</p>
      </div>
    `;

    const result = await emailService.sendEmail({
      to: customer_email,
      subject: `Konfirmasi Pesanan #${order_id}`,
      html,
    });

    if (!result.success) {
      return c.json({ success: false, error: result.error }, 500);
    }

    return c.json({
      success: true,
      message: 'Order confirmation email sent',
    });
  } catch (error) {
    return c.json({ success: false, error: 'Failed to send email' }, 500);
  }
});

// Send WhatsApp message (via Fonnte)
// Note: This endpoint is protected by authMiddleware (global for this file) AND strictLimiter
const whatsappSchema = z.object({
  target: z.string().min(1, 'Target phone number is required'),
  message: z.string().min(1, 'Message is required'),
});

notifications.post('/whatsapp', strictLimiter, zValidator('json', whatsappSchema), async (c) => {
  const { target, message } = c.req.valid('json');

  try {
    const formData = new FormData();
    formData.append('target', target);
    formData.append('message', message);

    if (env.FONNTE_TOKEN === 'TOKEN_NOT_SET') {
      return c.json({ success: false, message: 'Fonnte token is not configured on server' }, 503);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout

    try {
      const response = await fetch('https://api.fonnte.com/send', {
        method: 'POST',
        headers: {
          Authorization: env.FONNTE_TOKEN,
        },
        body: formData,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const result = await response.json();

      if (!response.ok) {
        console.error('Fonnte API Error:', result);
        return c.json({ success: false, message: 'Failed to send message via Fonnte', error: result }, 502);
      }

      return c.json({ success: true, data: result });
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        return c.json({ success: false, message: 'Fonnte API request timed out' }, 504);
      }
      throw error;
    }
  } catch (error: any) {
    console.error('Fonnte Proxy Exception:', error);
    return c.json({ success: false, message: 'Internal Server Error', error: error.message }, 500);
  }
});

export default notifications;
