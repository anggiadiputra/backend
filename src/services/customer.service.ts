import { SupabaseClient } from '@supabase/supabase-js';
import { CustomerRepository, PaginatedResult } from '../repositories';
import { rdashService } from './rdash.service';
import type { Customer, RdashCustomer } from '../types';

export interface ServiceResult<T> {
    success: boolean;
    data?: T;
    error?: string;
    statusCode?: number;
}

export interface CreateCustomerData {
    name: string;
    email: string;
    organization?: string;
    street_1: string;
    city: string;
    state: string;
    country_code: string;
    postal_code: string;
    voice: string;
}

export class CustomerService {
    private customerRepo: CustomerRepository;
    private supabaseAdmin: SupabaseClient;

    constructor(supabase: SupabaseClient, supabaseAdmin: SupabaseClient) {
        this.customerRepo = new CustomerRepository(supabase);
        this.supabaseAdmin = supabaseAdmin;
    }

    /**
     * Get customer profile for a logged-in user
     * Combines local data with fresh Rdash data
     * Auto-links customer by email if not already linked
     */
    async getCustomerProfile(userId: string): Promise<ServiceResult<Customer & { rdash?: RdashCustomer; linked: boolean }>> {
        try {
            let customerLink = await this.customerRepo.findByUserId(userId);

            // If not linked, try to find and link by email
            if (!customerLink) {
                // Get user's email
                const { data: user } = await this.supabaseAdmin
                    .from('users')
                    .select('email')
                    .eq('id', userId)
                    .single();

                if (user?.email) {
                    // Find customer by email
                    const { data: customer } = await this.supabaseAdmin
                        .from('customers')
                        .select('*')
                        .ilike('email', user.email)
                        .single();

                    if (customer) {
                        // Link customer to user
                        await this.supabaseAdmin
                            .from('customers')
                            .update({ user_id: userId })
                            .eq('id', customer.id);

                        // Update user's rdash_customer_id
                        await this.supabaseAdmin
                            .from('users')
                            .update({ rdash_customer_id: customer.id.toString() })
                            .eq('id', userId);

                        customerLink = { ...customer, user_id: userId };
                        console.log(`[CustomerService] Auto-linked customer ${customer.id} to user ${userId}`);
                    }
                }
            }

            if (!customerLink) {
                return {
                    success: false,
                    error: 'Akun Anda belum terhubung dengan data customer. Silakan hubungi admin.',
                    statusCode: 404,
                };
            }

            // Fetch fresh data from Rdash
            try {
                const rdashCustomer = await rdashService.getCustomer(customerLink.id);

                if (rdashCustomer.success && rdashCustomer.data) {
                    return {
                        success: true,
                        data: {
                            ...customerLink,
                            rdash: rdashCustomer.data,
                            linked: true,
                        },
                    };
                }
            } catch {
                // Return local data if Rdash fails
            }

            return {
                success: true,
                data: { ...customerLink, linked: true },
            };
        } catch (error: any) {
            return {
                success: false,
                error: error.message || 'Internal server error',
                statusCode: 500,
            };
        }
    }

