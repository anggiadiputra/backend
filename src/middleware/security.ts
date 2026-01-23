import { Context, Next } from 'hono';
import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';
import { secureHeaders } from 'hono/secure-headers';
import Redis from 'ioredis';
import { env } from '../config/env';

// 1. Redis & Rate Limiter Configuration
let globalRateLimiter: RateLimiterMemory | RateLimiterRedis;
let strictRateLimiter: RateLimiterMemory | RateLimiterRedis;
let authRateLimiter: RateLimiterMemory | RateLimiterRedis;
let isUsingRedis = false;
let redisClient: Redis | null = null;

const VIOLATION_THRESHOLD = 5;
const BAN_DURATION = 60 * 60 * 24; // 24 hours in seconds

if (env.REDIS_URL) {
    try {
        redisClient = new Redis(env.REDIS_URL, {
            enableOfflineQueue: false,
            maxRetriesPerRequest: 3,
        });

        redisClient.on('error', (err) => {
            console.error('[Redis] Rate Limiter Redis Error:', err.message);
        });

        redisClient.on('connect', () => {
            console.log('✅ [Redis] Rate Limiter connected to Redis');
        });

        globalRateLimiter = new RateLimiterRedis({
            storeClient: redisClient,
            keyPrefix: 'global_limit',
            points: 300,
            duration: 60,
        });

        strictRateLimiter = new RateLimiterRedis({
            storeClient: redisClient,
            keyPrefix: 'strict_limit',
            points: 20,
            duration: 60,
        });

        authRateLimiter = new RateLimiterRedis({
            storeClient: redisClient,
            keyPrefix: 'auth_limit',
            points: 10,
            duration: 60,
        });

        isUsingRedis = true;
    } catch (error: any) {
        console.error('❌ [Redis] Failed to initialize Redis Rate Limiter:', error.message);
        // Fallback to memory set below in the 'else' logic or as a safety
    }
}

// Fallback to Memory if Redis failed or wasn't configured
if (!isUsingRedis) {
    console.log('⚠️ [RateLimiter] Using Memory for Rate Limiting');
    globalRateLimiter = new RateLimiterMemory({ points: 300, duration: 60 });
    strictRateLimiter = new RateLimiterMemory({ points: 20, duration: 60 });
    authRateLimiter = new RateLimiterMemory({ points: 10, duration: 60 });
}

// Helper to get client IP with multi-proxy support
export const getClientIp = (c: Context): string => {
    // Cloudflare IP
    const cfIp = c.req.header('cf-connecting-ip');
    if (cfIp) return cfIp;

    // Real IP (Nginx etc)
    const realIp = c.req.header('x-real-ip');
    if (realIp) return realIp;

    // Standard Forwarded For
    const forwarded = c.req.header('x-forwarded-for');
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }

    // Default
    return '127.0.0.1';
};

/**
 * Tracks and manages IP violations for blacklisting.
 */
const handleViolation = async (ip: string) => {
    if (!isUsingRedis || !redisClient) return;

    try {
        const violationKey = `violation_count:${ip}`;
        const count = await redisClient.incr(violationKey);

        // Expire violation counter after 1 hour of no new violations
        if (count === 1) {
            await redisClient.expire(violationKey, 3600);
        }

        if (count >= VIOLATION_THRESHOLD) {
            console.warn(`[Security] IP ${ip} has reached violation threshold (${count}). BANNING for 24h.`);
            await redisClient.setex(`blacklist:${ip}`, BAN_DURATION, 'banned');
            await redisClient.del(violationKey); // Reset violation counter after banning
        }
    } catch (err) {
        console.error('[Security] Failed to track violation:', err);
    }
};

// 2. Middleware Functions

/**
 * Middleware to check if an IP is blacklisted.
 * Should be the first security middleware in the chain.
 */
export const checkBlacklist = async (c: Context, next: Next) => {
    if (!isUsingRedis || !redisClient) return await next();

    const ip = getClientIp(c);
    try {
        const isBlacklisted = await redisClient.get(`blacklist:${ip}`);
        if (isBlacklisted) {
            console.warn(`[Security] Blacklisted request attempted from IP: ${ip}`);
            return c.json({
                success: false,
                error: 'Forbidden',
                message: 'Your IP is temporarily blacklisted due to repeated security violations.'
            }, 403);
        }
    } catch (err) {
        console.error('[Security] Blacklist check error:', err);
    }
    return await next();
};

export const globalLimiter = async (c: Context, next: Next) => {
    const ip = getClientIp(c);
    try {
        await globalRateLimiter.consume(ip);
        return await next();
    } catch (rej: any) {
        console.warn(`[GlobalLimiter] Blocked IP: ${ip}`);
        return c.json({
            success: false,
            error: 'Too Many Requests',
            message: 'Global rate limit exceeded.'
        }, 429);
    }
};

export const strictLimiter = async (c: Context, next: Next) => {
    const ip = getClientIp(c);
    const mode = isUsingRedis ? 'Redis' : 'Memory';

    try {
        const res = await strictRateLimiter.consume(ip);
        console.log(`[StrictLimiter][${mode}] IP: ${ip} | Points: 20 | Remaining: ${res.remainingPoints}`);
        return await next();
    } catch (rej: any) {
        console.warn(`[StrictLimiter][${mode}] BLOCKED IP: ${ip} | Points Exceeded`);
        // Track violation for potential blacklisting
        await handleViolation(ip);

        return c.json({
            success: false,
            error: 'Too Many Requests',
            message: 'Rate limit exceeded for this action. Please wait a moment.'
        }, 429);
    }
};

export const authLimiter = async (c: Context, next: Next) => {
    const ip = getClientIp(c);
    try {
        await authRateLimiter.consume(ip);
        return await next();
    } catch (rej: any) {
        console.warn(`[AuthLimiter] Blocked IP: ${ip}`);
        // Auth violations are particularly critical
        await handleViolation(ip);

        return c.json({
            success: false,
            error: 'Too Many Requests',
            message: 'Too many login attempts.'
        }, 429);
    }
};

export const securityHeaders = secureHeaders({
    xFrameOptions: 'SAMEORIGIN',
    xXssProtection: '1; mode=block',
    xContentTypeOptions: 'nosniff',
    referrerPolicy: 'strict-origin-when-cross-origin',
    strictTransportSecurity: 'max-age=31536000; includeSubDomains; preload',
});

/**
 * Middleware to remove X-Powered-By header
 */
export const removePoweredBy = async (c: Context, next: Next) => {
    await next();
    c.res.headers.delete('X-Powered-By');
};
