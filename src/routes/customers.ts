import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { authMiddleware, sellerOnly } from '../middleware/auth';
import { createAuthClient, supabaseAdmin } from '../services/supabase.service';
import { CustomerService } from '../services/customer.service';
import { LoggerService } from '../services/logger.service';
import { getClientIp } from '../middleware/security';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

const customers = new Hono();

// Apply auth middleware to all routes
customers.use('*', authMiddleware);

// Helper to convert status code
const toStatusCode = (code: number): ContentfulStatusCode => code as ContentfulStatusCode;

// Get current customer profile (for logged-in customer)
customers.get('/me', async (c) => {
  const user = c.get('user');
  const token = c.get('token');

  // Only for customers
  if (user.role !== 'customer') {
    return c.json({ success: false, error: 'This endpoint is for customers only' }, 403);
  }

  const supabase = createAuthClient(token);
  const customerService = new CustomerService(supabase, supabaseAdmin);
  const result = await customerService.getCustomerProfile(user.id);

  if (!result.success) {
    return c.json({
      success: false,
      error: result.error,
      linked: false,
    }, toStatusCode(result.statusCode || 500));
  }

  return c.json({
    success: true,
    data: result.data,
    linked: result.data?.linked ?? true,
  });
});

// Create new customer in Rdash (for logged-in customer without profile)
const createCustomerSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email'),
  organization: z.string().optional(),
  street_1: z.string().min(1, 'Address is required'),
  city: z.string().min(1, 'City is required'),
  state: z.string().min(1, 'State is required'),
  country_code: z.string().default('ID'),
  postal_code: z.string().min(1, 'Postal code is required'),
  voice: z.string().min(1, 'Phone is required'),
});

customers.post('/create', zValidator('json', createCustomerSchema), async (c) => {
  const user = c.get('user');
  const token = c.get('token');
  const body = c.req.valid('json');

  // Only for customers
  if (user.role !== 'customer') {
    return c.json({ success: false, error: 'This endpoint is for customers only' }, 403);
  }

  const SELLER_ID = 'f404050f-d55b-449a-8cce-cc43f0ec4dff';
  const supabase = createAuthClient(token);
  const customerService = new CustomerService(supabase, supabaseAdmin);

  const result = await customerService.createCustomerWithRdash(user.id, SELLER_ID, body);

  if (!result.success) {
    return c.json({ success: false, error: result.error }, toStatusCode(result.statusCode || 500));
  }

  return c.json({
    success: true,
    message: 'Customer berhasil dibuat',
    data: result.data,
  });
});

// Update current customer profile (for logged-in customer)
customers.put('/me', async (c) => {
  const user = c.get('user');
  const token = c.get('token');

  // Only for customers
  if (user.role !== 'customer') {
    return c.json({ success: false, error: 'This endpoint is for customers only' }, 403);
  }

  const body = await c.req.json();
  const supabase = createAuthClient(token);
  const customerService = new CustomerService(supabase, supabaseAdmin);

  const result = await customerService.updateCustomerProfile(user.id, body);

  if (!result.success) {
    return c.json({ success: false, error: result.error }, toStatusCode(result.statusCode || 500));
  }

  await LoggerService.logAction({
    user_id: user.id,
    ip_address: getClientIp(c),
    action: 'update_profile',
    resource: 'user/profile',
    payload: { updated_fields: Object.keys(body) },
    status: 'success'
  });

  return c.json({
    success: true,
    message: 'Profile berhasil diupdate',
    data: result.data,
  });
});

// Get customers list (seller only)
const listCustomersSchema = z.object({
  page: z.string().optional().default('1'),
  limit: z.string().optional().default('10'),
  search: z.string().optional(),
});

customers.get('/', sellerOnly, zValidator('query', listCustomersSchema), async (c) => {
  const user = c.get('user');
  const token = c.get('token');
  const { page, limit, search } = c.req.valid('query');

  const supabase = createAuthClient(token);
  const customerService = new CustomerService(supabase, supabaseAdmin);

  const result = await customerService.getCustomersBySeller(user.id, {
    page: parseInt(page),
    limit: parseInt(limit),
    search,
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

// Get customer detail
customers.get('/:id', sellerOnly, async (c) => {
  const user = c.get('user');
  const token = c.get('token');
  const customerId = c.req.param('id');

  const supabase = createAuthClient(token);
  const customerService = new CustomerService(supabase, supabaseAdmin);

  const result = await customerService.getCustomerById(parseInt(customerId), user.id);

  if (!result.success) {
    return c.json({ success: false, error: result.error }, toStatusCode(result.statusCode || 500));
  }

  return c.json({ success: true, data: result.data });
});

// Sync customers from Rdash (seller only)
customers.post('/sync', sellerOnly, async (c) => {
  const user = c.get('user');
  const token = c.get('token');

  const supabase = createAuthClient(token);
  const customerService = new CustomerService(supabase, supabaseAdmin);

  const result = await customerService.syncCustomersFromRdash(user.id);

  if (!result.success) {
    return c.json({ success: false, error: result.error }, toStatusCode(result.statusCode || 500));
  }

  return c.json({
    success: true,
    message: `Sync complete: ${result.data?.synced} synced, ${result.data?.linked} linked to users, ${result.data?.failed} failed`,
    synced: result.data?.synced,
    linked: result.data?.linked,
    failed: result.data?.failed,
  });
});

// Sync single customer with domains from Rdash
customers.post('/:id/sync', sellerOnly, async (c) => {
  const user = c.get('user');
  const token = c.get('token');
  const customerId = c.req.param('id');

  const supabase = createAuthClient(token);
  const customerService = new CustomerService(supabase, supabaseAdmin);

  const result = await customerService.syncSingleCustomer(parseInt(customerId), user.id);

  if (!result.success) {
    return c.json({ success: false, error: result.error }, toStatusCode(result.statusCode || 500));
  }

  return c.json({
    success: true,
    message: `Customer synced with ${result.data?.domainsSynced} domains`,
    domainsSynced: result.data?.domainsSynced,
  });
});

export default customers;
