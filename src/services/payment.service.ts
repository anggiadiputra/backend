import { SupabaseClient } from '@supabase/supabase-js';
import { PaymentMethodRepository, PaymentMethod } from '../repositories';
import { env } from '../config/env';
import * as crypto from 'crypto';
import { rdashService } from './rdash.service';
import { LoggerService } from './logger.service';

interface DuitkuStatusResponse {
    merchantCode: string;
    reference: string;
    amount: string;
    statusCode: string;
    statusMessage: string;
}

type TransactionStatus = 'pending' | 'success' | 'failed' | 'expired';

export interface ServiceResult<T> {
    success: boolean;
    data?: T;
    error?: string;
    statusCode?: number;
}

interface DuitkuPaymentMethod {
    paymentMethod: string;
    paymentName: string;
    paymentImage: string;
    totalFee: string | number;
}

interface DuitkuResponse {
    paymentFee?: DuitkuPaymentMethod[];
    responseCode?: string;
    responseMessage?: string;
}

// Cache duration in hours
const CACHE_DURATION_HOURS = 24;

export class PaymentService {
    private paymentMethodRepo: PaymentMethodRepository;
    private supabaseAdmin: SupabaseClient;

    constructor(supabaseAdmin: SupabaseClient) {
        this.paymentMethodRepo = new PaymentMethodRepository(supabaseAdmin);
        this.supabaseAdmin = supabaseAdmin;
    }

    /**
     * Generate Duitku signature using SHA256
     */
    private generateSignature(merchantCode: string, amount: string, datetime: string, apiKey: string): string {
        const data = merchantCode + amount + datetime + apiKey;
        return crypto.createHash('sha256').update(data).digest('hex');
    }

