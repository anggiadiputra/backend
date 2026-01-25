import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { authMiddleware } from '../middleware/auth';
import { createAuthClient, supabaseAdmin } from '../services/supabase.service';
import { LoggerService } from '../services/logger.service';
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

    if (!data.session) {
      await LoggerService.logAuth(getClientIp(c), 'verify_otp', 'failure', { email, error: 'No session created' });
      return c.json({ success: false, error: 'No session created' }, 400);
    }

    // Get or create user profile
    let { data: profile } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', data.user?.id)
      .single();

    // Auto-create user if not exists
    if (!profile && data.user) {
      const { data: newUser, error: createError } = await supabaseAdmin
        .from('users')
        .insert({
          id: data.user.id,
          email: data.user.email,
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
      user_id: data.user?.id,
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
          user_id: data.user?.id,
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
          id: data.user?.id,
          email: data.user?.email,
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
