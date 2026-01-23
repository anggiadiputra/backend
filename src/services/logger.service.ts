import { supabaseAdmin } from './supabase.service';

/**
 * Audit Log Data Type
 */
export interface AuditLogData {
    user_id?: string;
    ip_address?: string;
    action: string;
    resource?: string;
    payload?: any;
    status: 'success' | 'failure';
}

/**
 * LoggerService
 * Handles centralized audit logging to the database.
 */
export class LoggerService {
    /**
     * Logs a sensitive action to the audit_logs table.
     * @param data The audit log data to save
     */
    static async logAction(data: AuditLogData) {
        try {
            const { error } = await supabaseAdmin
                .from('audit_logs')
                .insert([{
                    user_id: data.user_id,
                    ip_address: data.ip_address,
                    action: data.action,
                    resource: data.resource,
                    payload: data.payload,
                    status: data.status,
                }]);

            if (error) {
                console.error('[LoggerService] Database Error:', error.message);
            }
        } catch (error: any) {
            console.error('[LoggerService] Error logging action:', error.message);
        }
    }

    /**
     * Helper to log authentication events
     */
    static async logAuth(ip: string, action: string, status: 'success' | 'failure', details: any = {}) {
        await this.logAction({
            ip_address: ip,
            action,
            resource: 'auth',
            payload: details,
            status,
            user_id: details.user_id,
        });
    }
}
