import { supabaseAdmin } from './supabase.service';
import { env } from '../config/env';

export class SettingService {
    /**
     * Get settings by key
     */
    static async getSettings(key: string) {
        try {
            const { data, error } = await supabaseAdmin
                .from('app_settings')
                .select('value')
                .eq('key', key)
                .single();

            if (error) {
                // If not found, return null or default
                if (error.code === 'PGRST116') return null;
                throw error;
            }

            return data?.value;
        } catch (error: any) {
            console.error(`[SettingService] Error fetching ${key}:`, error.message);
            throw new Error(`Failed to fetch settings: ${error.message}`);
        }
    }

    /**
     * Update settings by key
     */
    static async updateSettings(key: string, value: any) {
        try {
            const { data, error } = await supabaseAdmin
                .from('app_settings')
                .upsert({
                    key,
                    value,
                    updated_at: new Date().toISOString()
                })
                .select()
                .single();

            if (error) throw error;

            return data?.value;
        } catch (error: any) {
            console.error(`[SettingService] Error updating ${key}:`, error.message);
            throw new Error(`Failed to update settings: ${error.message}`);
        }
    }

    /**
     * Upload file to Supabase Storage
     * @param fileBuffer Buffer or ArrayBuffer
     * @param fileName Path in bucket
     * @param contentType MIME type
     * @param bucket Bucket name (default: 'assets')
     */
    static async uploadFile(
        fileBuffer: ArrayBuffer | Buffer,
        fileName: string,
        contentType: string,
        bucket: string = 'assets'
    ) {
        try {
            // Ensure bucket exists (optional, or assume it exists)
            // For now, we assume 'assets' bucket exists and is public

            const { data, error } = await supabaseAdmin
                .storage
                .from(bucket)
                .upload(fileName, fileBuffer, {
                    contentType,
                    upsert: true
                });

            if (error) throw error;

            // Get public URL
            const { data: { publicUrl } } = supabaseAdmin
                .storage
                .from(bucket)
                .getPublicUrl(fileName);

            return publicUrl;
        } catch (error: any) {
            console.error(`[SettingService] Error uploading file:`, error.message);
            throw new Error(`Failed to upload file: ${error.message}`);
        }
    }
}
