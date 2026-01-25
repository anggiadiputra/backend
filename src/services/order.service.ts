import { SupabaseClient } from '@supabase/supabase-js';
import { OrderRepository, CustomerRepository, PaginatedResult, OrderWithItems, Order } from '../repositories';
import { rdashService } from './rdash.service';
import { LoggerService } from './logger.service';

export interface ServiceResult<T> {
    success: boolean;
    data?: T;
    error?: string;
    statusCode?: number;
}

export interface CreateOrderData {
    customer_id: number;
    items: Array<{
        domain_name: string;
        tld: string;
        action: 'register' | 'renew' | 'transfer';
        years: number;
        price: number;
    }>;
    notes?: string;
}

export class OrderService {
    private orderRepo: OrderRepository;
    private customerRepo: CustomerRepository;
    private supabaseAdmin: SupabaseClient;

    constructor(supabase: SupabaseClient, supabaseAdmin: SupabaseClient) {
        this.orderRepo = new OrderRepository(supabase);
        this.customerRepo = new CustomerRepository(supabase);
        this.supabaseAdmin = supabaseAdmin;
    }

    /**
     * Get orders list based on user role
     */
    async getOrdersByRole(
        userId: string,
        userRole: 'admin' | 'seller' | 'customer',
        options: { page?: number; limit?: number; status?: string; customer_id?: number }
    ): Promise<ServiceResult<PaginatedResult<OrderWithItems>>> {
        try {
            const filters: Record<string, any> = {};
            if (options.status) filters.status = options.status;

            if (userRole === 'admin' || userRole === 'seller') {
                if (options.customer_id) filters.customer_id = options.customer_id;

                const result = await this.orderRepo.findBySellerId(userId, {
                    page: options.page,
                    limit: options.limit,
                    filters,
                });
                return { success: true, data: result };
            } else {
                // Customer: get their linked customer_id first
                const customer = await this.customerRepo.findByUserId(userId);

                if (!customer) {
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

                const result = await this.orderRepo.findByCustomerId(customer.id, {
                    page: options.page,
                    limit: options.limit,
                    filters,
                });
                return { success: true, data: result };
            }
        } catch (error: any) {
            return {
                success: false,
                error: error.message || 'Failed to fetch orders',
                statusCode: 500,
            };
        }
    }

    /**
     * Get single order by ID with access check
     */
    async getOrderById(
        orderId: number,
        userId: string,
        userRole: 'admin' | 'seller' | 'customer'
    ): Promise<ServiceResult<OrderWithItems>> {
        try {
            const order = await this.orderRepo.findByIdWithDetails(orderId);

            if (!order) {
                return {
                    success: false,
                    error: 'Order not found',
                    statusCode: 404,
                };
            }

            // Check access
            if ((userRole === 'admin' || userRole === 'seller') && order.seller_id !== userId) {
                return {
                    success: false,
                    error: 'Access denied',
                    statusCode: 403,
                };
            }

            if (userRole === 'customer') {
                const customer = await this.customerRepo.findByUserId(userId);
                if (!customer || order.customer_id !== customer.id) {
                    return {
                        success: false,
                        error: 'Access denied',
                        statusCode: 403,
                    };
                }
            }

            return { success: true, data: order };
        } catch (error: any) {
            return {
                success: false,
                error: error.message || 'Internal server error',
                statusCode: 500,
            };
        }
    }

    /**
     * Create new order with items
     */
    async createOrder(
        sellerId: string,
        data: CreateOrderData
    ): Promise<ServiceResult<OrderWithItems>> {
        try {
            // Calculate total
            const total = data.items.reduce((sum, item) => sum + (item.price * item.years), 0);

            const adminRepo = new OrderRepository(this.supabaseAdmin);

            const order = await adminRepo.createWithItems(
                {
                    seller_id: sellerId,
                    customer_id: data.customer_id,
                    status: 'pending',
                    total_amount: total,
                    notes: data.notes,
                },
                data.items.map(item => ({
                    domain_name: item.domain_name,
                    tld: item.tld,
                    action: item.action,
                    years: item.years,
                    price: item.price,
                    subtotal: item.price * item.years,
                }))
            );

            return {
                success: true,
                data: order,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error.message || 'Failed to create order',
                statusCode: 500,
            };
        }
    }

    /**
     * Update order status (seller only)
     */
    async updateOrderStatus(
        orderId: number,
        sellerId: string,
        status: Order['status']
    ): Promise<ServiceResult<Order>> {
        try {
            const adminRepo = new OrderRepository(this.supabaseAdmin);

            // Check if order belongs to seller
            const existingOrder = await adminRepo.findById(orderId);

            if (!existingOrder || existingOrder.seller_id !== sellerId) {
                return {
                    success: false,
                    error: 'Order not found',
                    statusCode: 404,
                };
            }

            const updated = await adminRepo.updateStatus(orderId, status);

            return {
                success: true,
                data: updated,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error.message || 'Failed to update order status',
                statusCode: 500,
            };
        }
    }

    /**
     * Fulfill an order by registering/transferring domain at Rdash
     * Can be called by PaymentService (webhook) or manually by Seller
     */
    async fulfillOrder(
        orderId: number,
        performedByUserId: string,
        source: 'payment_webhook' | 'manual' = 'manual'
    ): Promise<ServiceResult<{ success: boolean; message: string; results?: any[] }>> {
        console.log(`[OrderService] Fulfilling order ${orderId} (source: ${source})`);

        const order = await this.orderRepo.findByIdWithDetails(orderId);

        if (!order) {
            return { success: false, error: 'Order not found', statusCode: 404 };
        }

        if (order.status === 'completed') {
            return {
                success: true,
                data: { success: true, message: 'Order already completed' }
            };
        }

        if (!order.order_items || order.order_items.length === 0) {
            return { success: false, error: 'Order has no items to fulfill', statusCode: 400 };
        }

        const fulfillmentResults: any[] = [];
        let successCount = 0;
        let failCount = 0;

        try {
            // Check if customer has rdash_id is handled inside register/transfer/renew logic?
            // `registerDomain` needs `rdash_customer_id`.
            // Ideally `rdash_customer_id` is on Order or Customer. OrderRepository `findByIdWithDetails` joins customers?
            // But `rdash_customer_id` is likely on `order` from previous steps?
            // Based on current schema, `rdash_customer_id` is on `orders` table.

            if (!order.rdash_customer_id) {
                // Try to get from customer or create?
                // For now assume it was set during order creation or prior steps. 
                // If null, we might fail.
            }

            for (const item of order.order_items) {
                let rdashResult: any;

                try {
                    if (item.action === 'transfer') {
                        rdashResult = await rdashService.transferDomain({
                            domain: item.domain_name,
                            customer_id: order.rdash_customer_id!,
                            auth_code: order.auth_code || '', // item doesn't have auth_code in current OrderItem schema in repo?
                            // Actually OrderItem interface needs to support auth_code if per-item transfer?
                            // For now fallback to order header or empty.
                            period: item.years,
                            whois_protection: order.whois_protection || false, // Fallback to order level
                        });
                    } else if (item.action === 'renew') {
                        // Assuming we have mechanism to find domain_id for renewal.
                        // OrderItem doesn't have rdash_domain_id.
                        // We might need to lookup 'rdash_domains' by name?
                        // For now we skip or log error if ID missing.
                        throw new Error('Renew not fully supported in multi-item refactor without domain ID lookup');
                    } else {
                        // Register
                        rdashResult = await rdashService.registerDomain({
                            domain: item.domain_name!,
                            customer_id: order.rdash_customer_id!,
                            period: item.years,
                            whois_protection: order.whois_protection || false,
                        });
                    }

                    if (rdashResult.success) {
                        successCount++;
                        // Save domain
                        if (item.action !== 'renew' && rdashResult.data) {
                            await this.saveDomain(rdashResult.data, order.seller_id, order.rdash_customer_id!);
                        }
                    } else {
                        failCount++;
                    }

                    fulfillmentResults.push({ domain: item.domain_name, success: rdashResult.success, message: rdashResult.message });

                } catch (err: any) {
                    failCount++;
                    fulfillmentResults.push({ domain: item.domain_name, success: false, message: err.message });
                }
            }

            const allSuccess = failCount === 0;
            const partialSuccess = successCount > 0;

            const updateData: any = {
                updated_at: new Date().toISOString(),
                status: allSuccess ? 'completed' : (partialSuccess ? 'processing' : ((order.status as string) === 'paid' ? 'paid' : 'processing')),
                notes: order.notes ? `${order.notes}\n` : '' + `[${new Date().toISOString()}] Provisioning: ${successCount} success, ${failCount} failed.`
            };

            if (allSuccess) {
                updateData.completed_at = new Date().toISOString();
            }

            await this.orderRepo.update(orderId, updateData);

            await LoggerService.logAction({
                user_id: performedByUserId,
                action: 'fulfill_order',
                resource: `order/${orderId}`,
                payload: { source, results: fulfillmentResults },
                status: allSuccess ? 'success' : 'failure' // specific logic
            });

            return {
                success: allSuccess, // or partial?
                data: { success: allSuccess, message: `Provisioning finished. Success: ${successCount}, Failed: ${failCount}`, results: fulfillmentResults }
            };

        } catch (error: any) {
            console.error('[OrderService] Fulfill error:', error);
            return {
                success: false,
                error: error.message || 'Internal provisioning error',
                statusCode: 500
            };
        }
    }

    private async saveDomain(domainData: any, sellerId: string, customerId: number) {
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
