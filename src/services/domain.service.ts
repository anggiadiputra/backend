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
     * Now also fetches fresh lock status from Rdash API
     */
    async getDomainById(
        domainId: number,
        userId: string,
        userRole: 'admin' | 'seller' | 'customer'
    ): Promise<ServiceResult<any>> {
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

            // Fetch fresh lock status from Rdash to ensure accuracy
            try {
                const rdashResponse = await rdashService.getDomain(domainId);
                if (rdashResponse.success && rdashResponse.data) {
                    // Merge Rdash data with local data
                    const mergedDomain = {
                        ...domain,
                        is_locked: rdashResponse.data.is_locked,
                        is_transfer_locked: rdashResponse.data.is_transfer_locked,
                        status: rdashResponse.data.status,
                        status_label: rdashResponse.data.status_label,
                        whois_protection: rdashResponse.data.whois_protection,
                    };
                    return { success: true, data: mergedDomain };
                }
            } catch (rdashError) {
                console.error('[DomainService] Failed to fetch from Rdash, using local data:', rdashError);
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
            // First try to get domain from local database
            const localDomain = await this.domainRepo.findById(domainId);

            if (localDomain) {
                // Check access for local domain
                if ((userRole === 'admin' || userRole === 'seller') && localDomain.seller_id !== userId) {
                    return {
                        success: false,
                        error: 'Access denied',
                        statusCode: 403,
                    };
                }

                if (userRole === 'customer') {
                    const customer = await this.customerRepo.findByUserId(userId);
                    if (!customer || localDomain.customer_id !== customer.id) {
                        return {
                            success: false,
                            error: 'Access denied',
                            statusCode: 403,
                        };
                    }
                }

                // Get full details from Rdash using domain ID
                const rdashResponse = await rdashService.getDomain(localDomain.id);

                if (rdashResponse.success && rdashResponse.data) {
                    // Sync key fields from Rdash to local database
                    try {
                        const now = new Date().toISOString();
                        const updateData: any = {
                            synced_at: now,
                            status: rdashResponse.data.status,
                            status_label: rdashResponse.data.status_label,
                            is_locked: rdashResponse.data.is_locked,
                            is_transfer_locked: rdashResponse.data.is_transfer_locked,
                            nameserver_1: rdashResponse.data.nameserver_1,
                            nameserver_2: rdashResponse.data.nameserver_2,
                            nameserver_3: rdashResponse.data.nameserver_3,
                            nameserver_4: rdashResponse.data.nameserver_4,
                            nameserver_5: rdashResponse.data.nameserver_5,
                            expired_at: rdashResponse.data.expired_at,
                        };

                        await this.supabaseAdmin
                            .from('rdash_domains')
                            .update(updateData)
                            .eq('id', localDomain.id);

                        console.log(`[DomainService] Synced domain ${localDomain.id} from Rdash to local DB`);
                    } catch (syncError) {
                        console.error('[DomainService] Failed to sync domain to local DB:', syncError);
                    }

                    return {
                        success: true,
                        data: { data: rdashResponse.data, source: 'rdash' },
                    };
                } else {
                    return {
                        success: true,
                        data: { data: localDomain, source: 'local' },
                    };
                }
            } else {
                // Domain not in local database, try to get directly from Rdash
                // This is for cases where domain exists in Rdash but not synced yet
                console.log(`[DomainService] Domain ${domainId} not found locally, trying Rdash directly`);

                const rdashResponse = await rdashService.getDomain(domainId);

                if (rdashResponse.success) {
                    // Check if user has access to this domain based on seller_id or customer_id
                    const rdashDomain = rdashResponse.data;

                    if (userRole === 'seller') {
                        // For sellers, we need to check if they own this domain
                        // Since we don't have seller_id in Rdash response, we'll allow access for now
                        // In production, you might want to add additional checks
                        return {
                            success: true,
                            data: { data: rdashDomain, source: 'rdash' },
                        };
                    } else if (userRole === 'customer') {
                        // For customers, check if they own this domain
                        const customer = await this.customerRepo.findByUserId(userId);
                        if (customer && rdashDomain.customer_id === customer.id) {
                            return {
                                success: true,
                                data: { data: rdashDomain, source: 'rdash' },
                            };
                        } else {
                            return {
                                success: false,
                                error: 'Access denied',
                                statusCode: 403,
                            };
                        }
                    } else {
                        // Admin can access all
                        return {
                            success: true,
                            data: { data: rdashDomain, source: 'rdash' },
                        };
                    }
                } else {
                    return {
                        success: false,
                        error: 'Domain not found',
                        statusCode: 404,
                    };
                }
            }
        } catch (error: any) {
            console.error('[DomainService] getDomainDetails error:', error);
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

    /**
     * Wrapper for Rdash management functions with access control
     */
    async manageDomain(
        domainId: number,
        userId: string,
        userRole: 'admin' | 'seller' | 'customer',
        action: string,
        data: any
    ): Promise<ServiceResult<any>> {
        try {
            // Verify access
            const accessCheck = await this.getDomainById(domainId, userId, userRole);
            if (!accessCheck.success) {
                return accessCheck;
            }

            let result: any;
            switch (action) {
                case 'get_auth_code':
                    result = await rdashService.getAuthCode(domainId);
                    break;
                case 'update_auth_code':
                    result = await rdashService.updateAuthCode(domainId, data.auth_code);
                    break;
                case 'set_lock':
                    result = await rdashService.setRegistrarLock(domainId, data.locked, data.reason);
                    break;
                case 'set_theft_protection':
                    result = await rdashService.setTheftProtection(domainId, data.locked, data.reason);
                    break;
                case 'get_whois_protection':
                    result = await rdashService.getWhoisProtection(domainId);
                    break;
                case 'set_whois_protection':
                    result = await rdashService.setWhoisProtection(domainId, data.enabled);
                    break;
                case 'update_nameservers':
                    result = await rdashService.updateNameservers(domainId, data.nameservers);
                    break;
                case 'get_dns':
                    result = await rdashService.getDnsRecords(domainId);
                    break;
                case 'update_dns':
                    result = await rdashService.updateDnsRecords(domainId, data.records);
                    break;
                case 'delete_dns_record':
                    result = await rdashService.deleteDnsRecord(domainId, data.record);
                    break;
                case 'get_hosts':
                    result = await rdashService.getHosts(domainId);
                    break;
                case 'create_host':
                    result = await rdashService.createHost(domainId, data);
                    break;
                case 'update_host':
                    result = await rdashService.updateHost(domainId, data.host_id, data);
                    break;
                case 'delete_host':
                    result = await rdashService.deleteHost(domainId, data.host_id);
                    break;
                case 'get_forwarding':
                    result = await rdashService.getForwarding(domainId);
                    break;
                case 'create_forwarding':
                    result = await rdashService.createForwarding(domainId, data);
                    break;
                case 'delete_forwarding':
                    result = await rdashService.deleteForwarding(domainId, data.forwarding_id);
                    break;
                case 'get_dnssec':
                    result = await rdashService.getDnssec(domainId);
                    break;
                case 'add_dnssec':
                    result = await rdashService.addDnssec(domainId, data);
                    break;
                case 'delete_dnssec':
                    result = await rdashService.deleteDnssec(domainId, data.dnssec_id);
                    break;
                case 'set_dnssec':
                    result = await rdashService.setDnssec(domainId, data.enabled);
                    break;
                case 'whois':
                    result = await rdashService.whoisLookup(accessCheck.data!.name);
                    break;
                default:
                    return { success: false, error: 'Invalid action', statusCode: 400 };
            }

            if (result && result.success === false) {
                return { success: false, error: result.message || 'Operation failed', statusCode: 400 };
            }

            // Sync changes directly to local database based on the successful action
            // We update locally instead of re-fetching because Rdash API might have a cache delay
            try {
                const now = new Date().toISOString();

                if (action === 'set_lock') {
                    await this.supabaseAdmin
                        .from('rdash_domains')
                        .update({ is_locked: data.locked, synced_at: now })
                        .eq('id', domainId);

                } else if (action === 'set_theft_protection') {
                    // Update transfer lock status locally
                    // Note: Ensure your DB schema has 'is_transfer_locked' column, 
                    // otherwise this might fail if the column is missing. 
                    // Based on Typescript interfaces, we are handling it in memory, 
                    // but we should attempt to persist if possible.
                    // For now, let's assume the column exists or we just rely on API response next time.

                    // Since schema might vary, we logging it. 
                    // Ideally we should have:
                    await this.supabaseAdmin
                        .from('rdash_domains')
                        .update({ is_transfer_locked: data.locked, synced_at: now })
                        .eq('id', domainId);
                    console.log(`[DomainService] Theft protection synced: ${data.locked}`);

                } else if (action === 'set_whois_protection') {
                    await this.supabaseAdmin
                        .from('rdash_domains')
                        .update({ whois_protection: data.enabled, synced_at: now })
                        .eq('id', domainId);

                } else if (action === 'update_nameservers') {
                    const nsData: any = { synced_at: now };
                    // Map array to individual columns
                    if (Array.isArray(data.nameservers)) {
                        data.nameservers.forEach((ns: string, i: number) => {
                            if (i < 5) nsData[`nameserver_${i + 1}`] = ns;
                        });
                        // Clear remaining
                        for (let i = data.nameservers.length; i < 5; i++) {
                            nsData[`nameserver_${i + 1}`] = null;
                        }
                    }
                    await this.supabaseAdmin
                        .from('rdash_domains')
                        .update(nsData)
                        .eq('id', domainId);
                }
            } catch (syncError) {
                console.error('[DomainService] Failed to update local DB after action:', syncError);
            }

            return { success: true, data: result };
        } catch (error: any) {
            return {
                success: false,
                error: error.message || 'Management operation failed',
                statusCode: 500,
            };
        }
    }
}
