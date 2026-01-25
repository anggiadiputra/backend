import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { authMiddleware } from '../middleware/auth';
import { createAuthClient, supabaseAdmin } from '../services/supabase.service';
import { LoggerService } from '../services/logger.service';
import { rdashService } from '../services/rdash.service';
import { getClientIp } from '../middleware/security';
import { UAParser } from 'ua-parser-js';

const auth = new Hono();

// Send OTP
const sendOtpSchema = z.object({
  email: z.string().email(),
});

import { authLimiter } from '../middleware/security';

// ...

auth.post('/login', authLimiter, zValidator('json', sendOtpSchema), async (c) => {
  const { email } = c.req.valid('json');

  try {
    const { error } = await supabaseAdmin.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
      },
    });

    if (error) {
      await LoggerService.logAuth(getClientIp(c), 'login_otp_send', 'failure', { email, error: error.message });
      return c.json({ success: false, error: error.message }, 400);
    }

    await LoggerService.logAuth(getClientIp(c), 'login_otp_send', 'success', { email });

    return c.json({
      success: true,
      message: 'OTP sent to your email',
    });
  } catch (error: any) {
    console.error('[Auth] Login Error:', error);
    return c.json({
      success: false,
      error: `Failed to send OTP: ${error.message}`,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    }, 500);
  }
});

// Verify OTP
const verifyOtpSchema = z.object({
  email: z.string().email(),
  token: z.string().min(6),
});

auth.post('/verify', authLimiter, zValidator('json', verifyOtpSchema), async (c) => {
  const { email, token } = c.req.valid('json');

  try {
    const { data, error } = await supabaseAdmin.auth.verifyOtp({
      email,
      token,
      type: 'email',
    });

    if (error) {
      await LoggerService.logAuth(getClientIp(c), 'verify_otp', 'failure', { email, error: error.message });
      return c.json({ success: false, error: error.message }, 400);
    }

    if (!data.session || !data.user) {
      await LoggerService.logAuth(getClientIp(c), 'verify_otp', 'failure', { email, error: 'No session created' });
      return c.json({ success: false, error: 'No session created' }, 400);
    }

    const { user } = data;

    // Get or create user profile
    let { data: profile } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', user.id)
      .single();

    // Auto-create user if not exists (for generic login)
    if (!profile) {
      const { data: newUser, error: createError } = await supabaseAdmin
        .from('users')
        .insert({
          id: user.id,
          email: user.email,
          role: 'customer',
        })
        .select()
        .single();

      if (createError) {
        console.error('[Auth] Failed to create user:', createError.message);
      } else {
        profile = newUser;
      }
    }

    await LoggerService.logAuth(getClientIp(c), 'verify_otp', 'success', {
      email,
      user_id: user.id,
      role: profile?.role || 'customer'
    });

    // Device & Session Tracking
    const userAgent = c.req.header('user-agent') || '';
    const parser = new UAParser(userAgent);
    const result = parser.getResult();

    try {
      await supabaseAdmin
        .from('login_sessions')
        .insert({
          user_id: user.id,
          ip_address: getClientIp(c),
          user_agent: userAgent,
          browser: result.browser.name || 'Unknown',
          os: result.os.name || 'Unknown',
          device_type: result.device.type || 'desktop',
          last_active_at: new Date().toISOString()
        });
    } catch (sessionError) {
      console.error('[Auth] Failed to record login session:', sessionError);
    }

    return c.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          role: profile?.role || 'customer',
        },
        session: {
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
          expires_at: data.session.expires_at,
        },
      },
    });
  } catch (error) {
    return c.json({ success: false, error: 'Failed to verify OTP' }, 500);
  }
});

// Register Verify
const registerVerifySchema = z.object({
  email: z.string().email(),
  token: z.string().min(6),
  fullName: z.string().min(1),
  phone: z.string().min(9), // Rdash: voice (9-20 digits)
  address: z.string().min(1), // Rdash: street_1
  city: z.string().min(1),
  state: z.string().min(1),
  country: z.string().length(2), // Rdash: country_code (ISO 2)
  zip: z.string().min(1), // Rdash: postal_code
  role: z.enum(['customer', 'seller']).default('customer'),
  companyName: z.string().optional(), // For seller or Rdash organization
});

