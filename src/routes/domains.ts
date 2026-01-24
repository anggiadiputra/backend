import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { authMiddleware, sellerOnly } from '../middleware/auth';
import { createAuthClient, supabaseAdmin } from '../services/supabase.service';
import { DomainService } from '../services/domain.service';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

const domains = new Hono();

// Helper to convert status code
const toStatusCode = (code: number): ContentfulStatusCode => code as ContentfulStatusCode;

// Check domain availability (public - no auth required)
domains.get('/check', async (c) => {
  const domain = c.req.query('domain');

  if (!domain) {
    return c.json({ success: false, error: 'Domain parameter is required' }, 400);
  }

  const domainService = new DomainService(supabaseAdmin, supabaseAdmin);
  const result = await domainService.checkAvailability(domain);

  if (!result.success) {
    return c.json({
      success: false,
      error: result.error,
    }, toStatusCode(result.statusCode || 500));
  }

  return c.json({
    success: true,
    domain: result.data?.domain,
    available: result.data?.available,
    premium: result.data?.premium,
    price: result.data?.price,
  });
});

// Apply auth middleware to all other routes
domains.use('*', authMiddleware);

// Get domains list
const listDomainsSchema = z.object({
  page: z.string().optional().default('1'),
  limit: z.string().optional().default('10'),
  search: z.string().optional(),
  customer_id: z.string().optional(),
});

domains.get('/', zValidator('query', listDomainsSchema), async (c) => {
  const user = c.get('user');
  const token = c.get('token');
  const { page, limit, search, customer_id } = c.req.valid('query');

  const supabase = createAuthClient(token);
  const domainService = new DomainService(supabase, supabaseAdmin);

  const result = await domainService.getDomainsByRole(user.id, user.role, {
    page: parseInt(page),
    limit: parseInt(limit),
    search,
    customer_id: customer_id ? parseInt(customer_id) : undefined,
  });

  if (!result.success) {
    return c.json({ success: false, error: result.error }, toStatusCode(result.statusCode || 500));
  }

  return c.json({
    success: true,
    data: result.data?.data || [],
    total: result.data?.total || 0,
    page: result.data?.page || 1,
    totalPages: result.data?.totalPages || 0,
    limit: result.data?.limit || 10,
  });
});

// Get domain detail
domains.get('/:id', async (c) => {
  const user = c.get('user');
  const token = c.get('token');
  const domainId = c.req.param('id');

  const supabase = createAuthClient(token);
  const domainService = new DomainService(supabase, supabaseAdmin);

  const result = await domainService.getDomainById(parseInt(domainId), user.id, user.role);

  if (!result.success) {
    return c.json({ success: false, error: result.error }, toStatusCode(result.statusCode || 500));
  }

  return c.json({ success: true, data: result.data });
});

// Get domain full details from Rdash
domains.get('/:id/details', async (c) => {
  const user = c.get('user');
  const token = c.get('token');
  const domainId = c.req.param('id');

  const supabase = createAuthClient(token);
  const domainService = new DomainService(supabase, supabaseAdmin);

  const result = await domainService.getDomainDetails(parseInt(domainId), user.id, user.role);

  if (!result.success) {
    return c.json({ success: false, error: result.error }, toStatusCode(result.statusCode || 500));
  }

  return c.json({
    success: true,
    data: {
      data: result.data?.data,
      source: result.data?.source,
    }
  });
});

// Sync domains from Rdash (seller only)
domains.post('/sync', sellerOnly, async (c) => {
  const user = c.get('user');
  const token = c.get('token');

  const supabase = createAuthClient(token);
  const domainService = new DomainService(supabase, supabaseAdmin);

  const result = await domainService.syncDomainsFromRdash(user.id);

  if (!result.success) {
    return c.json({ success: false, error: result.error }, toStatusCode(result.statusCode || 500));
  }

  return c.json({
    success: true,
    message: `Sync complete: ${result.data?.synced} success, ${result.data?.failed} failed`,
    synced: result.data?.synced,
    failed: result.data?.failed,
  });
});

