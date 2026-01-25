import { SupabaseClient } from '@supabase/supabase-js';
import { OrderRepository, CustomerRepository } from '../repositories';

export class InvoiceService {
  private orderRepo: OrderRepository;
  private supabase: SupabaseClient; // Added supabase as a class property

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase; // Initialized supabase
    this.orderRepo = new OrderRepository(supabase);
  }

  async generateInvoice(orderId: string): Promise<string> {
    try {
      const order = await this.orderRepo.findByIdWithDetails(orderId);

      if (!order) {
        throw new Error('Order not found');
      }

      // Get customer details (from relation or repo)
      const customerRepo = new CustomerRepository(this.supabase);
      let customer = null;

      if (order.customer_id) {
        // Determine if customer_id is numeric (legacy) or uuid (new)
        // Actually the repo uses string now
        customer = await customerRepo.findById(order.customer_id);
      }

      // Format numbers
      const formatter = new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        minimumFractionDigits: 0
      });

      const date = new Date(order.created_at).toLocaleDateString('id-ID', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });

      // Calculate tax (11% PPN)
      const tax = order.total_price * 0.11;
      const subtotal = order.total_price * 0.89; // Assuming total includes tax

      // Generate HTML
      // This is a simple template
      return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Invoice #${orderId}</title>
    <style>
        body { font-family: Helvetica, Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
        .header { display: flex; justify-content: space-between; margin-bottom: 40px; }
        .invoice-details { text-align: right; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th, td { text-align: left; padding: 12px; border-bottom: 1px solid #ddd; }
        .totals { margin-top: 20px; float: right; width: 300px; }
        .row { display: flex; justify-content: space-between; margin-bottom: 8px; }
        .total-row { font-weight: bold; border-top: 2px solid #333; padding-top: 8px; }
    </style>
</head>
<body>
    <div class="header">
        <div>
            <h1>INVOICE</h1>
            <p><strong>Billed To:</strong><br>${customer?.name || 'Customer'}<br>${customer?.email || ''}</p>
        </div>
        <div class="invoice-details">
            <p><strong>Invoice #:</strong> ${order.payment_transactions?.[0]?.invoice_number || `INV-${orderId.substring(0, 8)}`}</p>
            <p><strong>Date:</strong> ${date}</p>
            <p><strong>Order ID:</strong> #${orderId}</p>
        </div>
    </div>

    <table>
        <thead>
            <tr>
                <th>Item</th>
                <th>Type</th>
                <th>Price</th>
            </tr>
        </thead>
        <tbody>
            ${order.order_items?.map(item => `
            <tr>
                <td>${item.domain_name}</td>
                <td style="text-transform: capitalize">${item.action} (${item.years} year)</td>
                <td>${formatter.format(item.subtotal || item.price)}</td>
            </tr>
            `).join('') || `
            <tr>
                <td>Domain Service</td>
                <td style="text-transform: capitalize">Service</td>
                <td>${formatter.format(order.total_price)}</td>
            </tr>
            `}
        </tbody>
    </table>

    <div class="totals">
        <div class="row">
            <span>Subtotal:</span>
            <span>${formatter.format(subtotal)}</span>
        </div>
        <div class="row">
            <span>PPN (11%):</span>
            <span>${formatter.format(tax)}</span>
        </div>
        <div class="row total-row">
            <span>Total:</span>
            <span>${formatter.format(order.total_price)}</span>
        </div>
    </div>
</body>
</html>
            `;
    } catch (error: any) {
      throw new Error(`Failed to generate invoice: ${error.message}`);
    }
  }
}