    /**
     * Create customer in Rdash and link to user
     */
    async createCustomerWithRdash(
        userId: string,
        sellerId: string,
        data: CreateCustomerData
    ): Promise<ServiceResult<{ customer_id: number }>> {
        try {
            // Check if customer already linked
            const existingLink = await this.customerRepo.findByUserId(userId);

            if (existingLink) {
                return {
                    success: false,
                    error: 'Anda sudah memiliki profil customer',
                    statusCode: 400,
                };
            }

            // Create customer in Rdash
            const rdashResponse = await rdashService.createCustomer(data);

            if (!rdashResponse.success || !rdashResponse.data?.id) {
                return {
                    success: false,
                    error: rdashResponse.message || 'Gagal membuat customer di Rdash',
                    statusCode: 400,
                };
            }

            const customerId = rdashResponse.data.id;

            // Save to local database and link to user
            const adminRepo = new CustomerRepository(this.supabaseAdmin);
            await adminRepo.create({
                id: customerId,
                seller_id: sellerId,
                user_id: userId,
                name: data.name,
                email: data.email,
                organization: data.organization || null,
                street_1: data.street_1,
                street_2: null,
                city: data.city,
                state: data.state,
                country: data.country_code === 'ID' ? 'Indonesia' : data.country_code,
                country_code: data.country_code,
                postal_code: data.postal_code,
                voice: data.voice,
                fax: null,
                is_2fa_enabled: false,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                synced_at: new Date().toISOString(),
            } as Customer);

            // Update user's rdash_customer_id
            await this.supabaseAdmin
                .from('users')
                .update({ rdash_customer_id: customerId.toString() })
                .eq('id', userId);

            return {
                success: true,
                data: { customer_id: customerId },
            };
        } catch (error: any) {
            return {
                success: false,
                error: error.message || 'Internal server error',
                statusCode: 500,
            };
        }
    }

    /**
     * Update customer profile in both Rdash and local DB
     */
    async updateCustomerProfile(
        userId: string,
        data: Partial<CreateCustomerData>
    ): Promise<ServiceResult<RdashCustomer>> {
        try {
            const customerLink = await this.customerRepo.findByUserId(userId);

            if (!customerLink) {
                return {
                    success: false,
                    error: 'Akun Anda belum terhubung dengan data customer',
                    statusCode: 404,
                };
            }

            // Update in Rdash
            const rdashResponse = await rdashService.updateCustomer(customerLink.id, data);

            if (!rdashResponse.success) {
                return {
                    success: false,
                    error: rdashResponse.message || 'Gagal update profile di Rdash',
                    statusCode: 400,
                };
            }

            // Update local database
            const adminRepo = new CustomerRepository(this.supabaseAdmin);
            await adminRepo.update(customerLink.id, {
                ...data,
                synced_at: new Date().toISOString(),
            } as Partial<Customer>);

            return {
                success: true,
                data: rdashResponse.data,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error.message || 'Internal server error',
                statusCode: 500,
            };
        }
    }

    /**
     * Get customers list for seller
     */
    async getCustomersBySeller(
        sellerId: string,
        options: { page?: number; limit?: number; search?: string }
    ): Promise<ServiceResult<PaginatedResult<Customer>>> {
        try {
            const result = await this.customerRepo.findBySellerIdWithSearch(
                sellerId,
                options.search || '',
                { page: options.page, limit: options.limit }
            );

            return { success: true, data: result };
        } catch (error: any) {
            return {
                success: false,
                error: error.message || 'Failed to fetch customers',
                statusCode: 500,
            };
        }
    }

    /**
     * Get single customer by ID (with seller access check)
     */
    async getCustomerById(
        customerId: number,
        sellerId: string
    ): Promise<ServiceResult<Customer & { domains?: any[] }>> {
        try {
            const customer = await this.customerRepo.findById(customerId);

            if (!customer || customer.seller_id !== sellerId) {
                return {
                    success: false,
                    error: 'Customer not found',
                    statusCode: 404,
                };
            }

            // Fetch customer's domains
            const { data: domains } = await this.supabaseAdmin
                .from('rdash_domains')
                .select('*')
                .eq('customer_id', customerId)
                .order('expired_at', { ascending: true });

            return {
                success: true,
                data: { ...customer, domains: domains || [] },
            };
        } catch (error: any) {
            return {
                success: false,
                error: error.message || 'Internal server error',
                statusCode: 500,
            };
        }
    }