// Sync customer domains from Rdash (for customers)
domains.post('/sync-customer', async (c) => {
  const user = c.get('user');

  // Only customers can use this endpoint
  if (user.role !== 'customer') {
    return c.json({ success: false, error: 'Only customers can use this endpoint' }, 403);
  }

  const domainService = new DomainService(supabaseAdmin, supabaseAdmin);
  const result = await domainService.syncCustomerDomainsFromRdash(user.id);

  if (!result.success) {
    return c.json({ success: false, error: result.error }, toStatusCode(result.statusCode || 500));
  }

  return c.json({
    success: true,
    message: `Sync complete: ${result.data?.synced} success, ${result.data?.failed} failed`,
    synced: result.data?.synced,
    failed: result.data?.failed,
  });
});

// Management sub-routes using the generic manageDomain helper
domains.get('/:id/auth_code', async (c) => {
  const user = c.get('user');
  const token = c.get('token');
  const domainId = c.req.param('id');
  const domainService = new DomainService(createAuthClient(token), supabaseAdmin);
  const result = await domainService.manageDomain(parseInt(domainId), user.id, user.role, 'get_auth_code', {});
  return c.json(result, toStatusCode(result.statusCode || (result.success ? 200 : 400)));
});

domains.put('/:id/auth_code', async (c) => {
  const user = c.get('user');
  const token = c.get('token');
  const domainId = c.req.param('id');
  const body = await c.req.json();
  const domainService = new DomainService(createAuthClient(token), supabaseAdmin);
  const result = await domainService.manageDomain(parseInt(domainId), user.id, user.role, 'update_auth_code', body);
  return c.json(result, toStatusCode(result.statusCode || (result.success ? 200 : 400)));
});

domains.get('/:id/nameservers', async (c) => {
  const user = c.get('user');
  const token = c.get('token');
  const domainId = c.req.param('id');
  const domainService = new DomainService(createAuthClient(token), supabaseAdmin);
  // Nameservers are part of domain details
  const result = await domainService.getDomainDetails(parseInt(domainId), user.id, user.role);
  if (!result.success) return c.json(result, toStatusCode(result.statusCode || 400));

  const d = result.data?.data;
  const nameservers = [d.nameserver_1, d.nameserver_2, d.nameserver_3, d.nameserver_4, d.nameserver_5].filter(Boolean);
  return c.json({ success: true, data: nameservers });
});

domains.put('/:id/nameservers', async (c) => {
  const user = c.get('user');
  const token = c.get('token');
  const domainId = c.req.param('id');
  const body = await c.req.json();
  const domainService = new DomainService(createAuthClient(token), supabaseAdmin);
  const result = await domainService.manageDomain(parseInt(domainId), user.id, user.role, 'update_nameservers', body);
  return c.json(result, toStatusCode(result.statusCode || (result.success ? 200 : 400)));
});

domains.get('/:id/dns', async (c) => {
  const user = c.get('user');
  const token = c.get('token');
  const domainId = c.req.param('id');
  const domainService = new DomainService(createAuthClient(token), supabaseAdmin);
  const result = await domainService.manageDomain(parseInt(domainId), user.id, user.role, 'get_dns', {});
  return c.json(result, toStatusCode(result.statusCode || (result.success ? 200 : 400)));
});

domains.post('/:id/dns', async (c) => {
  const user = c.get('user');
  const token = c.get('token');
  const domainId = c.req.param('id');
  const body = await c.req.json();
  const domainService = new DomainService(createAuthClient(token), supabaseAdmin);
  const result = await domainService.manageDomain(parseInt(domainId), user.id, user.role, 'update_dns', body);
  return c.json(result, toStatusCode(result.statusCode || (result.success ? 200 : 400)));
});

