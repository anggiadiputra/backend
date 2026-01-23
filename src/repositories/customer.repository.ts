import { SupabaseClient } from '@supabase/supabase-js';
import { BaseRepository, FindOptions, PaginatedResult } from './base.repository';
import type { Customer, RdashCustomer } from '../types';

export interface CustomerFilters {
    seller_id?: string;
    user_id?: string;
}

export class CustomerRepository extends BaseRepository<Customer> {
    constructor(supabase: SupabaseClient) {
        super(supabase, 'customers');
    }

    async findByUserId(userId: string): Promise<Customer | null> {
        const { data, error } = await this.supabase
            .from(this.tableName)
            .select('*')
            .eq('user_id', userId)
            .single();

        if (error || !data) {
            return null;
        }

        return data as Customer;
    }

    async findBySellerId(
        sellerId: string,
        options: FindOptions = {}
    ): Promise<PaginatedResult<Customer>> {
        return this.findAll({
            ...options,
            filters: { ...options.filters, seller_id: sellerId },
        });
    }

    async findBySellerIdWithSearch(
        sellerId: string,
        searchQuery: string,
        options: FindOptions = {}
    ): Promise<PaginatedResult<Customer>> {
        return this.findAll({
            ...options,
            filters: { ...options.filters, seller_id: sellerId },
            search: searchQuery ? { columns: ['name', 'email'], query: searchQuery } : undefined,
        });
    }

    async upsertFromRdash(customer: RdashCustomer, sellerId: string): Promise<Customer> {
        const data = {
            id: customer.id,
            seller_id: sellerId,
            name: customer.name,
            email: customer.email,
            organization: customer.organization,
            street_1: customer.street_1,
            street_2: customer.street_2,
            city: customer.city,
            state: customer.state,
            country: customer.country,
            country_code: customer.country_code,
            postal_code: customer.postal_code,
            voice: customer.voice,
            fax: customer.fax,
            is_2fa_enabled: customer.is_2fa_enabled,
            rdash_created_at: customer.created_at,
            rdash_updated_at: customer.updated_at,
            synced_at: new Date().toISOString(),
        };

        return this.upsert(data);
    }

    async linkToUser(customerId: number, userId: string): Promise<Customer> {
        return this.update(customerId, { user_id: userId } as Partial<Customer>);
    }
}
