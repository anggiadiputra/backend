import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { env } from '../config/env';
import { authMiddleware } from '../middleware/auth';

const rdash = new Hono();

// Protect all Rdash routes with authentication
rdash.use('*', authMiddleware);

// Helper to get Rdash headers
function getRdashHeaders(): Record<string, string> {
  const credentials = Buffer.from(`${env.RDASH_RESELLER_ID}:${env.RDASH_API_KEY}`).toString('base64');
  return {
    'Authorization': `Basic ${credentials}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };
}

// Proxy to Rdash API
async function proxyToRdash(endpoint: string, options: RequestInit = {}) {
  const url = `${env.RDASH_BASE_URL}${endpoint}`;
  console.log(`[Rdash Proxy] ${options.method || 'GET'} ${url}`);

  const response = await fetch(url, {
    ...options,
    headers: {
      ...getRdashHeaders(),
      ...options.headers,
    },
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { success: false, message: text || response.statusText };
  }

  if (!response.ok) {
    console.error(`[Rdash Proxy] Error ${response.status} from ${url}:`, text);
  }

  return { data, status: response.status };
}

// GET /api/rdash/account/profile
rdash.get('/account/profile', async (c) => {
  try {
    // Try to get reseller profile first, if not available, return basic info
    try {
      const { data, status } = await proxyToRdash('/account/profile');
      return c.json(data, status as any);
    } catch (profileError) {
      // If profile endpoint doesn't exist, try to get basic account info from balance or transactions
      console.log('[Rdash] Profile endpoint not available, trying balance endpoint');
      
      try {
        const { data: balanceData, status: balanceStatus } = await proxyToRdash('/account/balance');
        if (balanceStatus === 200 && balanceData.success) {
          // Return a basic profile structure
          return c.json({
            success: true,
            data: {
              reseller_id: env.RDASH_RESELLER_ID,
              balance: balanceData.data?.balance || 0,
              currency: balanceData.data?.currency || 'IDR',
              status: 'active'
            }
          });
        }
      } catch (balanceError) {
        console.log('[Rdash] Balance endpoint also failed');
      }
      
      // Return minimal profile info
      return c.json({
        success: true,
        data: {
          reseller_id: env.RDASH_RESELLER_ID,
          status: 'active',
          message: 'Profile endpoint not available'
        }
      });
    }
  } catch (error: any) {
    console.error('[Rdash] Profile error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// GET /api/rdash/account/balance
rdash.get('/account/balance', async (c) => {
  try {
    const { data, status } = await proxyToRdash('/account/balance');
    return c.json(data, status as any);
  } catch (error: any) {
    console.error('[Rdash] Balance error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// GET /api/rdash/account/transactions/:transaction_id - Detail transaksi
rdash.get('/account/transactions/:transaction_id', async (c) => {
  try {
    const transactionId = c.req.param('transaction_id');
    const { data, status } = await proxyToRdash(`/account/transactions/${transactionId}`);
    return c.json(data, status as any);
  } catch (error: any) {
    console.error('[Rdash] Transaction detail error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// GET /api/rdash/account/transactions - List transaksi
rdash.get('/account/transactions', async (c) => {
  try {
    const query = c.req.query();
    const params = new URLSearchParams();

    // Required: date_range (format: min_max / yyyy-mm-dd_yyyy-mm-dd)
    if (query.date_range) {
      params.append('date_range', query.date_range);
    } else {
      // Default to last 30 days if not provided
      const today = new Date();
      const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
      const formatDate = (d: Date) => d.toISOString().split('T')[0];
      params.append('date_range', `${formatDate(thirtyDaysAgo)}_${formatDate(today)}`);
    }

    // Optional parameters
    if (query.page) params.append('page', query.page);
    if (query.limit) params.append('limit', query.limit);
    if (query.transaction) params.append('transaction', query.transaction);
    if (query.description) params.append('description', query.description);
    if (query.tld) params.append('tld', query.tld);
    if (query.amount_range) params.append('amount_range', query.amount_range);

    const endpoint = `/account/transactions?${params.toString()}`;
    const { data, status } = await proxyToRdash(endpoint);
    return c.json(data, status as any);
  } catch (error: any) {
    console.error('[Rdash] Transactions error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

import { strictLimiter } from '../middleware/security';

// ... (existing imports)

// GET /api/rdash/domains/availability
const availabilitySchema = z.object({
  domain: z.string().min(3).regex(/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, 'Invalid domain format'),
});

rdash.get('/domains/availability', strictLimiter, zValidator('query', availabilitySchema), async (c) => {
  try {
    const { domain } = c.req.valid('query');

    // Additional sanitization: remove leading/trailing dots, lowercase
    const cleanDomain = domain.replace(/^\.+|\.+$/g, '').toLowerCase();

    const params = new URLSearchParams({ domain: cleanDomain, include_premium_domains: 'true' });
    const { data, status } = await proxyToRdash(`/domains/availability?${params.toString()}`);
    return c.json(data, status as any);
  } catch (error: any) {
    console.error('[Rdash] Availability error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// GET /api/rdash/domains
rdash.get('/domains', async (c) => {
  try {
    const query = c.req.query();
    const params = new URLSearchParams();
    if (query.page) params.append('page', query.page);
    if (query.limit) params.append('limit', query.limit);
    if (query.customer_id) params.append('customer_id', query.customer_id);
    if (query.search) params.append('search', query.search);

    const endpoint = `/domains${params.toString() ? '?' + params.toString() : ''}`;
    const { data, status } = await proxyToRdash(endpoint);
    return c.json(data, status as any);
  } catch (error: any) {
    console.error('[Rdash] Domains error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// GET /api/rdash/domains/:id
rdash.get('/domains/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const { data, status } = await proxyToRdash(`/domains/${id}`);
    return c.json(data, status as any);
  } catch (error: any) {
    console.error('[Rdash] Domain detail error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// ==================== Auth Code (EPP Code) ====================

// GET /api/rdash/domains/:id/auth-code - Get domain auth code
rdash.get('/domains/:id/auth-code', async (c) => {
  try {
    const id = c.req.param('id');
    const { data, status } = await proxyToRdash(`/domains/${id}/auth_code`);
    return c.json(data, status as any);
  } catch (error: any) {
    console.error('[Rdash] Get auth code error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// PUT /api/rdash/domains/:id/auth-code - Reset/Change domain auth code
rdash.put('/domains/:id/auth-code', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const { auth_code } = body;

    if (!auth_code) {
      return c.json({ success: false, message: 'auth_code is required (min 8 chars, at least one letter and one number)' }, 400);
    }

    const formData = new URLSearchParams();
    formData.append('auth_code', auth_code);

    const url = `${env.RDASH_BASE_URL}/domains/${id}/auth_code`;
    const credentials = Buffer.from(`${env.RDASH_RESELLER_ID}:${env.RDASH_API_KEY}`).toString('base64');

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: formData.toString(),
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { success: false, message: text || response.statusText };
    }

    return c.json(data, response.status as any);
  } catch (error: any) {
    console.error('[Rdash] Reset auth code error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// ==================== Registrar Lock ====================

// PUT /api/rdash/domains/:id/registrar-locked - Enable registrar lock
rdash.put('/domains/:id/registrar-locked', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));

    const formData = new URLSearchParams();
    if (body.reason) formData.append('reason', body.reason);

    const url = `${env.RDASH_BASE_URL}/domains/${id}/registrar-locked`;
    const credentials = Buffer.from(`${env.RDASH_RESELLER_ID}:${env.RDASH_API_KEY}`).toString('base64');

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: formData.toString(),
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { success: false, message: text || response.statusText };
    }

    return c.json(data, response.status as any);
  } catch (error: any) {
    console.error('[Rdash] Enable registrar lock error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// DELETE /api/rdash/domains/:id/registrar-locked - Disable registrar lock
rdash.delete('/domains/:id/registrar-locked', async (c) => {
  try {
    const id = c.req.param('id');
    const { data, status } = await proxyToRdash(`/domains/${id}/registrar-locked`, { method: 'DELETE' });
    return c.json(data, status as any);
  } catch (error: any) {
    console.error('[Rdash] Disable registrar lock error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// GET /api/rdash/domains/details
rdash.get('/domains/details', async (c) => {
  try {
    const domainName = c.req.query('domain_name');
    if (!domainName) {
      return c.json({ success: false, message: 'domain_name parameter required' }, 400);
    }

    const { data, status } = await proxyToRdash(`/domains/details?domain_name=${encodeURIComponent(domainName)}`);
    return c.json(data, status as any);
  } catch (error: any) {
    console.error('[Rdash] Domain details error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// GET /api/rdash/pricing
rdash.get('/pricing', async (c) => {
  try {
    const query = c.req.query();
    const params = new URLSearchParams();
    if (query.page) params.append('page', query.page);
    if (query.limit) params.append('limit', query.limit);

    const endpoint = `/pricing${params.toString() ? '?' + params.toString() : ''}`;
    const { data, status } = await proxyToRdash(endpoint);
    return c.json(data, status as any);
  } catch (error: any) {
    console.error('[Rdash] Pricing error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// GET /api/rdash/account/prices - Extension prices with promo support
rdash.get('/account/prices', async (c) => {
  try {
    const query = c.req.query();
    const params = new URLSearchParams();
    if (query.page) params.append('page', query.page);
    if (query.limit) params.append('limit', query.limit);
    if (query.promo) params.append('promo', query.promo);
    if (query['domainExtension[extension]']) {
      params.append('domainExtension[extension]', query['domainExtension[extension]']);
    }

    const endpoint = `/account/prices${params.toString() ? '?' + params.toString() : ''}`;
    const { data, status } = await proxyToRdash(endpoint);
    return c.json(data, status as any);
  } catch (error: any) {
    console.error('[Rdash] Account prices error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// GET /api/rdash/customers
rdash.get('/customers', async (c) => {
  try {
    const query = c.req.query();
    const params = new URLSearchParams();
    if (query.page) params.append('page', query.page);
    if (query.limit) params.append('limit', query.limit);
    if (query.search) params.append('search', query.search);

    const endpoint = `/customers${params.toString() ? '?' + params.toString() : ''}`;
    const { data, status } = await proxyToRdash(endpoint);
    return c.json(data, status as any);
  } catch (error: any) {
    console.error('[Rdash] Customers error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// GET /api/rdash/customers/:id
rdash.get('/customers/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const { data, status } = await proxyToRdash(`/customers/${id}`);
    return c.json(data, status as any);
  } catch (error: any) {
    console.error('[Rdash] Customer detail error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// POST /api/rdash/domains - Register new domain
rdash.post('/domains', async (c) => {
  try {
    const body = await c.req.json();
    const { name, customer_id, period, buy_whois_protection } = body;

    if (!name || !customer_id) {
      return c.json({ success: false, message: 'name and customer_id are required' }, 400);
    }

    const formData = new URLSearchParams();
    formData.append('name', name);
    formData.append('customer_id', customer_id.toString());
    if (period) formData.append('period', period.toString());
    if (buy_whois_protection) formData.append('buy_whois_protection', 'true');

    console.log(`[Rdash] Registering domain: ${name} for customer ${customer_id}`);

    const url = `${env.RDASH_BASE_URL}/domains`;
    const credentials = Buffer.from(`${env.RDASH_RESELLER_ID}:${env.RDASH_API_KEY}`).toString('base64');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: formData.toString(),
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { success: false, message: text || response.statusText };
    }

    console.log(`[Rdash] Register domain response:`, response.status, data);
    return c.json(data, response.status as any);
  } catch (error: any) {
    console.error('[Rdash] Register domain error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// POST /api/rdash/domains/transfer - Transfer domain
rdash.post('/domains/transfer', async (c) => {
  try {
    const body = await c.req.json();
    // Accept both 'domain' and 'name' for backward compatibility
    const { domain, name, customer_id, auth_code, period, whois_protection, buy_whois_protection, nameserver } = body;
    const domainName = name || domain;

    if (!domainName || !customer_id || !auth_code) {
      return c.json({ success: false, message: 'name, customer_id, and auth_code are required' }, 400);
    }

    // Rdash API uses 'name' parameter for transfer
    const formData = new URLSearchParams();
    formData.append('name', domainName);
    formData.append('customer_id', customer_id.toString());
    formData.append('auth_code', auth_code);
    if (period) formData.append('period', period.toString());
    if (whois_protection || buy_whois_protection) formData.append('buy_whois_protection', 'true');
    // Optional nameservers
    if (nameserver && Array.isArray(nameserver)) {
      nameserver.forEach((ns: string, index: number) => {
        if (ns) formData.append(`nameserver[${index}]`, ns);
      });
    }

    console.log(`[Rdash] Transferring domain: ${domainName} for customer ${customer_id}`);

    const url = `${env.RDASH_BASE_URL}/domains/transfer`;
    const credentials = Buffer.from(`${env.RDASH_RESELLER_ID}:${env.RDASH_API_KEY}`).toString('base64');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: formData.toString(),
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { success: false, message: text || response.statusText };
    }

    console.log(`[Rdash] Transfer domain response:`, response.status, data);
    return c.json(data, response.status as any);
  } catch (error: any) {
    console.error('[Rdash] Transfer domain error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// ==================== WHOIS ====================

// GET /api/rdash/domains/whois - WHOIS lookup
rdash.get('/domains/whois', async (c) => {
  try {
    const domain = c.req.query('domain');
    if (!domain) {
      return c.json({ success: false, message: 'domain parameter required' }, 400);
    }

    // Rdash API uses GET with query param for WHOIS
    const url = `${env.RDASH_BASE_URL}/domains/whois?domain=${encodeURIComponent(domain)}`;
    const credentials = Buffer.from(`${env.RDASH_RESELLER_ID}:${env.RDASH_API_KEY}`).toString('base64');

    console.log(`[Rdash] WHOIS lookup for: ${domain}, URL: ${url}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Accept': 'application/json',
      },
    });

    const text = await response.text();
    console.log(`[Rdash] WHOIS raw response:`, response.status, text.substring(0, 500));

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { success: false, message: text || response.statusText };
    }

    return c.json(data, response.status as any);
  } catch (error: any) {
    console.error('[Rdash] WHOIS error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// Alternative WHOIS endpoint for testing (in case old code is cached)
// GET /api/rdash/whois-lookup - WHOIS lookup v2
rdash.get('/whois-lookup', async (c) => {
  try {
    const domain = c.req.query('domain');
    if (!domain) {
      return c.json({ success: false, message: 'domain parameter required' }, 400);
    }

    // Rdash API uses GET with query param for WHOIS
    const url = `${env.RDASH_BASE_URL}/domains/whois?domain=${encodeURIComponent(domain)}`;
    const credentials = Buffer.from(`${env.RDASH_RESELLER_ID}:${env.RDASH_API_KEY}`).toString('base64');

    console.log(`[Rdash] WHOIS v2 lookup for: ${domain}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Accept': 'application/json',
      },
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { success: false, message: text || response.statusText };
    }

    return c.json(data, response.status as any);
  } catch (error: any) {
    console.error('[Rdash] WHOIS v2 error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// ==================== Child Nameservers (Hosts) ====================

// GET /api/rdash/domains/:id/hosts - Get child nameservers
rdash.get('/domains/:id/hosts', async (c) => {
  try {
    const id = c.req.param('id');
    const query = c.req.query();
    const params = new URLSearchParams();

    // domain_id is required as query param
    params.append('domain_id', id);
    if (query.page) params.append('page', query.page);
    if (query.limit) params.append('limit', query.limit);
    if (query.hostname) params.append('hostname', query.hostname);
    if (query['f_params[orderBy][field]']) params.append('f_params[orderBy][field]', query['f_params[orderBy][field]']);
    if (query['f_params[orderBy][type]']) params.append('f_params[orderBy][type]', query['f_params[orderBy][type]']);

    const { data, status } = await proxyToRdash(`/domains/${id}/hosts?${params.toString()}`);
    return c.json(data, status as any);
  } catch (error: any) {
    console.error('[Rdash] Get hosts error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// GET /api/rdash/domains/:id/hosts/:hostId - Get single child nameserver
rdash.get('/domains/:id/hosts/:hostId', async (c) => {
  try {
    const id = c.req.param('id');
    const hostId = c.req.param('hostId');
    const { data, status } = await proxyToRdash(`/domains/${id}/hosts/${hostId}`);
    return c.json(data, status as any);
  } catch (error: any) {
    console.error('[Rdash] Get host detail error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// POST /api/rdash/domains/:id/hosts - Create child nameserver
rdash.post('/domains/:id/hosts', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const { hostname, ip_address, customer_id } = body;

    if (!hostname || !ip_address) {
      return c.json({ success: false, message: 'hostname and ip_address are required' }, 400);
    }

    const formData = new URLSearchParams();
    formData.append('hostname', hostname);
    formData.append('ip_address', ip_address);
    if (customer_id) formData.append('customer_id', customer_id.toString());

    const url = `${env.RDASH_BASE_URL}/domains/${id}/hosts`;
    const credentials = Buffer.from(`${env.RDASH_RESELLER_ID}:${env.RDASH_API_KEY}`).toString('base64');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: formData.toString(),
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { success: false, message: text || response.statusText };
    }

    return c.json(data, response.status as any);
  } catch (error: any) {
    console.error('[Rdash] Create host error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// PUT /api/rdash/domains/:id/hosts/:hostId - Update child nameserver
rdash.put('/domains/:id/hosts/:hostId', async (c) => {
  try {
    const id = c.req.param('id');
    const hostId = c.req.param('hostId');
    const body = await c.req.json();
    const { hostname, ip_address, old_ip_address } = body;

    const formData = new URLSearchParams();
    if (hostname) formData.append('hostname', hostname);
    if (ip_address) formData.append('ip_address', ip_address);
    if (old_ip_address) formData.append('old_ip_address', old_ip_address);

    const url = `${env.RDASH_BASE_URL}/domains/${id}/hosts/${hostId}`;
    const credentials = Buffer.from(`${env.RDASH_RESELLER_ID}:${env.RDASH_API_KEY}`).toString('base64');

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: formData.toString(),
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { success: false, message: text || response.statusText };
    }

    return c.json(data, response.status as any);
  } catch (error: any) {
    console.error('[Rdash] Update host error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// DELETE /api/rdash/domains/:id/hosts/:hostId - Delete child nameserver
rdash.delete('/domains/:id/hosts/:hostId', async (c) => {
  try {
    const id = c.req.param('id');
    const hostId = c.req.param('hostId');
    const { data, status } = await proxyToRdash(`/domains/${id}/hosts/${hostId}`, { method: 'DELETE' });
    return c.json(data, status as any);
  } catch (error: any) {
    console.error('[Rdash] Delete host error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// ==================== Domain Forwarding ====================

// GET /api/rdash/domains/:id/forwarding - Get forwarding rules
rdash.get('/domains/:id/forwarding', async (c) => {
  try {
    const id = c.req.param('id');
    const { data, status } = await proxyToRdash(`/domains/${id}/forwarding`);
    return c.json(data, status as any);
  } catch (error: any) {
    console.error('[Rdash] Get forwarding error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// POST /api/rdash/domains/:id/forwarding - Create forwarding rule
rdash.post('/domains/:id/forwarding', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const { from, to } = body;

    if (!from || !to) {
      return c.json({ success: false, message: 'from and to are required' }, 400);
    }

    const formData = new URLSearchParams();
    formData.append('from', from);
    formData.append('to', to);

    const url = `${env.RDASH_BASE_URL}/domains/${id}/forwarding`;
    const credentials = Buffer.from(`${env.RDASH_RESELLER_ID}:${env.RDASH_API_KEY}`).toString('base64');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: formData.toString(),
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { success: false, message: text || response.statusText };
    }

    return c.json(data, response.status as any);
  } catch (error: any) {
    console.error('[Rdash] Create forwarding error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// DELETE /api/rdash/domains/:id/forwarding/:forwardingId - Delete forwarding rule
rdash.delete('/domains/:id/forwarding/:forwardingId', async (c) => {
  try {
    const id = c.req.param('id');
    const forwardingId = c.req.param('forwardingId');
    const { data, status } = await proxyToRdash(`/domains/${id}/forwarding/${forwardingId}`, { method: 'DELETE' });
    return c.json(data, status as any);
  } catch (error: any) {
    console.error('[Rdash] Delete forwarding error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// ==================== DNS Records ====================

// GET /api/rdash/domains/:id/dns - Get DNS records
rdash.get('/domains/:id/dns', async (c) => {
  try {
    const id = c.req.param('id');
    const { data, status } = await proxyToRdash(`/domains/${id}/dns`);
    return c.json(data, status as any);
  } catch (error: any) {
    console.error('[Rdash] Get DNS error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// POST /api/rdash/domains/:id/dns - Create/Replace DNS records
rdash.post('/domains/:id/dns', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const { records } = body;

    if (!records || !Array.isArray(records)) {
      return c.json({ success: false, message: 'records array is required' }, 400);
    }

    const formData = new URLSearchParams();
    records.forEach((record: any, index: number) => {
      formData.append(`records[${index}][name]`, record.name);
      formData.append(`records[${index}][type]`, record.type);
      formData.append(`records[${index}][content]`, record.content);
      formData.append(`records[${index}][ttl]`, (record.ttl || 3600).toString());
    });

    const url = `${env.RDASH_BASE_URL}/domains/${id}/dns`;
    const credentials = Buffer.from(`${env.RDASH_RESELLER_ID}:${env.RDASH_API_KEY}`).toString('base64');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: formData.toString(),
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { success: false, message: text || response.statusText };
    }

    return c.json(data, response.status as any);
  } catch (error: any) {
    console.error('[Rdash] Create DNS error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// DELETE /api/rdash/domains/:id/dns - Delete entire DNS zone
rdash.delete('/domains/:id/dns', async (c) => {
  try {
    const id = c.req.param('id');
    const { data, status } = await proxyToRdash(`/domains/${id}/dns`, { method: 'DELETE' });
    return c.json(data, status as any);
  } catch (error: any) {
    console.error('[Rdash] Delete DNS zone error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// DELETE /api/rdash/domains/:id/dns/record - Delete single DNS record
rdash.delete('/domains/:id/dns/record', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const { name, type, content } = body;

    if (!name || !type || !content) {
      return c.json({ success: false, message: 'name, type, and content are required' }, 400);
    }

    const formData = new URLSearchParams();
    formData.append('name', name);
    formData.append('type', type);
    formData.append('content', content);

    const url = `${env.RDASH_BASE_URL}/domains/${id}/dns/record`;
    const credentials = Buffer.from(`${env.RDASH_RESELLER_ID}:${env.RDASH_API_KEY}`).toString('base64');

    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: formData.toString(),
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { success: false, message: text || response.statusText };
    }

    return c.json(data, response.status as any);
  } catch (error: any) {
    console.error('[Rdash] Delete DNS record error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// ==================== DNSSEC ====================

// POST /api/rdash/domains/:id/dns/sec - Enable DNSSEC
rdash.post('/domains/:id/dns/sec', async (c) => {
  try {
    const id = c.req.param('id');
    const { data, status } = await proxyToRdash(`/domains/${id}/dns/sec`, { method: 'POST' });
    return c.json(data, status as any);
  } catch (error: any) {
    console.error('[Rdash] Enable DNSSEC error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// DELETE /api/rdash/domains/:id/dns/sec - Disable DNSSEC
rdash.delete('/domains/:id/dns/sec', async (c) => {
  try {
    const id = c.req.param('id');
    const { data, status } = await proxyToRdash(`/domains/${id}/dns/sec`, { method: 'DELETE' });
    return c.json(data, status as any);
  } catch (error: any) {
    console.error('[Rdash] Disable DNSSEC error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// ==================== WHOIS Protection ====================

// GET /api/rdash/domains/:id/whois-protection - Get WHOIS protection status
rdash.get('/domains/:id/whois-protection', async (c) => {
  try {
    const id = c.req.param('id');
    const { data, status } = await proxyToRdash(`/domains/${id}/whois-protection`);
    return c.json(data, status as any);
  } catch (error: any) {
    console.error('[Rdash] Get WHOIS protection error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// POST /api/rdash/domains/:id/whois-protection - Buy WHOIS protection
rdash.post('/domains/:id/whois-protection', async (c) => {
  try {
    const id = c.req.param('id');
    const { data, status } = await proxyToRdash(`/domains/${id}/whois-protection`, { method: 'POST' });
    return c.json(data, status as any);
  } catch (error: any) {
    console.error('[Rdash] Buy WHOIS protection error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// PUT /api/rdash/domains/:id/whois-protection - Enable WHOIS protection
rdash.put('/domains/:id/whois-protection', async (c) => {
  try {
    const id = c.req.param('id');

    const url = `${env.RDASH_BASE_URL}/domains/${id}/whois-protection`;
    const credentials = Buffer.from(`${env.RDASH_RESELLER_ID}:${env.RDASH_API_KEY}`).toString('base64');

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Accept': 'application/json',
      },
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { success: false, message: text || response.statusText };
    }

    return c.json(data, response.status as any);
  } catch (error: any) {
    console.error('[Rdash] Enable WHOIS protection error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// DELETE /api/rdash/domains/:id/whois-protection - Disable WHOIS protection
rdash.delete('/domains/:id/whois-protection', async (c) => {
  try {
    const id = c.req.param('id');
    const { data, status } = await proxyToRdash(`/domains/${id}/whois-protection`, { method: 'DELETE' });
    return c.json(data, status as any);
  } catch (error: any) {
    console.error('[Rdash] Disable WHOIS protection error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// ==================== Domain Renew ====================

// POST /api/rdash/domains/:id/renew - Renew domain
rdash.post('/domains/:id/renew', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const { period, current_date, buy_whois_protection } = body;

    if (!period || !current_date) {
      return c.json({ success: false, message: 'period and current_date are required' }, 400);
    }

    const formData = new URLSearchParams();
    formData.append('period', period.toString());
    formData.append('current_date', current_date); // Format: Y-m-d
    if (buy_whois_protection) formData.append('buy_whois_protection', 'true');

    const url = `${env.RDASH_BASE_URL}/domains/${id}/renew`;
    const credentials = Buffer.from(`${env.RDASH_RESELLER_ID}:${env.RDASH_API_KEY}`).toString('base64');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: formData.toString(),
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { success: false, message: text || response.statusText };
    }

    console.log(`[Rdash] Renew domain ${id} response:`, response.status, data);
    return c.json(data, response.status as any);
  } catch (error: any) {
    console.error('[Rdash] Renew domain error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

// ==================== Domain Restore ====================

// POST /api/rdash/domains/:id/restore - Restore domain
rdash.post('/domains/:id/restore', async (c) => {
  try {
    const id = c.req.param('id');

    const url = `${env.RDASH_BASE_URL}/domains/${id}/restore`;
    const credentials = Buffer.from(`${env.RDASH_RESELLER_ID}:${env.RDASH_API_KEY}`).toString('base64');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Accept': 'application/json',
      },
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { success: false, message: text || response.statusText };
    }

    console.log(`[Rdash] Restore domain ${id} response:`, response.status, data);
    return c.json(data, response.status as any);
  } catch (error: any) {
    console.error('[Rdash] Restore domain error:', error);
    return c.json({ success: false, message: error.message }, 500);
  }
});

export default rdash;
