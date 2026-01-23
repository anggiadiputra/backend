import { SupabaseClient } from '@supabase/supabase-js';
import { DomainRepository, CustomerRepository, PaginatedResult } from '../repositories';
import { rdashService } from './rdash.service';
import type { Domain } from '../types';

export interface ServiceResult<T> {
    success: boolean;
    data?: T;
    error?: string;
    statusCode?: number;
}

export interface DomainAvailabilityResult {
    domain: string;
    available: boolean;
    premium: boolean;
    price?: number;
}

export class DomainService {
    private domainRepo: DomainRepository;
    private customerRepo: CustomerRepository;
    private supabaseAdmin: SupabaseClient;

    constructor(supabase: SupabaseClient, supabaseAdmin: SupabaseClient) {
        this.domainRepo = new DomainRepository(supabaseAdmin); // Use admin to bypass RLS
        this.customerRepo = new CustomerRepository(supabaseAdmin); // Use admin to bypass RLS
        this.supabaseAdmin = supabaseAdmin;
    }

    /**
     * Check domain availability via Rdash
     */
    async checkAvailability(domain: string): Promise<ServiceResult<DomainAvailabilityResult>> {
        try {
            const result = await rdashService.checkDomainAvailability(domain);

            if (!result.success) {
                return {
                    success: false,
                    error: result.message || 'Failed to check domain availability',
                    statusCode: 502,
                };
            }

            return {
                success: true,
                data: {
                    domain,
                    available: result.data?.available || false,
                    premium: result.data?.premium || false,
                    price: result.data?.price,
                },
            };
        } catch (error: any) {
            return {
                success: false,
                error: error.message || 'Failed to check domain availability',
                statusCode: 500,
            };
        }
    }

    /**
     * Get domains list based on user role
     */
    async getDomainsByRole(
        userId: string,
        userRole: 'admin' | 'seller' | 'customer',
        options: { page?: number; limit?: number; search?: string; customer_id?: number }
    ): Promise<ServiceResult<PaginatedResult<Domain>>> {
        try {
            if (userRole === 'admin' || userRole === 'seller') {
                const queryOptions: any = {
                    page: options.page,
                    limit: options.limit,
                };

                if (options.customer_id) {
                    queryOptions.filters = { customer_id: options.customer_id };
                }

                if (options.search) {
                    queryOptions.search = { columns: ['name'], query: options.search };
                }

                const result = await this.domainRepo.findBySellerId(userId, queryOptions);
                return { success: true, data: result };
            } else {
                // Customer: get their linked customer_id first
                let customer = await this.customerRepo.findByUserId(userId);
                console.log(`[DomainService] User ${userId}, found customer by user_id:`, customer?.id || 'none');

                // If not linked, try to find and link by email
                if (!customer) {
                    const { data: user } = await this.supabaseAdmin
                        .from('users')
                        .select('email')
                        .eq('id', userId)
                        .single();

                    console.log(`[DomainService] User email:`, user?.email);

                    if (user?.email) {
                        const { data: foundCustomer, error: customerError } = await this.supabaseAdmin
                            .from('customers')
                            .select('*')
                            .ilike('email', user.email)
                            .single();

                        console.log(`[DomainService] Found customer by email:`, foundCustomer?.id || 'none', customerError?.message || '');

                        if (foundCustomer) {
                            // Link customer to user
                            const { error: linkError1 } = await this.supabaseAdmin
                                .from('customers')
                                .update({ user_id: userId })
                                .eq('id', foundCustomer.id);

                            const { error: linkError2 } = await this.supabaseAdmin
                                .from('users')
                                .update({ rdash_customer_id: foundCustomer.id.toString() })
                                .eq('id', userId);

                            console.log(`[DomainService] Link errors:`, linkError1?.message, linkError2?.message);

                            customer = foundCustomer;
                            console.log(`[DomainService] Auto-linked customer ${foundCustomer.id} to user ${userId}`);
                        }
                    }
                }

                if (!customer) {
                    console.log(`[DomainService] No customer found for user ${userId}`);
                    return {
                        success: true,
                        data: {
                            data: [],
                            total: 0,
                            page: options.page || 1,
                            totalPages: 0,
                            limit: options.limit || 10,
                        },
                    };
                }

                console.log(`[DomainService] Fetching domains for customer ${customer.id}`);
                const result = await this.domainRepo.findByCustomerId(customer.id, {
                    page: options.page,
                    limit: options.limit,
                    search: options.search ? { columns: ['name'], query: options.search } : undefined,
                });
                console.log(`[DomainService] Found ${result.total} domains`);
                return { success: true, data: result };
            }
        } catch (error: any) {
            return {
                success: false,
                error: error.message || 'Failed to fetch domains',
                statusCode: 500,
            };
        }
    }