domains.delete('/:id/dns', async (c) => {
  const user = c.get('user');
  const token = c.get('token');
  const domainId = c.req.param('id');
  const body = await c.req.json();
  const domainService = new DomainService(createAuthClient(token), supabaseAdmin);
  const result = await domainService.manageDomain(parseInt(domainId), user.id, user.role, 'delete_dns_record', body);
  return c.json(result, toStatusCode(result.statusCode || (result.success ? 200 : 400)));
});

domains.get('/:id/hosts', async (c) => {
  const user = c.get('user');
  const token = c.get('token');
  const domainId = c.req.param('id');
  const domainService = new DomainService(createAuthClient(token), supabaseAdmin);
  const result = await domainService.manageDomain(parseInt(domainId), user.id, user.role, 'get_hosts', {});
  return c.json(result, toStatusCode(result.statusCode || (result.success ? 200 : 400)));
});

domains.post('/:id/hosts', async (c) => {
  const user = c.get('user');
  const token = c.get('token');
  const domainId = c.req.param('id');
  const body = await c.req.json();
  const domainService = new DomainService(createAuthClient(token), supabaseAdmin);
  const result = await domainService.manageDomain(parseInt(domainId), user.id, user.role, 'create_host', body);
  return c.json(result, toStatusCode(result.statusCode || (result.success ? 200 : 400)));
});

domains.get('/:id/forwarding', async (c) => {
  const user = c.get('user');
  const token = c.get('token');
  const domainId = c.req.param('id');
  const domainService = new DomainService(createAuthClient(token), supabaseAdmin);
  const result = await domainService.manageDomain(parseInt(domainId), user.id, user.role, 'get_forwarding', {});
  return c.json(result, toStatusCode(result.statusCode || (result.success ? 200 : 400)));
});

domains.post('/:id/forwarding', async (c) => {
  const user = c.get('user');
  const token = c.get('token');
  const domainId = c.req.param('id');
  const body = await c.req.json();
  const domainService = new DomainService(createAuthClient(token), supabaseAdmin);
  const result = await domainService.manageDomain(parseInt(domainId), user.id, user.role, 'create_forwarding', body);
  return c.json(result, toStatusCode(result.statusCode || (result.success ? 200 : 400)));
});

domains.get('/:id/whois', async (c) => {
  const user = c.get('user');
  const token = c.get('token');
  const domainId = c.req.param('id');
  const domainService = new DomainService(createAuthClient(token), supabaseAdmin);
  const result = await domainService.manageDomain(parseInt(domainId), user.id, user.role, 'whois', {});
  return c.json(result, toStatusCode(result.statusCode || (result.success ? 200 : 400)));
});

domains.put('/:id/lock', async (c) => {
  const user = c.get('user');
  const token = c.get('token');
  const domainId = c.req.param('id');
  const body = await c.req.json();
  const domainService = new DomainService(createAuthClient(token), supabaseAdmin);
  const result = await domainService.manageDomain(parseInt(domainId), user.id, user.role, 'set_lock', body);
  return c.json(result, toStatusCode(result.statusCode || (result.success ? 200 : 400)));
});

domains.put('/:id/theft-protection', async (c) => {
  const user = c.get('user');
  const token = c.get('token');
  const domainId = c.req.param('id');
  const body = await c.req.json();
  const domainService = new DomainService(createAuthClient(token), supabaseAdmin);
  const result = await domainService.manageDomain(parseInt(domainId), user.id, user.role, 'set_theft_protection', body);
  return c.json(result, toStatusCode(result.statusCode || (result.success ? 200 : 400)));
});

domains.put('/:id/whois-protection', async (c) => {
  const user = c.get('user');
  const token = c.get('token');
  const domainId = c.req.param('id');
  const body = await c.req.json();
  const domainService = new DomainService(createAuthClient(token), supabaseAdmin);
  const result = await domainService.manageDomain(parseInt(domainId), user.id, user.role, 'set_whois_protection', body);
  return c.json(result, toStatusCode(result.statusCode || (result.success ? 200 : 400)));
});

export default domains;
