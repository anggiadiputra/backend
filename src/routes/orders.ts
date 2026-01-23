import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { authMiddleware, sellerOnly } from '../middleware/auth';
import { createAuthClient, supabaseAdmin } from '../services/supabase.service';
import { OrderService } from '../services/order.service';
import { LoggerService } from '../services/logger.service';
import { getClientIp } from '../middleware/security';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

const orders = new Hono();

// Apply auth middleware to all routes
orders.use('*', authMiddleware);

// Helper to convert status code
const toStatusCode = (code: number): ContentfulStatusCode => code as ContentfulStatusCode;

// Get orders list
const listOrdersSchema = z.object({
  page: z.string().optional().default('1'),
  limit: z.string().optional().default('10'),
  status: z.string().optional(),
  customer_id: z.string().optional(),
});

orders.get('/', zValidator('query', listOrdersSchema), async (c) => {
  const user = c.get('user');
  const token = c.get('token');
  const { page, limit, status, customer_id } = c.req.valid('query');

  const supabase = createAuthClient(token);
  const orderService = new OrderService(supabase, supabaseAdmin);

  const result = await orderService.getOrdersByRole(user.id, user.role, {
    page: parseInt(page),
    limit: parseInt(limit),
    status,
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

// Get order detail
orders.get('/:id', async (c) => {
  const user = c.get('user');
  const token = c.get('token');
  const orderId = c.req.param('id');

  const supabase = createAuthClient(token);
  const orderService = new OrderService(supabase, supabaseAdmin);

  const result = await orderService.getOrderById(parseInt(orderId), user.id, user.role);

  if (!result.success) {
    return c.json({ success: false, error: result.error }, toStatusCode(result.statusCode || 500));
  }

  return c.json({ success: true, data: result.data });
});

// Create order
const createOrderSchema = z.object({
  customer_id: z.number(),
  items: z.array(z.object({
    domain_name: z.string(),
    tld: z.string(),
    action: z.enum(['register', 'renew', 'transfer']),
    years: z.number().min(1).max(10),
    price: z.number(),
  })),
  notes: z.string().optional(),
});

import { strictLimiter } from '../middleware/security';

// ...

orders.post('/', strictLimiter, zValidator('json', createOrderSchema), async (c) => {
  const user = c.get('user');
  const token = c.get('token');
  const body = c.req.valid('json');

  const supabase = createAuthClient(token);
  const orderService = new OrderService(supabase, supabaseAdmin);

  const result = await orderService.createOrder(user.id, body);

  if (!result.success) {
    return c.json({ success: false, error: result.error }, toStatusCode(result.statusCode || 500));
  }

  await LoggerService.logAction({
    user_id: user.id,
    ip_address: getClientIp(c),
    action: 'create_order',
    resource: `order/${result.data?.id}`,
    payload: { items: body.items, total: result.data?.total_amount },
    status: 'success'
  });

  return c.json({
    success: true,
    data: result.data,
    message: 'Order created successfully',
  });
});

// Update order status (seller only)
const updateStatusSchema = z.object({
  status: z.enum(['pending', 'processing', 'completed', 'cancelled', 'refunded']),
});

orders.put('/:id/status', sellerOnly, zValidator('json', updateStatusSchema), async (c) => {
  const user = c.get('user');
  const token = c.get('token');
  const orderId = c.req.param('id');
  const { status } = c.req.valid('json');

  const supabase = createAuthClient(token);
  const orderService = new OrderService(supabase, supabaseAdmin);

  const result = await orderService.updateOrderStatus(parseInt(orderId), user.id, status);

  if (!result.success) {
    return c.json({ success: false, error: result.error }, toStatusCode(result.statusCode || 500));
  }

  await LoggerService.logAction({
    user_id: user.id,
    ip_address: getClientIp(c),
    action: 'update_order_status',
    resource: `order/${orderId}`,
    payload: { old_status: 'unknown', new_status: status },
    status: 'success'
  });

  return c.json({
    success: true,
    data: result.data,
    message: 'Order status updated',
  });
});

export default orders;
