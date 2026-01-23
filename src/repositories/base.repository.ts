import { SupabaseClient } from '@supabase/supabase-js';

export interface PaginationOptions {
    page?: number;
    limit?: number;
    orderBy?: string;
    ascending?: boolean;
}

export interface PaginatedResult<T> {
    data: T[];
    total: number;
    page: number;
    totalPages: number;
    limit: number;
}

export interface FindOptions extends PaginationOptions {
    filters?: Record<string, any>;
    search?: {
        columns: string[];
        query: string;
    };
}

export abstract class BaseRepository<T> {
    protected tableName: string;
    protected supabase: SupabaseClient;

    constructor(supabase: SupabaseClient, tableName: string) {
        this.supabase = supabase;
        this.tableName = tableName;
    }

    async findById(id: number | string): Promise<T | null> {
        const { data, error } = await this.supabase
            .from(this.tableName)
            .select('*')
            .eq('id', id)
            .single();

        if (error || !data) {
            return null;
        }

        return data as T;
    }

    async findAll(options: FindOptions = {}): Promise<PaginatedResult<T>> {
        const {
            page = 1,
            limit = 10,
            orderBy = 'created_at',
            ascending = false,
            filters = {},
            search,
        } = options;

        let query = this.supabase
            .from(this.tableName)
            .select('*', { count: 'exact' });

        // Apply filters
        for (const [key, value] of Object.entries(filters)) {
            if (value !== undefined && value !== null) {
                query = query.eq(key, value);
            }
        }

        // Apply search
        if (search && search.query) {
            const searchConditions = search.columns
                .map(col => `${col}.ilike.%${search.query}%`)
                .join(',');
            query = query.or(searchConditions);
        }

        // Apply pagination
        const from = (page - 1) * limit;
        const to = from + limit - 1;
        query = query.range(from, to).order(orderBy, { ascending });

        const { data, error, count } = await query;

        if (error) {
            throw new Error(`Failed to fetch from ${this.tableName}: ${error.message}`);
        }

        return {
            data: (data || []) as T[],
            total: count || 0,
            page,
            totalPages: count ? Math.ceil(count / limit) : 0,
            limit,
        };
    }

    async create(data: Partial<T>): Promise<T> {
        const { data: created, error } = await this.supabase
            .from(this.tableName)
            .insert(data)
            .select()
            .single();

        if (error) {
            throw new Error(`Failed to create in ${this.tableName}: ${error.message}`);
        }

        return created as T;
    }

    async update(id: number | string, data: Partial<T>): Promise<T> {
        const { data: updated, error } = await this.supabase
            .from(this.tableName)
            .update({ ...data, updated_at: new Date().toISOString() })
            .eq('id', id)
            .select()
            .single();

        if (error) {
            throw new Error(`Failed to update in ${this.tableName}: ${error.message}`);
        }

        return updated as T;
    }

    async delete(id: number | string): Promise<boolean> {
        const { error } = await this.supabase
            .from(this.tableName)
            .delete()
            .eq('id', id);

        if (error) {
            throw new Error(`Failed to delete from ${this.tableName}: ${error.message}`);
        }

        return true;
    }

    async upsert(data: Partial<T>, conflictColumn = 'id'): Promise<T> {
        const { data: upserted, error } = await this.supabase
            .from(this.tableName)
            .upsert(data, { onConflict: conflictColumn })
            .select()
            .single();

        if (error) {
            throw new Error(`Failed to upsert in ${this.tableName}: ${error.message}`);
        }

        return upserted as T;
    }
}
