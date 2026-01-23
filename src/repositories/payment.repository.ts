import { SupabaseClient } from '@supabase/supabase-js';
import { BaseRepository, FindOptions, PaginatedResult } from './base.repository';

export interface Payment {
    id: number;
    order_id: number;
    merchant_order_id: string;
    reference?: string;
    payment_method: string;
    amount: number;
    status: 'pending' | 'paid' | 'failed' | 'expired' | 'cancelled';
    payment_url?: string;
    va_number?: string;
    qr_string?: string;
    expires_at?: string;
    paid_at?: string;
    created_at: string;
    updated_at?: string;
}

// Updated to match existing Supabase schema
// Note: fee_flat, fee_percent, min_amount, max_amount columns were removed
// Fee is now calculated dynamically during payment creation
export interface PaymentMethod {
    id: string;  // UUID
    payment_code: string;
    payment_name: string;
    payment_image?: string;
    payment_category: 'Virtual Account' | 'E-Wallet' | 'QRIS' | 'Retail' | 'Other';
    is_enabled: boolean;
    display_order: number;
    last_synced_at?: string;
    created_at?: string;
    updated_at?: string;
}

export class PaymentRepository extends BaseRepository<Payment> {
    constructor(supabase: SupabaseClient) {
        super(supabase, 'payments');
    }

    async findByMerchantOrderId(merchantOrderId: string): Promise<Payment | null> {
        const { data, error } = await this.supabase
            .from(this.tableName)
            .select('*')
            .eq('merchant_order_id', merchantOrderId)
            .single();

        if (error || !data) {
            return null;
        }

        return data as Payment;
    }

    async findByOrderId(orderId: number): Promise<Payment[]> {
        const { data, error } = await this.supabase
            .from(this.tableName)
            .select('*')
            .eq('order_id', orderId)
            .order('created_at', { ascending: false });

        if (error) {
            throw new Error(`Failed to fetch payments: ${error.message}`);
        }

        return (data || []) as Payment[];
    }

    async updateStatus(
        merchantOrderId: string,
        status: Payment['status'],
        paidAt?: string
    ): Promise<Payment | null> {
        const { data, error } = await this.supabase
            .from(this.tableName)
            .update({
                status,
                paid_at: paidAt || null,
                updated_at: new Date().toISOString(),
            })
            .eq('merchant_order_id', merchantOrderId)
            .select()
            .single();

        if (error) {
            throw new Error(`Failed to update payment status: ${error.message}`);
        }

        return data as Payment;
    }

    async getPendingPayments(): Promise<Payment[]> {
        const { data, error } = await this.supabase
            .from(this.tableName)
            .select('*')
            .eq('status', 'pending')
            .lt('expires_at', new Date().toISOString());

        if (error) {
            throw new Error(`Failed to fetch pending payments: ${error.message}`);
        }

        return (data || []) as Payment[];
    }
}

export class PaymentMethodRepository extends BaseRepository<PaymentMethod> {
    constructor(supabase: SupabaseClient) {
        super(supabase, 'payment_methods');
    }

    async findActivePaymentMethods(): Promise<PaymentMethod[]> {
        const { data, error } = await this.supabase
            .from(this.tableName)
            .select('*')
            .eq('is_enabled', true)
            .order('display_order', { ascending: true });

        if (error) {
            throw new Error(`Failed to fetch payment methods: ${error.message}`);
        }

        return (data || []) as PaymentMethod[];
    }

    /**
     * Determine payment category based on payment method code
     */
    private getPaymentCategory(code: string): PaymentMethod['payment_category'] {
        // Virtual Account codes
        const vaList = ['VA', 'BT', 'B1', 'A1', 'I1', 'M2', 'AG', 'NC', 'BV', 'BC', 'BR'];
        // E-Wallet codes
        const ewalletList = ['OV', 'DA', 'LA', 'LQ', 'SA'];
        // QRIS codes
        const qrisList = ['SP', 'NQ', 'DQ'];
        // Retail codes
        const retailList = ['FT', 'A2', 'IR'];

        if (vaList.includes(code)) return 'Virtual Account';
        if (ewalletList.includes(code)) return 'E-Wallet';
        if (qrisList.includes(code)) return 'QRIS';
        if (retailList.includes(code)) return 'Retail';
        return 'Other';
    }

    async upsertFromDuitku(method: {
        paymentMethod: string;
        paymentName: string;
        paymentImage: string;
        totalFee: number;
    }): Promise<PaymentMethod> {
        const category = this.getPaymentCategory(method.paymentMethod);

        // Fee columns removed - fee is calculated dynamically during payment creation
        const data = {
            payment_code: method.paymentMethod,
            payment_name: method.paymentName,
            payment_image: method.paymentImage,
            payment_category: category,
            is_enabled: true,
            last_synced_at: new Date().toISOString(),
        };

        const { data: upserted, error } = await this.supabase
            .from(this.tableName)
            .upsert(data, { onConflict: 'payment_code' })
            .select('payment_code')
            .single();

        if (error) {
            throw new Error(`Failed to upsert payment method: ${error.message}`);
        }

        return upserted as PaymentMethod;
    }
}
