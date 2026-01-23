import { SupabaseClient } from '@supabase/supabase-js';
import { BaseRepository, FindOptions, PaginatedResult } from './base.repository';
import type { Domain, RdashDomain } from '../types';

export interface DomainFilters {
    seller_id?: string;
    customer_id?: number;
    status?: string;
}

export class DomainRepository extends BaseRepository<Domain> {
    constructor(supabase: SupabaseClient) {
        super(supabase, 'rdash_domains');
    }

    async findByCustomerId(
        customerId: number,
        options: FindOptions = {}
    ): Promise<PaginatedResult<Domain>> {
        return this.findAll({
            ...options,
            filters: { ...options.filters, customer_id: customerId },
            orderBy: 'expired_at',
            ascending: true,
        });
    }

    async findBySellerId(
        sellerId: string,
        options: FindOptions = {}
    ): Promise<PaginatedResult<Domain>> {
        return this.findAll({
            ...options,
            filters: { ...options.filters, seller_id: sellerId },
            orderBy: 'expired_at',
            ascending: true,
        });
    }

    async findBySellerIdWithSearch(
        sellerId: string,
        searchQuery: string,
        options: FindOptions = {}
    ): Promise<PaginatedResult<Domain>> {
        const queryOptions: FindOptions = {
            ...options,
            filters: { ...options.filters, seller_id: sellerId },
            orderBy: 'expired_at',
            ascending: true,
        };

        if (searchQuery) {
            queryOptions.search = { columns: ['name'], query: searchQuery };
        }

        return this.findAll(queryOptions);
    }

    async upsertFromRdash(
        domain: RdashDomain,
        sellerId: string,
        customerId?: number
    ): Promise<Domain> {
        const data = {
            id: domain.id,
            seller_id: sellerId,
            customer_id: customerId,
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
        };

        return this.upsert(data);
    }

    async getExpiringDomains(sellerId: string, daysAhead: number = 30): Promise<Domain[]> {
        const futureDate = new Date();
        futureDate.setDate(futureDate.getDate() + daysAhead);

        const { data, error } = await this.supabase
            .from(this.tableName)
            .select('*')
            .eq('seller_id', sellerId)
            .lte('expired_at', futureDate.toISOString())
            .gte('expired_at', new Date().toISOString())
            .order('expired_at', { ascending: true });

        if (error) {
            throw new Error(`Failed to fetch expiring domains: ${error.message}`);
        }

        return (data || []) as Domain[];
    }
}
