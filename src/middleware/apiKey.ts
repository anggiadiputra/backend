import { Context, Next } from 'hono';
import { env } from '../config/env';

/**
 * API Key Authentication Middleware
 * 
 * Verifies that requests contain a valid X-API-Key header.
 * This adds an extra layer of security on top of user authentication.
 */
export async function apiKeyAuth(c: Context, next: Next) {
    console.log(`[Security] Checking API Key for ${c.req.path}`);
    const apiKey = c.req.header('X-API-Key');

    // Skip API key check for health endpoints
    const path = c.req.path;
    if (path === '/' || path === '/health' || path === '/health/redis') {
        return await next();
    }

    // Skip for documentation endpoints
    if (path === '/api/openapi.json' || path === '/api/docs') {
        return await next();
    }

    // Validate API key
    if (!apiKey || apiKey !== env.BACKEND_API_KEY) {
        console.warn(`[Security] Invalid API key attempt from path: ${path}`);
        return c.json({
            success: false,
            error: 'Unauthorized',
            message: 'Invalid or missing API key'
        }, 401);
    }

    return await next();
}
