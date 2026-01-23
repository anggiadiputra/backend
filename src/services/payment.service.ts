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
        const { data: order } = await this.supabaseAdmin
            .from('orders')
            .select('*')
            .eq('id', orderId)
            .single();

        if (!order || order.status === 'completed') return;

        console.log(`[PaymentService] Processing paid order ${orderId} (${order.action})`);

        let rdashResult: any;

        if (order.action === 'transfer') {
            rdashResult = await rdashService.transferDomain({
                domain: order.domain_name,
                customer_id: order.rdash_customer_id,
                auth_code: order.auth_code || '',
                period: order.period || 1,
                whois_protection: order.whois_protection || false,
            });
        } else if (order.action === 'renew') {
            rdashResult = await rdashService.renewDomain({
                domain_id: order.rdash_domain_id,
                period: order.period || 1,
                current_date: order.renew_current_date,
                whois_protection: order.whois_protection || false,
            });
        } else {
            rdashResult = await rdashService.registerDomain({
                domain: order.domain_name,
                customer_id: order.rdash_customer_id,
                period: order.period || 1,
                whois_protection: order.whois_protection || false,
            });
        }

        const updateData: any = {
            duitku_reference: duitkuData.reference,
            updated_at: new Date().toISOString(),
            status: rdashResult.success ? 'completed' : 'paid',
            notes: `Pembayaran sukses (Cron). ${rdashResult.success ? 'Domain berhasil diproses.' : 'Domain gagal diproses: ' + rdashResult.message}`
        };

        if (rdashResult.success) {
            updateData.completed_at = new Date().toISOString();
            updateData.rdash_response = rdashResult.data;

            // Save domain to rdash_domains table
            if (order.action !== 'renew' && rdashResult.data) {
                // Reuse save logic that should be in a shared helper, but for now inline simple upsert or call if available
                // rdashService doesn't have saveDomain. We can implement a simplified one here.
                await this.saveDomain(rdashResult.data, order.seller_id, order.rdash_customer_id);
            }
        } else {
            updateData.rdash_error = rdashResult.message;
        }

        await this.supabaseAdmin
            .from('orders')
            .update(updateData)
            .eq('id', orderId);

        await LoggerService.logAction({
            user_id: order.user_id,
            action: 'payment_cron_process',
            resource: `order/${orderId}`,
            payload: { status: updateData.status, rdash_success: rdashResult.success },
            status: 'success'
        });
    }

    private async saveDomain(domainData: any, sellerId: string, customerId: number) {
        // Simplified save domain
        const domainRecord = {
            id: domainData.id,
            seller_id: sellerId,
            customer_id: customerId,
            name: domainData.name || domainData.domain,
            status: domainData.status || 'active',
            expired_at: domainData.expired_at || domainData.expiry_date,
            created_at: new Date().toISOString(),
            synced_at: new Date().toISOString(),
        };
        await this.supabaseAdmin.from('rdash_domains').upsert(domainRecord, { onConflict: 'id' });
    }
}
