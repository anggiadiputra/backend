import { config } from 'dotenv';
import { z } from 'zod';

// Load .env file
config();

const envSchema = z.object({
  PORT: z.string().default('3000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Rdash
  RDASH_API_KEY: z.string().min(1),
  RDASH_RESELLER_ID: z.string().min(1),
  RDASH_BASE_URL: z.string().url().default('https://api.rdash.id/v1'),

  // Seller
  SELLER_ID: z.string().uuid().default('f404050f-d55b-449a-8cce-cc43f0ec4dff'),

  // Duitku
  DUITKU_MERCHANT_CODE: z.string().min(1),
  DUITKU_API_KEY: z.string().min(1),
  DUITKU_BASE_URL: z.string().url().default(
    process.env.NODE_ENV === 'production'
      ? 'https://passport.duitku.com/webapi/api/merchant'
      : 'https://sandbox.duitku.com/webapi/api/merchant'
  ),

  // Fonnte
  FONNTE_TOKEN: z.string().min(1).default('TOKEN_NOT_SET'),

  // SMTP
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.string().default('587'),
  SMTP_USERNAME: z.string().min(1),
  SMTP_PASSWORD: z.string().min(1),
  SMTP_FROM_EMAIL: z.string().email(),
  SMTP_FROM_NAME: z.string().default('One Team Digital'),

  // Frontend & Backend
  FRONTEND_URL: z.string().url().default('https://my.oneteam.co.id'),
  BACKEND_URL: z.string().url().default('http://localhost:3000'),

  // CORS
  CORS_ORIGINS: z.string().default('http://localhost:5173,https://my.oneteam.co.id'),

  // Redis
  REDIS_URL: z.string().optional(),

  // API Key for backend security
  BACKEND_API_KEY: z.string().min(32),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('❌ Invalid environment variables:');
    console.error(result.error.format());
    process.exit(1);
  }

  return result.data;
}

export const env = loadEnv();
