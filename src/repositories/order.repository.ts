import { SupabaseClient } from '@supabase/supabase-js';
import { BaseRepository, FindOptions, PaginatedResult } from './base.repository';

export interface Order {
    id: number;
    seller_id: string;
    customer_id: number;
    status: 'pending' | 'processing' | 'completed' | 'cancelled' | 'refunded';
    total_amount: number;
    notes?: string;
    created_at: string;
    updated_at?: string;
}

export interface OrderItem {
    id?: number;
    order_id: number;
    domain_name: string;
    tld: string;
    action: 'register' | 'renew' | 'transfer';
    years: number;
    price: number;
    subtotal: number;
}

export interface OrderWithItems extends Order {
    order_items?: OrderItem[];
    customers?: { name: string; email: string };
}

export class OrderRepository extends BaseRepository<Order> {
    constructor(supabase: SupabaseClient) {
        super(supabase, 'orders');
    }

    async findByIdWithDetails(orderId: number): Promise<OrderWithItems | null> {
        const { data, error } = await this.supabase
            .from(this.tableName)
            .select('*, customers(name, email), order_items(*)')
            .eq('id', orderId)
            .single();

        if (error || !data) {
            return null;
        }

        return data as OrderWithItems;
    }

    async findByCustomerId(
        customerId: number,
        options: FindOptions = {}
    ): Promise<PaginatedResult<OrderWithItems>> {
        const {
            page = 1,
            limit = 10,
            filters = {},
        } = options;

        let query = this.supabase
            .from(this.tableName)
            .select('*, customers(name, email)', { count: 'exact' })
            .eq('customer_id', customerId);

        // Apply additional filters (like status)
        for (const [key, value] of Object.entries(filters)) {
            if (value !== undefined && value !== null) {
                query = query.eq(key, value);
            }
        }

        const from = (page - 1) * limit;
        const to = from + limit - 1;
        query = query.range(from, to).order('created_at', { ascending: false });

        const { data, error, count } = await query;

        if (error) {
            throw new Error(`Failed to fetch orders: ${error.message}`);
        }

        return {
            data: (data || []) as OrderWithItems[],
            total: count || 0,
            page,
            totalPages: count ? Math.ceil(count / limit) : 0,
            limit,
        };
    }

    async findBySellerId(
        sellerId: string,
        options: FindOptions = {}
    ): Promise<PaginatedResult<OrderWithItems>> {
        const {
            page = 1,
            limit = 10,
            filters = {},
        } = options;

        let query = this.supabase
            .from(this.tableName)
            .select('*, customers(name, email)', { count: 'exact' })
            .eq('seller_id', sellerId);

        // Apply additional filters
        for (const [key, value] of Object.entries(filters)) {
            if (value !== undefined && value !== null) {
                query = query.eq(key, value);
            }
        }

        const from = (page - 1) * limit;
        const to = from + limit - 1;
        query = query.range(from, to).order('created_at', { ascending: false });

        const { data, error, count } = await query;

        if (error) {
            throw new Error(`Failed to fetch orders: ${error.message}`);
        }

        return {
            data: (data || []) as OrderWithItems[],
            total: count || 0,
            page,
            totalPages: count ? Math.ceil(count / limit) : 0,
            limit,
        };
    }

    async createWithItems(
        order: Omit<Order, 'id' | 'created_at'>,
        items: Omit<OrderItem, 'id' | 'order_id'>[]
    ): Promise<OrderWithItems> {
        // Create order
        const { data: createdOrder, error: orderError } = await this.supabase
            .from(this.tableName)
            .insert({
                ...order,
                created_at: new Date().toISOString(),
            })
            .select()
            .single();

        if (orderError || !createdOrder) {
            throw new Error(`Failed to create order: ${orderError?.message}`);
        }

        // Create order items
        const orderItems = items.map(item => ({
            ...item,
            order_id: createdOrder.id,
        }));

        const { error: itemsError } = await this.supabase
            .from('order_items')
            .insert(orderItems);

        if (itemsError) {
            // Rollback order
            await this.supabase.from(this.tableName).delete().eq('id', createdOrder.id);
            throw new Error(`Failed to create order items: ${itemsError.message}`);
        }

        return createdOrder as OrderWithItems;
    }

    async updateStatus(
        orderId: number,
        status: Order['status']
    ): Promise<Order> {
        return this.update(orderId, { status } as Partial<Order>);
    }
}