    /**
     * Fetch payment methods from Duitku API
     */
    private async fetchFromDuitku(amount: number = 10000): Promise<DuitkuPaymentMethod[]> {
        const datetime = new Date().toISOString().replace('T', ' ').substring(0, 19);
        const signature = this.generateSignature(
            env.DUITKU_MERCHANT_CODE,
            amount.toString(),
            datetime,
            env.DUITKU_API_KEY
        );

        const response = await fetch(`${env.DUITKU_BASE_URL}/paymentmethod/getpaymentmethod`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                merchantcode: env.DUITKU_MERCHANT_CODE,
                amount: amount,
                datetime: datetime,
                signature: signature,
            }),
        });

        if (!response.ok) {
            throw new Error(`Duitku API error: ${response.status}`);
        }

        const data = await response.json() as DuitkuResponse;

        if (data.responseCode !== '00' || !data.paymentFee) {
            throw new Error(data.responseMessage || 'Failed to fetch payment methods from Duitku');
        }

        return data.paymentFee;
    }

    /**
     * Check if cache is still valid (not older than CACHE_DURATION_HOURS)
     */
    private isCacheValid(syncedAt: string | null | undefined): boolean {
        if (!syncedAt) return false;

        const syncTime = new Date(syncedAt).getTime();
        const now = Date.now();
        const hoursDiff = (now - syncTime) / (1000 * 60 * 60);

        return hoursDiff < CACHE_DURATION_HOURS;
    }

    /**
     * Get payment methods with hybrid approach:
     * 1. Try to get from cache (database)
     * 2. If cache empty or stale, fetch from Duitku API
     * 3. Save to cache and return
     */
    async getPaymentMethods(amount: number = 10000): Promise<ServiceResult<PaymentMethod[]>> {
        try {
            // Step 1: Try to get from cache
            let cachedMethods: PaymentMethod[] = [];
            let cacheValid = false;

            try {
                cachedMethods = await this.paymentMethodRepo.findActivePaymentMethods();

                // Check if cache is valid (check first item's synced_at)
                if (cachedMethods.length > 0) {
                    cacheValid = this.isCacheValid(cachedMethods[0]?.last_synced_at);
                }
            } catch {
                // Cache query failed, will fetch from API
            }

            // Step 2: If cache valid, return from cache
            if (cacheValid && cachedMethods.length > 0) {
                return {
                    success: true,
                    data: cachedMethods,
                };
            }

            // Step 3: Fetch from Duitku API
            const duitkuMethods = await this.fetchFromDuitku(amount);

            // Step 4: Save to cache
            const savedMethods: PaymentMethod[] = [];
            for (const method of duitkuMethods) {
                try {
                    const saved = await this.paymentMethodRepo.upsertFromDuitku({
                        paymentMethod: method.paymentMethod,
                        paymentName: method.paymentName,
                        paymentImage: method.paymentImage,
                        totalFee: typeof method.totalFee === 'string' ? parseInt(method.totalFee) : method.totalFee,
                    });
                    savedMethods.push(saved);
                } catch {
                    // Continue on individual save error
                }
            }

            // If save failed but we have fresh data, return it directly
            if (savedMethods.length === 0 && duitkuMethods.length > 0) {
                return {
                    success: true,
                    data: duitkuMethods.map((m) => ({
                        id: crypto.randomUUID(),
                        payment_code: m.paymentMethod,
                        payment_name: m.paymentName,
                        payment_image: m.paymentImage,
                        payment_category: 'Other' as const,
                        is_enabled: true,
                        display_order: 0,
                    })) as PaymentMethod[],
                };
            }

            return {
                success: true,
                data: savedMethods,
            };
        } catch (error: any) {
            // Step 5: If API fails, try to return stale cache
            try {
                const staleMethods = await this.paymentMethodRepo.findActivePaymentMethods();
                if (staleMethods.length > 0) {
                    return {
                        success: true,
                        data: staleMethods,
                    };
                }
            } catch {
                // No cache available
            }

            return {
                success: false,
                error: error.message || 'Failed to fetch payment methods',
                statusCode: 500,
            };
        }
    }

    /**
     * Force sync payment methods from Duitku (ignore cache)
     */
    async syncPaymentMethods(amount: number = 10000): Promise<ServiceResult<{ synced: number; failed: number }>> {
        try {
            const duitkuMethods = await this.fetchFromDuitku(amount);

            let successCount = 0;
            let failedCount = 0;

            for (const method of duitkuMethods) {
                try {
                    await this.paymentMethodRepo.upsertFromDuitku({
                        paymentMethod: method.paymentMethod,
                        paymentName: method.paymentName,
                        paymentImage: method.paymentImage,
                        totalFee: typeof method.totalFee === 'string' ? parseInt(method.totalFee) : method.totalFee,
                    });
                    successCount++;
                } catch {
                    failedCount++;
                }
            }

            return {
                success: true,
                data: { synced: successCount, failed: failedCount },
            };
        } catch (error: any) {
            return {
                success: false,
                error: error.message || 'Failed to sync payment methods',
                statusCode: 500,
            };
        }
    }
    async checkPendingPayments(): Promise<ServiceResult<{ checked: number; updated: number; failed: number }>> {
        try {
            // Get all pending transactions
            const { data: transactions, error } = await this.supabaseAdmin
                .from('payment_transactions')
                .select('*')
                .eq('status', 'pending');

            if (error) throw error;
            if (!transactions || transactions.length === 0) {
                return { success: true, data: { checked: 0, updated: 0, failed: 0 } };
            }

            console.log(`[PaymentService] Checking ${transactions.length} pending transactions...`);

            let updatedCount = 0;
            let failedCount = 0;

            for (const tx of transactions) {
                try {
                    await this.checkSingleTransaction(tx);
                    updatedCount++;
                } catch (err: any) {
                    console.error(`[PaymentService] Failed to check transaction ${tx.merchant_order_id}:`, err.message);
                    failedCount++;
                }
            }

            return {
                success: true,
                data: { checked: transactions.length, updated: updatedCount, failed: failedCount }
            };

        } catch (error: any) {
            console.error('[PaymentService] Check pending payments error:', error);
            return {
                success: false,
                error: error.message,
                statusCode: 500
            };
        }
    }

    private async checkSingleTransaction(tx: any): Promise<void> {
        // 1. Generate Signature
        const signature = crypto.createHash('md5')
            .update(env.DUITKU_MERCHANT_CODE + tx.merchant_order_id + env.DUITKU_API_KEY)
            .digest('hex');

        // 2. Call Duitku API
        const response = await fetch(`${env.DUITKU_BASE_URL}/transactionStatus`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                merchantCode: env.DUITKU_MERCHANT_CODE,
                merchantOrderId: tx.merchant_order_id,
                signature: signature
            })
        });

        if (!response.ok) throw new Error(`Duitku API error: ${response.status}`);

        const duitkuData = await response.json() as DuitkuStatusResponse;

        // 3. Map Status
        // 00=Success, 01=Pending, 02=Failed/Expired
        let newStatus: TransactionStatus = 'pending';
        if (duitkuData.statusCode === '00') newStatus = 'success';
        else if (duitkuData.statusCode === '01') newStatus = 'pending';
        else newStatus = 'expired'; // Treat '02' as expired/failed

        // If status is still pending, do nothing
        if (newStatus === 'pending') return;

        // If status matches DB (e.g. already expired), do nothing (unless we want to sync details)
        if (newStatus === tx.status) return;

        console.log(`[PaymentService] Updating ${tx.merchant_order_id}: ${tx.status} -> ${newStatus}`);

        // 4. Update Transaction
        const updateData: any = {
            status: newStatus,
            status_code: duitkuData.statusCode,
            status_message: duitkuData.statusMessage,
            updated_at: new Date().toISOString()
        };

        if (newStatus === 'success') {
            updateData.paid_at = new Date().toISOString();
        }

        await this.supabaseAdmin
            .from('payment_transactions')
            .update(updateData)
            .eq('id', tx.id);

        // 5. Process Order if Success
        if (newStatus === 'success' && tx.order_id) {
            await this.processPaidOrder(tx.order_id, tx.merchant_order_id, duitkuData);
        } else if (newStatus === 'expired' && tx.order_id) {
            // Mark order as cancelled if payment expired
            await this.supabaseAdmin
                .from('orders')
                .update({
                    status: 'cancelled',
                    updated_at: new Date().toISOString(),
                    notes: 'Pembayaran kadaluarsa/gagal otomatis via cron.'
                })
                .eq('id', tx.order_id);
        }
    }

    private async processPaidOrder(orderId: string, merchantOrderId: string, duitkuData: any) {
        // Use OrderService to fulfill order
        // Need to instantiate OrderService (circular check? moving rdash logic out of PaymentService helps)
        // OrderService needs public supabase client and admin client. PaymentService only has admin.
        // We can pass admin for both as system action.

        // Dynamic import to avoid circular dependency issues at module level if any
        const { OrderService } = await import('./order.service');
        const orderService = new OrderService(this.supabaseAdmin, this.supabaseAdmin);

        // Fetch order to get user_id for logging context
        const { data: order } = await this.supabaseAdmin
            .from('orders')
            .select('user_id')
            .eq('id', orderId)
            .single();

        const userId = order?.user_id || 'system';

        const result = await orderService.fulfillOrder(parseInt(orderId), userId, 'payment_webhook');

        // Update with Duitku specific reference if not handled by fulfillOrder (fulfillOrder handles core logic)
        // But we want to ensure Duitku reference is saved.
        await this.supabaseAdmin
            .from('orders')
            .update({
                duitku_reference: duitkuData.reference,
                // If fulfillOrder failed, we still want to mark as paid so seller can retry manually?
                // fulfillOrder updates status to paid/processing if failed.
            })
            .eq('id', orderId);

        await LoggerService.logAction({
            user_id: userId,
            action: 'payment_cron_process',
            resource: `order/${orderId}`,
            payload: {
                duitku_status: 'success',
                fulfill_result: result
            },
            status: 'success'
        });
    }

    // saveDomain moved to OrderService, removing from here
    async checkStatusByOrderId(orderId: number): Promise<ServiceResult<any>> {
        try {
            // Get transaction for this order
            const { data: transaction, error } = await this.supabaseAdmin
                .from('payment_transactions')
                .select('*')
                .eq('order_id', orderId)
                .order('created_at', { ascending: false })
                .limit(1)
                .single();

            if (error || !transaction) {
                return { success: false, error: 'Transaction not found', statusCode: 404 };
            }

            await this.checkSingleTransaction(transaction);

            // Re-fetch updated status
            const { data: updatedTx } = await this.supabaseAdmin
                .from('payment_transactions')
                .select('*')
                .eq('id', transaction.id)
                .single();

            return { success: true, data: updatedTx };
        } catch (error: any) {
            return {
                success: false,
                error: error.message || 'Failed to check payment status',
                statusCode: 500
            };
        }
    }

    /**
     * Get all payment methods for admin (including disabled)
     */
    async adminGetPaymentMethods(): Promise<ServiceResult<PaymentMethod[]>> {
        try {
            const { data, error } = await this.supabaseAdmin
                .from('payment_methods')
                .select('*')
                .order('display_order', { ascending: true })
                .order('payment_name', { ascending: true });

            if (error) throw error;

            return { success: true, data };
        } catch (error: any) {
            return {
                success: false,
                error: error.message || 'Failed to fetch payment methods',
                statusCode: 500
            };
        }
    }

    /**
     * Update payment method (admin)
     */
    async updatePaymentMethod(
        id: string,
        data: Partial<PaymentMethod>
    ): Promise<ServiceResult<PaymentMethod>> {
        try {
            const { data: updated, error } = await this.supabaseAdmin
                .from('payment_methods')
                .update({
                    ...data,
                    updated_at: new Date().toISOString()
                })
                .eq('id', id)
                .select()
                .single();

            if (error) throw error;

            return { success: true, data: updated };
        } catch (error: any) {
            return {
                success: false,
                error: error.message || 'Failed to update payment method',
                statusCode: 500
            };
        }
    }

    /**
     * Batch update display order
     */
    async reorderPaymentMethods(orders: { id: string, display_order: number }[]): Promise<ServiceResult<{ updated: number }>> {
        try {
            let updatedCount = 0;

            // Execute sequentially or use a stored procedure if available. 
            // Simple sequential update for flexibility since list is small (<20 items usually)
            for (const item of orders) {
                const { error } = await this.supabaseAdmin
                    .from('payment_methods')
                    .update({
                        display_order: item.display_order,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', item.id);

                if (!error) updatedCount++;
            }

            return { success: true, data: { updated: updatedCount } };
        } catch (error: any) {
            return {
                success: false,
                error: error.message || 'Failed to reorder payment methods',
                statusCode: 500
            };
        }
    }
}