    /**
     * Sync all customers from Rdash
     * Also auto-links customers to users based on matching email
     */
    async syncCustomersFromRdash(sellerId: string): Promise<ServiceResult<{ synced: number; failed: number; linked: number }>> {
        console.log(`[CustomerService] Starting sync for seller: ${sellerId}`);
        try {
            console.log('[CustomerService] Fetching from Rdash...');
            const rdashResponse = await rdashService.getCustomers(1, 1000);

            if (!rdashResponse.success) {
                console.error('[CustomerService] Rdash fetch failed:', rdashResponse.message);
                return {
                    success: false,
                    error: 'Failed to fetch customers from Rdash: ' + rdashResponse.message,
                    statusCode: 500,
                };
            }
            console.log(`[CustomerService] Fetched ${rdashResponse.data.length} customers from Rdash.`);

            const adminRepo = new CustomerRepository(this.supabaseAdmin);
            let successCount = 0;
            let failedCount = 0;
            let linkedCount = 0;

            for (const customer of rdashResponse.data) {
                try {
                    // Upsert customer
                    await adminRepo.upsertFromRdash(customer, sellerId);
                    successCount++;

                    // Try to auto-link to user by email
                    if (customer.email) {
                        const { data: user } = await this.supabaseAdmin
                            .from('users')
                            .select('id')
                            .eq('email', customer.email.toLowerCase())
                            .eq('role', 'customer')
                            .single();

                        if (user) {
                            // Link customer to user
                            await this.supabaseAdmin
                                .from('customers')
                                .update({ user_id: user.id })
                                .eq('id', customer.id);

                            // Update user's rdash_customer_id
                            await this.supabaseAdmin
                                .from('users')
                                .update({ rdash_customer_id: customer.id.toString() })
                                .eq('id', user.id);

                            linkedCount++;
                        }
                    }
                } catch (innerErr: any) {
                    console.error('[CustomerService] Failed to process customer:', customer.id, innerErr);
                    failedCount++;
                }
            }

            console.log(`[CustomerService] Sync complete. Success: ${successCount}, Linked: ${linkedCount}, Failed: ${failedCount}`);

            return {
                success: true,
                data: { synced: successCount, failed: failedCount, linked: linkedCount },
            };
        } catch (error: any) {
            console.error('[CustomerService] Sync CRASH:', error);
            return {
                success: false,
                error: error.message || 'Failed to sync customers',
                statusCode: 500,
            };
        }
    }

    /**
     * Sync single customer with domains from Rdash
     */
    async syncSingleCustomer(
        customerId: number,
        sellerId: string
    ): Promise<ServiceResult<{ domainsSynced: number }>> {
        try {
            const rdashResponse = await rdashService.getCustomer(customerId);

            if (!rdashResponse.success || !rdashResponse.data) {
                return {
                    success: false,
                    error: 'Customer not found in Rdash',
                    statusCode: 404,
                };
            }

            const customer = rdashResponse.data;
            const adminRepo = new CustomerRepository(this.supabaseAdmin);

            // Update customer
            await adminRepo.upsertFromRdash(customer, sellerId);

            // Sync domains if available
            let domainsSynced = 0;
            if (customer.domains && Array.isArray(customer.domains)) {
                for (const domain of customer.domains) {
                    try {
                        await this.supabaseAdmin
                            .from('rdash_domains')
                            .upsert({
                                id: domain.id,
                                seller_id: sellerId,
                                customer_id: customer.id,
                                name: domain.name,
                                status: domain.status,
                                status_label: domain.status_label,
                                expired_at: domain.expired_at,
                                nameserver_1: domain.nameserver_1,
                                nameserver_2: domain.nameserver_2,
                                nameserver_3: domain.nameserver_3,
                                nameserver_4: domain.nameserver_4,
                                nameserver_5: domain.nameserver_5,
                                is_premium: domain.is_premium,
                                is_locked: domain.is_locked,
                                rdash_created_at: domain.created_at,
                                rdash_updated_at: domain.updated_at,
                                synced_at: new Date().toISOString(),
                            }, { onConflict: 'id' });
                        domainsSynced++;
                    } catch {
                        // Continue on error
                    }
                }
            }

            return {
                success: true,
                data: { domainsSynced },
            };
        } catch (error: any) {
            return {
                success: false,
                error: error.message || 'Failed to sync customer',
                statusCode: 500,
            };
        }
    }
}
