import { SupabaseClient } from '@supabase/supabase-js';
import { OrderRepository } from '../repositories/order.repository';

export class InvoiceService {
    private orderRepo: OrderRepository;

    constructor(supabase: SupabaseClient) {
        this.orderRepo = new OrderRepository(supabase);
    }

    async generateInvoice(orderId: number) {
        const order = await this.orderRepo.findByIdWithDetails(orderId);

        if (!order) {
            throw new Error('Order not found');
        }

        // In a real application, you would use a library like 'pdfkit' or 'jspdf'
        // For now, we will return a simple HTML string that can be opened as a "file"
        const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Invoice #${order.id}</title>
        <style>
          body { font-family: sans-serif; padding: 20px; }
          .header { display: flex; justify-content: space-between; margin-bottom: 40px; }
          .invoice-box { max-width: 800px; margin: auto; padding: 30px; border: 1px solid #eee; box-shadow: 0 0 10px rgba(0, 0, 0, 0.15); }
          .title { font-size: 24px; font-weight: bold; color: #333; }
          table { width: 100%; line-height: inherit; text-align: left; border-collapse: collapse; }
          table td { padding: 5px; vertical-align: top; }
          table tr.heading td { background: #eee; border-bottom: 1px solid #ddd; font-weight: bold; }
          table tr.item td { border-bottom: 1px solid #eee; }
          table tr.total td:nth-child(2) { border-top: 2px solid #eee; font-weight: bold; }
        </style>
      </head>
      <body>
        <div class="invoice-box">
          <div class="header">
            <div>
              <div class="title">INVOICE</div>
              <div>Invoice #: INV-${order.created_at.slice(0, 4)}-${order.id}</div>
              <div>Date: ${new Date(order.created_at).toLocaleDateString()}</div>
              <div>Status: ${order.status.toUpperCase()}</div>
            </div>
            <div style="text-align: right;">
              <div><strong>Seller Info</strong></div>
              <div>Domain Management System</div>
              <div>support@example.com</div>
            </div>
          </div>

          <div style="margin-bottom: 20px;">
            <strong>Bill To:</strong><br />
            ${order.customers?.name || 'Guest Customer'}<br />
            ${order.customers?.email || ''}
          </div>

          <table>
            <tr class="heading">
              <td>Item</td>
              <td style="text-align: right;">Price</td>
            </tr>
            ${order.order_items?.map(item => `
              <tr class="item">
                <td>${item.domain_name}.${item.tld} (${item.action} - ${item.years} year${item.years > 1 ? 's' : ''})</td>
                <td style="text-align: right;">Rp ${item.subtotal.toLocaleString('id-ID')}</td>
              </tr>
            `).join('') || ''}
            <tr class="total">
              <td></td>
              <td style="text-align: right;">Total: Rp ${order.total_amount.toLocaleString('id-ID')}</td>
            </tr>
          </table>
          
          <div style="margin-top: 40px; font-size: 12px; color: #777;">
            <p>Thank you for your business!</p>
          </div>
        </div>
      </body>
      </html>
    `;

        return html;
    }
}
