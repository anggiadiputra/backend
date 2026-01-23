import { Context, Next } from 'hono';
import { createAuthClient, supabaseAdmin } from '../services/supabase.service';
import type { AuthUser } from '../types';

// Extend Hono context with user
declare module 'hono' {
  interface ContextVariableMap {
    user: AuthUser;
    token: string;
  }
}

export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ success: false, error: 'Missing or invalid authorization header' }, 401);
  }

  const token = authHeader.replace('Bearer ', '');

  try {
    const supabase = createAuthClient(token);
    const { data: { user }, error } = await supabase.auth.getUser();

    if (error || !user) {
      return c.json({ success: false, error: 'Invalid or expired token' }, 401);
    }

    // Get user profile from database
    let { data: profile, error: profileError } = await supabaseAdmin
      .from('users')
      .select('id, email, role')
      .eq('id', user.id)
      .single();

    // If user doesn't exist in users table, create it
    if (profileError || !profile) {
      console.log('[Auth] User not found, creating new profile for:', user.id);
      const metadata = user.user_metadata || {};
      console.log('[Auth] User metadata:', metadata);

      const newUser = {
        id: user.id,
        email: user.email,
        role: metadata.role || 'customer',
        full_name: metadata.full_name || `${metadata.first_name || ''} ${metadata.last_name || ''}`.trim() || null,
        company_name: metadata.company_name || null,
        phone: metadata.phone || null,
        address: metadata.address || null,
        city: metadata.city || null,
        country: metadata.country_code === 'ID' ? 'Indonesia' : null,
      };

      console.log('[Auth] Creating user with data:', newUser);

      const { data: createdUser, error: createError } = await supabaseAdmin
        .from('users')
        .insert(newUser)
        .select('id, email, role')
        .single();

      if (createError) {
        console.error('[Auth] Failed to create user:', createError.message, createError.details, createError.hint);
        return c.json({ success: false, error: `Failed to create user profile: ${createError.message}` }, 500);
      }

      profile = createdUser;
      console.log('[Auth] Created new user profile:', profile.id);
    }

    // Set user in context
    c.set('user', {
      id: profile.id,
      email: profile.email,
      role: profile.role,
    });
    c.set('token', token);

    await next();
  } catch (error) {
    console.error('[Auth] Authentication error:', error);
    return c.json({ success: false, error: 'Authentication failed' }, 401);
  }
}

// Middleware to check if user is seller
export async function sellerOnly(c: Context, next: Next) {
  const user = c.get('user');

  if (user.role !== 'seller') {
    return c.json({ success: false, error: 'Access denied. Seller only.' }, 403);
  }

  await next();
}

// Middleware to check if user is customer
export async function customerOnly(c: Context, next: Next) {
  const user = c.get('user');

  if (user.role !== 'customer') {
    return c.json({ success: false, error: 'Access denied. Customer only.' }, 403);
  }

  await next();
}
// Middleware to check if user is admin
export async function adminOnly(c: Context, next: Next) {
  const user = c.get('user');

  if (user.role !== 'admin' && user.role !== 'seller') {
    return c.json({ success: false, error: 'Access denied. Admin only.' }, 403);
  }

  await next();
}
