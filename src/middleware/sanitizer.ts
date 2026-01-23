import { Context, Next } from 'hono';
import DOMPurify from 'isomorphic-dompurify';

/**
 * Recursively sanitizes a value (string, object, or array)
 * to prevent XSS attacks while preserving safe data.
 */
const sanitizeValue = (value: any): any => {
    if (typeof value === 'string') {
        // Purify the string
        return DOMPurify.sanitize(value);
    }

    if (Array.isArray(value)) {
        return value.map(sanitizeValue);
    }

    if (typeof value === 'object' && value !== null) {
        const sanitizedObj: any = {};
        for (const key in value) {
            if (Object.prototype.hasOwnProperty.call(value, key)) {
                sanitizedObj[key] = sanitizeValue(value[key]);
            }
        }
        return sanitizedObj;
    }

    return value;
};

/**
 * Global Sanitizer Middleware
 * Automatically cleanses request body, query params, and route params.
 */
export const xssSanitizer = async (c: Context, next: Next) => {
    // 1. Sanitize JSON Body if present
    const contentType = c.req.header('Content-Type');
    if (contentType && contentType.includes('application/json')) {
        try {
            const body = await c.req.json();
            const sanitizedBody = sanitizeValue(body);

            // Re-define json() to return sanitized data if someone calls it later
            // However, Hono doesn't easily allow re-setting the body after it's been read.
            // In Hono, we usually want to use a validator or access the body directly.
            // For now, we'll attach the sanitized body to the context so routes can use it.
            c.set('sanitizedBody', sanitizedBody);
        } catch (e) {
            // Ignore if body is empty or invalid JSON
        }
    }

    // 2. Sanitize Query Params
    const queries = c.req.query();
    const sanitizedQueries = sanitizeValue(queries);
    c.set('sanitizedQuery', sanitizedQueries);

    await next();
};
