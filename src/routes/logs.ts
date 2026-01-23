import { Hono } from 'hono';
import { supabaseAdmin } from '../services/supabase.service';
import { authMiddleware, adminOnly } from '../middleware/auth';

const logs = new Hono();

// Apply auth and admin check to all log routes
logs.use('*', authMiddleware, adminOnly);

/**
 * GET /api/logs
 * Fetch audit logs with pagination and filters
 */
logs.get('/', async (c) => {
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '50');
    const action = c.req.query('action');
    const status = c.req.query('status');
    const search = c.req.query('search');

    try {
        let query = supabaseAdmin
            .from('audit_logs')
            .select(`
                *,
                users (
                    email,
                    role
                )
            `, { count: 'exact' });

        if (action) {
            query = query.eq('action', action);
        }

        if (status) {
            query = query.eq('status', status);
        }

        if (search) {
            query = query.or(`ip_address.ilike.%${search}%,action.ilike.%${search}%,resource.ilike.%${search}%`);
        }

        const from = (page - 1) * limit;
        const to = from + limit - 1;

        const { data, error, count } = await query
            .order('created_at', { ascending: false })
            .range(from, to);

        if (error) {
            console.error('[LogsRoute] Supabase Error:', error.message);
            return c.json({ success: false, error: 'Failed to fetch logs' }, 500);
        }

        return c.json({
            success: true,
            data,
            meta: {
                total: count || 0,
                page,
                limit,
                total_pages: Math.ceil((count || 0) / limit)
            }
        });
    } catch (error: any) {
        console.error('[LogsRoute] Error:', error.message);
        return c.json({ success: false, error: 'Internal server error' }, 500);
    }
});

export default logs;
