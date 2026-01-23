import { supabaseAdmin } from './supabase.service';
import { rdashService } from './rdash.service';
import { LoggerService } from './logger.service';

export interface TldPricing {
    tld: string;
    rdash_id: number;
    extension_id: number;
    registry_id: number;
    registry_name: string;
    register_price: number;
    renew_price: number;
    transfer_price: number;
    redemption_price: number;
    proxy_price: number;
    registration_prices: Record<string, number>;
    renewal_prices: Record<string, number>;
    currency: string;
    enable_whois_protection: boolean;
    sell_option: number;
    status: number;
    status_label: string;
    is_active: boolean;
    is_promo: boolean;
    promo_register_price: number;
    promo_description?: string;
    last_synced_at: string;
}

class PricingSyncService {
    private parsePrice(value: string | number | undefined): number {
        if (value === undefined || value === '' || value === null) return 0;
        return typeof value === 'string' ? parseFloat(value) || 0 : value;
    }

    private convertPrices(prices: Record<string, string | number>): Record<string, number> {
        const result: Record<string, number> = {};
        if (!prices) return result;
        for (const [key, value] of Object.entries(prices)) {
            const numValue = this.parsePrice(value);
            if (numValue > 0) {
                result[key] = numValue;
            }
        }
        return result;
    }

    private transformPrice(price: any): TldPricing {
        const ext = price.domain_extension;
        const tld = ext.extension.replace(/^\./, '');

        const registrationPrices = this.convertPrices(price.registration);
        const renewalPrices = this.convertPrices(price.renewal);

        const hasPromo = price.promo_registration &&
            price.promo_registration.registration &&
            Object.values(price.promo_registration.registration).some(v => v && v !== '');

        let promoRegisterPrice = 0;
        let promoDescription = '';

        if (hasPromo && price.promo_registration) {
            const promoRegPrices = this.convertPrices(price.promo_registration.registration);
            promoRegisterPrice = promoRegPrices['1'] || 0;
            promoDescription = price.promo_registration.description || '';
        }

        return {
            tld,
            rdash_id: price.id,
            extension_id: ext.id,
            registry_id: ext.registry_id,
            registry_name: ext.registry_name,
            register_price: this.parsePrice(price.registration['1']),
            renew_price: this.parsePrice(price.renewal['1']),
            transfer_price: this.parsePrice(price.transfer),
            redemption_price: this.parsePrice(price.redemption),
            proxy_price: this.parsePrice(price.proxy),
            registration_prices: registrationPrices,
            renewal_prices: renewalPrices,
            currency: price.currency,
            enable_whois_protection: ext.enable_whois_protection === 1,
            sell_option: ext.sell_option,
            status: ext.status,
            status_label: ext.status_label,
            is_active: true,
            is_promo: !!hasPromo,
            promo_register_price: promoRegisterPrice,
            promo_description: promoDescription,
            last_synced_at: new Date().toISOString(),
        };
    }

    async syncAllPrices(): Promise<{ success: number; failed: number; total: number }> {
        console.log('[PricingSync] Starting automated price sync...');

        let successCount = 0;
        let failedCount = 0;

        try {
            // 1. Fetch regular and promo prices
            const regularPrices = await rdashService.getAllExtensionPrices(false);
            const promoPrices = await rdashService.getAllExtensionPrices(true);

            // 2. Map promo data
            const promoMap = new Map<string, any>();
            for (const promo of promoPrices) {
                const tld = promo.domain_extension.extension.replace(/^\./, '');
                promoMap.set(tld, promo);
            }

            // 3. Process and merge
            for (const price of regularPrices) {
                try {
                    const tld = price.domain_extension.extension.replace(/^\./, '');
                    const transformed = this.transformPrice(price);

                    const promoPrice = promoMap.get(tld);
                    if (promoPrice && promoPrice.promo_registration) {
                        const promoRegPrices = this.convertPrices(promoPrice.promo_registration.registration);
                        if (Object.keys(promoRegPrices).length > 0) {
                            transformed.is_promo = true;
                            transformed.promo_register_price = promoRegPrices['1'] || 0;
                            transformed.promo_description = promoPrice.promo_registration.description || '';
                        }
                    }

                    // 4. Upsert to Supabase
                    const { error } = await supabaseAdmin
                        .from('tld_pricing')
                        .upsert(transformed, { onConflict: 'tld' });

                    if (error) {
                        console.error(`[PricingSync] Failed to sync ${tld}:`, error.message);
                        failedCount++;
                    } else {
                        successCount++;
                    }
                } catch (err: any) {
                    console.error(`[PricingSync] Error processing price:`, err.message);
                    failedCount++;
                }
            }

            // Audit Log
            await LoggerService.logAction({
                action: 'automated_pricing_sync',
                resource: 'tld_pricing',
                status: failedCount === 0 ? 'success' : 'failure',
                payload: { success: successCount, failed: failedCount, total: regularPrices.length },
                ip_address: 'system'
            });

            console.log(`[PricingSync] Sync complete: ${successCount} success, ${failedCount} failed`);
            return { success: successCount, failed: failedCount, total: regularPrices.length };
        } catch (error: any) {
            console.error('[PricingSync] Critical sync error:', error.message);

            await LoggerService.logAction({
                action: 'automated_pricing_sync',
                resource: 'tld_pricing',
                status: 'failure',
                payload: { error: error.message },
                ip_address: 'system'
            });

            throw error;
        }
    }
}

export const pricingSyncService = new PricingSyncService();
