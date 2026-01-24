import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env';

// Client for authenticated requests (uses anon key)
export const supabaseClient = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_ANON_KEY
);

// Admin client for server-side operations (uses service role key)
// Note: Service role key bypasses RLS by default
export const supabaseAdmin = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

// Create client with user's JWT token
export function createAuthClient(token: string): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });
}
