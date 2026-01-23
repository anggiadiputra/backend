import cron from 'node-cron';
import { pricingSyncService } from '../services/pricing_sync.service';
import { PaymentService } from '../services/payment.service';
import { supabaseAdmin } from '../services/supabase.service';

/**
 * Initialize all automated cron jobs
 */
export function initCronJobs() {
    console.log('[Cron] Initializing automated tasks...');

    // 1. Automated Pricing Sync (Every day at 00:00)
    // Format: minute hour day-of-month month day-of-week
    cron.schedule('0 0 * * *', async () => {
        console.log('[Cron] Starting scheduled pricing sync...');
        try {
            const result = await pricingSyncService.syncAllPrices();
            console.log(`[Cron] Pricing sync successful: ${result.success} updated, ${result.failed} failed.`);
        } catch (error: any) {
            console.error('[Cron] Pricing sync failed:', error.message);
        }
    });

    // 2. Payment Status Check (Every 1 minute)
    cron.schedule('* * * * *', async () => {
        // console.log('[Cron] Checking pending payments...');
        try {
            const paymentService = new PaymentService(supabaseAdmin);
            await paymentService.checkPendingPayments();
        } catch (error: any) {
            console.error('[Cron] Payment check failed:', error.message);
        }
    });

    // 3. Health Check / Keep Alive (Every hour - Optional)
    cron.schedule('0 * * * *', () => {
        console.log('[Cron] System health check tick');
    });

    console.log('[Cron] All jobs scheduled.');
}
