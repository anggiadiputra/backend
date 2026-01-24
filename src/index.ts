import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import { bodyLimit } from 'hono/body-limit';
import { swaggerUI } from '@hono/swagger-ui';
import { openApiSpec } from './config/swagger';
import { initCronJobs } from './cron/scheduler';
import { env } from './config/env';
import Redis from 'ioredis';

// Import routes
import domains from './routes/domains';
import customers from './routes/customers';
import auth from './routes/auth';
import orders from './routes/orders';
import payments from './routes/payments';
import pricing from './routes/pricing';
import notifications from './routes/notifications';
import transactions from './routes/transactions';
import rdash from './routes/rdash';
import logs from './routes/logs';
import settings from './routes/settings'; // Import settings route

import { globalLimiter, securityHeaders, removePoweredBy, checkBlacklist } from './middleware/security';
import { xssSanitizer } from './middleware/sanitizer';
import { apiKeyAuth } from './middleware/apiKey';

const app = new Hono();

// Global middleware
app.use('*', logger());
app.use('*', prettyJSON());
app.use('*', xssSanitizer); // Sanitize inputs from XSS
app.use('*', checkBlacklist); // 1. Check if IP is blacklisted (Redis)
app.use('*', removePoweredBy); // 2. Manually remove X-Powered-By

// Security: Limit request body size to 100KB
app.use('*', bodyLimit({
  maxSize: 100 * 1024, // 100KB
  onError: (c) => {
    return c.json({ success: false, error: 'Payload too large', message: 'Request body must be less than 100KB' }, 413);
  },
}));

app.use('*', cors({
  origin: env.CORS_ORIGINS.split(','),
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'x-client-info', 'apikey', 'X-API-Key'],
  exposeHeaders: ['Content-Length'],
  maxAge: 86400,
  credentials: true,
}));

app.use('*', securityHeaders); // Add Security Headers
app.use('/api/*', apiKeyAuth);  // API Key Authentication
app.use('*', globalLimiter);   // Add Global Rate Limiting

// Health check
app.get('/', (c) => {
  return c.json({
    success: true,
    message: 'Domain Management API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/health/redis', async (c) => {
  if (!env.REDIS_URL) {
    return c.json({
      success: false,
      message: 'REDIS_URL is not set in environment variables',
      using_memory: true
    }, 200);
  }

  try {
    const redis = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
    });

    const start = Date.now();
    await redis.ping();
    const latency = Date.now() - start;
    await redis.quit();

    return c.json({
      success: true,
      message: 'Redis connection successful',
      latency_ms: latency
    });
  } catch (error: any) {
    return c.json({
      success: false,
      message: 'Redis connection failed',
      error: error.message
    }, 500);
  }
});

// Mount routes
app.route('/api/auth', auth);
app.route('/api/domains', domains);
app.route('/api/customers', customers);
app.route('/api/orders', orders);
app.route('/api/payments', payments);
app.route('/api/pricing', pricing);
app.route('/api/notifications', notifications);
app.route('/api/transactions', transactions);
app.route('/api/rdash', rdash);
app.route('/api/logs', logs);
app.route('/api/settings', settings); // Register settings route

// Documentation
app.get('/api/openapi.json', (c) => c.json(openApiSpec));
app.get('/api/docs', swaggerUI({ url: '/api/openapi.json' }));

// 404 handler
app.notFound((c) => {
  return c.json({ success: false, error: 'Not found' }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('Server error:', err);
  return c.json({ success: false, error: 'Internal server error' }, 500);
});

// Start server
const port = parseInt(env.PORT) || 3000;
console.log(`🚀 Server starting on port ${port}`);

serve({
  fetch: app.fetch,
  port,
});

// Initialize automated tasks (Cron Jobs)
initCronJobs();

console.log(`✅ Server running at http://localhost:${port}`);