auth.post('/register/verify', authLimiter, zValidator('json', registerVerifySchema), async (c) => {
  const payload = c.req.valid('json');
  const { email, token, fullName, role } = payload;

  try {
    // 1. Verify OTP
    const { data, error } = await supabaseAdmin.auth.verifyOtp({
      email,
      token,
      type: 'email',
    });

    if (error) {
      await LoggerService.logAuth(getClientIp(c), 'register_verify', 'failure', { email, error: error.message });
      return c.json({ success: false, error: error.message }, 400);
    }

    if (!data.session || !data.user) {
      return c.json({ success: false, error: 'No session created' }, 400);
    }

    const userId = data.user.id;

    // 2. Create User Profile
    // Upsert to ensure we handle existing users gracefully (though typically new for register)
    const { error: upsertError } = await supabaseAdmin
      .from('users')
      .upsert({
        id: userId,
        email: email,
        role: role,
        full_name: fullName,
        phone: payload.phone,
        address: payload.address,
        city: payload.city,
        country: payload.country,
        company_name: payload.companyName || (role === 'seller' ? fullName : null),
        updated_at: new Date().toISOString()
      });

    if (upsertError) {
      console.error('[Auth] Failed to create user profile:', upsertError);
      // Don't fail the whole request, but log it.
    }

    // 3. Create Rdash Customer (if role is customer or we want all users to be customers in Rdash)
    // Usually sellers are also customers in Rdash system context, but let's assume we maintain 1:1 map
    let rdashId = null;
    try {
      const rdashResult = await rdashService.createCustomer({
        name: fullName,
        email: email,
        organization: payload.companyName || fullName,
        street_1: payload.address,
        city: payload.city,
        state: payload.state,
        country_code: payload.country,
        postal_code: payload.zip,
        voice: payload.phone
      });

      if (rdashResult.success && rdashResult.data) {
        rdashId = rdashResult.data.id;

        // Link to local customer table
        await supabaseAdmin
          .from('customers')
          .insert({
            user_id: userId,
            rdash_id: rdashId,
            status: 'active'
          });

        console.log(`[Auth] Linked User ${userId} to Rdash Customer ${rdashId}`);
      } else {
        console.error('[Auth] Failed to create Rdash customer:', rdashResult.message);
      }
    } catch (rdashError) {
      console.error('[Auth] Rdash creation exception:', rdashError);
    }

    await LoggerService.logAuth(getClientIp(c), 'register_verify', 'success', {
      email,
      user_id: userId,
      role,
      rdash_id: rdashId
    });

    return c.json({
      success: true,
      data: {
        user: {
          id: userId,
          email: email,
          role: role,
          full_name: fullName,
        },
        session: {
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
          expires_at: data.session.expires_at,
        },
        rdash_id: rdashId
      },
    });

  } catch (error: any) {
    console.error('[Auth] Register Verify Error:', error);
    return c.json({
      success: false,
      error: `Registration failed: ${error.message}`,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    }, 500);
  }
});

// Refresh token
const refreshSchema = z.object({
  refresh_token: z.string(),
});

auth.post('/refresh', zValidator('json', refreshSchema), async (c) => {
  const { refresh_token } = c.req.valid('json');

  try {
    const { data, error } = await supabaseAdmin.auth.refreshSession({
      refresh_token,
    });

    if (error) {
      return c.json({ success: false, error: error.message }, 400);
    }

    if (!data.session) {
      return c.json({ success: false, error: 'No session created' }, 400);
    }

    return c.json({
      success: true,
      data: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
      },
    });
  } catch (error) {
    return c.json({ success: false, error: 'Failed to refresh token' }, 500);
  }
});

// Get current user (protected)
auth.get('/me', authMiddleware, async (c) => {
  const user = c.get('user');
  const token = c.get('token');

  try {
    const supabase = createAuthClient(token);

    // Get full user profile
    const { data: profile, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', user.id)
      .single();

    if (error) {
      return c.json({ success: false, error: 'User not found' }, 404);
    }

    // If customer, get linked customer data
    let customerData = null;
    if (user.role === 'customer') {
      const { data: customer } = await supabase
        .from('customers')
        .select('*')
        .eq('user_id', user.id)
        .single();
      customerData = customer;
    }

    return c.json({
      success: true,
      data: {
        ...profile,
        customer: customerData,
      },
    });
  } catch (error) {
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// Logout
auth.post('/logout', authMiddleware, async (c) => {
  const token = c.get('token');

  try {
    const supabase = createAuthClient(token);
    await supabase.auth.signOut();

    return c.json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error) {
    return c.json({ success: false, error: 'Failed to logout' }, 500);
  }
});

/**
 * Session Management
 */

// GET /api/auth/sessions - Get active sessions
auth.get('/sessions', authMiddleware, async (c) => {
  const user = c.get('user');

  try {
    const { data: sessions, error } = await supabaseAdmin
      .from('login_sessions')
      .select('*')
      .eq('user_id', user.id)
      .eq('is_revoked', false)
      .order('last_active_at', { ascending: false });

    if (error) throw error;

    return c.json({
      success: true,
      data: sessions || []
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// DELETE /api/auth/sessions/:id - Revoke session
auth.delete('/sessions/:id', authMiddleware, async (c) => {
  const user = c.get('user');
  const sessionId = c.req.param('id');

  try {
    const { error } = await supabaseAdmin
      .from('login_sessions')
      .update({ is_revoked: true })
      .eq('id', sessionId)
      .eq('user_id', user.id);

    if (error) throw error;

    return c.json({
      success: true,
      message: 'Session revoked successfully'
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// DELETE /api/auth/sessions/logout-all - Logout all other sessions
auth.post('/sessions/logout-all', authMiddleware, async (c) => {
  const user = c.get('user');

  try {
    // We might want to keep the current session, but since we don't have a reliable session ID 
    // linked to the JWT on the server side easily without extra middleware, we'll just allow revoking others by UI.
    // For simplicity now, revoke ALL for this user.
    const { error } = await supabaseAdmin
      .from('login_sessions')
      .update({ is_revoked: true })
      .eq('user_id', user.id)
      .eq('is_revoked', false);

    if (error) throw error;

    return c.json({
      success: true,
      message: 'All sessions revoked successfully'
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

export default auth;