    /**
     * Get single domain by ID with access check
     */
    async getDomainById(
        domainId: number,
        userId: string,
        userRole: 'admin' | 'seller' | 'customer'
    ): Promise<ServiceResult<Domain>> {
        try {
            const domain = await this.domainRepo.findById(domainId);

            if (!domain) {
                return {
                    success: false,
                    error: 'Domain not found',
                    statusCode: 404,
                };
            }

            // Check access
            if ((userRole === 'admin' || userRole === 'seller') && domain.seller_id !== userId) {
                return {
                    success: false,
                    error: 'Access denied',
                    statusCode: 403,
                };
            }

            if (userRole === 'customer') {
                const customer = await this.customerRepo.findByUserId(userId);
                if (!customer || domain.customer_id !== customer.id) {
                    return {
                        success: false,
                        error: 'Access denied',
                        statusCode: 403,
                    };
                }
            }

            return { success: true, data: domain };
        } catch (error: any) {
            return {
                success: false,
                error: error.message || 'Internal server error',
                statusCode: 500,
            };
        }
    }

    /**
     * Get full domain details from Rdash
     */
    async getDomainDetails(
        domainId: number,
        userId: string,
        userRole: 'admin' | 'seller' | 'customer'
    ): Promise<ServiceResult<{ data: any; source: string }>> {
        try {
            // First verify access
            const accessCheck = await this.getDomainById(domainId, userId, userRole);
            if (!accessCheck.success || !accessCheck.data) {
                return {
                    success: false,
                    error: accessCheck.error,
                    statusCode: accessCheck.statusCode,
                };
            }

            const localDomain = accessCheck.data;

            // Get full details from Rdash using domain ID
            const rdashResponse = await rdashService.getDomain(localDomain.id);

            if (!rdashResponse.success) {
                return {
                    success: true,
                    data: { data: localDomain, source: 'local' },
                };
            }

            return {
                success: true,
                data: { data: rdashResponse.data, source: 'rdash' },
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
     * Sync all domains from Rdash (for seller/admin)
     * Fetches all customers first, then syncs domains per customer
     */
    async syncDomainsFromRdash(sellerId: string): Promise<ServiceResult<{ synced: number; failed: number }>> {
        try {
            // Get all customers for this seller
            const { data: customers, error: customersError } = await this.supabaseAdmin
                .from('customers')
                .select('id')
                .eq('seller_id', sellerId);

            if (customersError) {
                return {
                    success: false,
                    error: 'Failed to fetch customers',
                    statusCode: 500,
                };
            }

            let totalSuccess = 0;
            let totalFailed = 0;

            // Sync domains for each customer
            for (const customer of customers || []) {
                try {
                    const rdashResponse = await rdashService.getDomains(1, 100, customer.id);

                    if (rdashResponse.data && rdashResponse.data.length > 0) {
                        for (const domain of rdashResponse.data) {
                            try {
                                const domainData = {
                                    id: domain.id,
                                    seller_id: sellerId,
                                    customer_id: customer.id,
                                    name: domain.name,
                                    status: domain.status,
                                    status_label: domain.status_label,
                                    is_premium: domain.is_premium,
                                    is_locked: domain.is_locked,
                                    nameserver_1: domain.nameserver_1,
                                    nameserver_2: domain.nameserver_2,
                                    nameserver_3: domain.nameserver_3,
                                    nameserver_4: domain.nameserver_4,
                                    nameserver_5: domain.nameserver_5,
                                    expired_at: domain.expired_at,
                                    rdash_created_at: domain.created_at,
                                    rdash_updated_at: domain.updated_at,
                                    synced_at: new Date().toISOString(),
                                };

                                const { error } = await this.supabaseAdmin
                                    .from('rdash_domains')
                                    .upsert(domainData, { onConflict: 'id' });

                                if (error) {
                                    console.error(`[DomainService] Failed to upsert domain ${domain.name}:`, error.message);
                                    totalFailed++;
                                } else {
                                    totalSuccess++;
                                }
                            } catch {
                                totalFailed++;
                            }
                        }
                    }
                } catch (err) {
                    console.error(`[DomainService] Error syncing domains for customer ${customer.id}:`, err);
                }
            }

            return {
                success: true,
                data: { synced: totalSuccess, failed: totalFailed },
            };
        } catch (error: any) {
            return {
                success: false,
                error: error.message || 'Failed to sync domains',
                statusCode: 500,
            };
        }
    }

    /**
     * Sync customer domains from Rdash
     */
    async syncCustomerDomainsFromRdash(userId: string): Promise<ServiceResult<{ synced: number; failed: number }>> {
        try {
            // Find customer by user_id
            const customer = await this.customerRepo.findByUserId(userId);

            if (!customer) {
                return {
                    success: false,
                    error: 'Customer not found. Please contact your domain provider.',
                    statusCode: 404,
                };
            }

            const rdashCustomerId = customer.id;
            const sellerId = customer.seller_id;

            console.log(`[DomainService] Syncing domains for customer ${rdashCustomerId}`);

            // Fetch domains from Rdash filtered by customer_id
            const rdashResponse = await rdashService.getDomains(1, 100, rdashCustomerId);

            if (!rdashResponse.data) {
                return {
                    success: false,
                    error: 'Failed to fetch domains from Rdash',
                    statusCode: 500,
                };
            }

            console.log(`[DomainService] Found ${rdashResponse.data.length} domains from Rdash`);

            let successCount = 0;
            let failedCount = 0;

            for (const domain of rdashResponse.data) {
                try {
                    // Use admin client to bypass RLS
                    const domainData = {
                        id: domain.id,
                        seller_id: sellerId,
                        customer_id: rdashCustomerId,
                        name: domain.name,
                        status: domain.status,
                        status_label: domain.status_label,
                        is_premium: domain.is_premium,
                        is_locked: domain.is_locked,
                        nameserver_1: domain.nameserver_1,
                        nameserver_2: domain.nameserver_2,
                        nameserver_3: domain.nameserver_3,
                        nameserver_4: domain.nameserver_4,
                        nameserver_5: domain.nameserver_5,
                        expired_at: domain.expired_at,
                        rdash_created_at: domain.created_at,
                        rdash_updated_at: domain.updated_at,
                        synced_at: new Date().toISOString(),
                    };

                    const { error } = await this.supabaseAdmin
                        .from('rdash_domains')
                        .upsert(domainData, { onConflict: 'id' });

                    if (error) {
                        console.error(`[DomainService] Failed to upsert domain ${domain.name}:`, error.message);
                        failedCount++;
                    } else {
                        console.log(`[DomainService] Synced domain ${domain.name}`);
                        successCount++;
                    }
                } catch (err) {
                    console.error(`[DomainService] Error syncing domain ${domain.name}:`, err);
                    failedCount++;
                }
            }

            return {
                success: true,
                data: { synced: successCount, failed: failedCount },
            };
        } catch (error: any) {
            console.error('[DomainService] syncCustomerDomainsFromRdash error:', error);
            return {
                success: false,
                error: error.message || 'Failed to sync domains',
                statusCode: 500,
            };
        }
    }

    /**
     * Get expiring domains for notifications
     */
    async getExpiringDomains(sellerId: string, daysAhead: number = 30): Promise<ServiceResult<Domain[]>> {
        try {
            const adminRepo = new DomainRepository(this.supabaseAdmin);
            const domains = await adminRepo.getExpiringDomains(sellerId, daysAhead);

            return { success: true, data: domains };
        } catch (error: any) {
            return {
                success: false,
                error: error.message || 'Failed to fetch expiring domains',
                statusCode: 500,
            };
        }
    }
}
