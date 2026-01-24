import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { authMiddleware, sellerOnly } from '../middleware/auth';
import { SettingService } from '../services/setting.service';

const settings = new Hono();

// Get settings by key (Public or Protected depending on key?)
// Branding should be public potentially, but for now we just make an endpoint.
// Let's make a public endpoint for branding, and protected for management.
settings.get('/public/:key', async (c) => {
    const key = c.req.param('key');
    // Allowlist keys for public access if needed
    if (!['branding'].includes(key)) {
        return c.json({ success: false, error: 'Access denied' }, 403);
    }

    try {
        const value = await SettingService.getSettings(key);
        return c.json({ success: true, data: value || {} });
    } catch (error: any) {
        return c.json({ success: false, error: error.message }, 500);
    }
});

// Get settings (Protected - Seller)
settings.get('/:key', authMiddleware, sellerOnly, async (c) => {
    const key = c.req.param('key');
    try {
        const value = await SettingService.getSettings(key);
        return c.json({ success: true, data: value || {} });
    } catch (error: any) {
        return c.json({ success: false, error: error.message }, 500);
    }
});

// Update settings (Protected - Seller)
const updateSettingsSchema = z.object({
    value: z.any()
});

settings.put('/:key', authMiddleware, sellerOnly, async (c) => {
    const key = c.req.param('key');
    try {
        const body = await c.req.json();
        const result = await SettingService.updateSettings(key, body.value || body); // Handle {value: ...} or direct body
        return c.json({ success: true, data: result });
    } catch (error: any) {
        return c.json({ success: false, error: error.message }, 500);
    }
});

// Upload file (Proptected - Seller)
settings.post('/upload', authMiddleware, sellerOnly, async (c) => {
    try {
        const body = await c.req.parseBody();
        const file = body['file'];

        if (!(file instanceof File)) {
            return c.json({ success: false, error: 'No file uploaded' }, 400);
        }

        const buffer = await file.arrayBuffer();
        const timestamp = Date.now();
        const extension = file.name.split('.').pop();
        const fileName = `uploads/${timestamp}_${Math.random().toString(36).substring(7)}.${extension}`;

        const publicUrl = await SettingService.uploadFile(
            buffer,
            fileName,
            file.type
        );

        return c.json({
            success: true,
            data: {
                url: publicUrl,
                fileName,
                type: file.type
            }
        });
    } catch (error: any) {
        console.error('Upload Error:', error);
        return c.json({ success: false, error: error.message }, 500);
    }
});

export default settings;
