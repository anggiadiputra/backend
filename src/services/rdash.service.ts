import { env } from '../config/env';
import type { RdashCustomer, RdashDomain } from '../types';

interface RdashResponse<T> {
  success: boolean;
  data: T;
  message?: string;
}

interface RdashListResponse<T> {
  success: boolean;
  data: T[];
  meta: {
    total: number;
    page: number;
    limit: number;
    total_pages: number;
  };
}

class RdashService {
  private baseUrl: string;
  private apiKey: string;
  private resellerId: string;

  constructor() {
    this.baseUrl = env.RDASH_BASE_URL;
    this.apiKey = env.RDASH_API_KEY;
    this.resellerId = env.RDASH_RESELLER_ID;
  }

  private getHeaders(): Record<string, string> {
    const credentials = Buffer.from(`${this.resellerId}:${this.apiKey}`).toString('base64');
    return {
      'Authorization': `Basic ${credentials}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };
  }

  /**
   * Helper to perform fetch with a timeout
   */
  private async fetchWithTimeout(url: string, options: RequestInit & { timeout?: number } = {}): Promise<Response> {
    const { timeout = 30000, ...fetchOptions } = options;

    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal
      });
      clearTimeout(id);
      return response;
    } catch (error: any) {
      clearTimeout(id);
      if (error.name === 'AbortError') {
        throw new Error(`Request timed out after ${timeout}ms`);
      }
      throw error;
    }
  }

  // Customers
  async getCustomers(page = 1, limit = 10, search = ''): Promise<RdashListResponse<RdashCustomer>> {
    const params = new URLSearchParams({
      page: page.toString(),
      limit: limit.toString(),
    });
    if (search) params.append('search', search);

    const response = await this.fetchWithTimeout(`${this.baseUrl}/customers?${params}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Rdash API error: ${response.statusText}`);
    }

    return response.json() as Promise<RdashListResponse<RdashCustomer>>;
  }

  async getCustomer(customerId: number): Promise<RdashResponse<RdashCustomer>> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/customers/${customerId}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Rdash API error: ${response.statusText}`);
    }

    return response.json() as Promise<RdashResponse<RdashCustomer>>;
  }

  async updateCustomer(customerId: number, data: {
    name?: string;
    email?: string;
    organization?: string;
    street_1?: string;
    street_2?: string;
    city?: string;
    state?: string;
    country_code?: string;
    postal_code?: string;
    voice?: string;
    fax?: string;
  }): Promise<RdashResponse<RdashCustomer>> {
    // Rdash API expects form-urlencoded
    const formData = new URLSearchParams();
    if (data.name) formData.append('name', data.name);
    if (data.email) formData.append('email', data.email);
    if (data.organization) formData.append('organization', data.organization);
    if (data.street_1) formData.append('street_1', data.street_1);
    if (data.street_2) formData.append('street_2', data.street_2);
    if (data.city) formData.append('city', data.city);
    if (data.state) formData.append('state', data.state);
    if (data.country_code) formData.append('country_code', data.country_code);
    if (data.postal_code) formData.append('postal_code', data.postal_code);
    if (data.voice) formData.append('voice', data.voice.replace(/[^\d+]/g, ''));
    if (data.fax) formData.append('fax', data.fax);

    const response = await this.fetchWithTimeout(`${this.baseUrl}/customers/${customerId}`, {
      method: 'PUT',
      headers: {
        ...this.getHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    const result = await response.json() as RdashResponse<RdashCustomer>;

    if (!response.ok) {
      return {
        success: false,
        data: null as any,
        message: result.message || `Rdash API error: ${response.statusText}`,
      };
    }

    return result;
  }

  // Domains
  async getDomains(page = 1, limit = 10, customerId?: number): Promise<RdashListResponse<RdashDomain>> {
    const params = new URLSearchParams({
      page: page.toString(),
      limit: limit.toString(),
    });
    if (customerId) params.append('customer_id', customerId.toString());

    const response = await this.fetchWithTimeout(`${this.baseUrl}/domains?${params}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Rdash API error: ${response.statusText}`);
    }

    return response.json() as Promise<RdashListResponse<RdashDomain>>;
  }

  async getDomain(domainId: number): Promise<RdashResponse<RdashDomain>> {
    try {
      const response = await this.fetchWithTimeout(`${this.baseUrl}/domains/${domainId}`, {
        method: 'GET',
        headers: this.getHeaders(),
      });

      const result = await response.json() as RdashResponse<RdashDomain>;

      // Debug logging
      console.log(`[RdashService] getDomain ${domainId} raw response:`, JSON.stringify(result.data, null, 2));

      if (result.success && result.data) {
        const status = typeof result.data.status === 'string' ? result.data.status.toLowerCase() : '';
        console.log(`[RdashService] Domain ${domainId} status string: "${result.data.status}"`);
        console.log(`[RdashService] Domain ${domainId} is_locked from API: ${result.data.is_locked}`);

        // Map is_locked (API) to is_transfer_locked (Frontend)
        // We prioritze checking the status string for EPP codes which is more reliable.
        // 'clientTransferProhibited' = Theft Protection (Transfer Lock)
        const hasTransferProhibited = status.includes('clienttransferprohibited');
        result.data.is_transfer_locked = hasTransferProhibited || !!result.data.is_locked;
        console.log(`[RdashService] Domain ${domainId} clientTransferProhibited in status: ${hasTransferProhibited}, final is_transfer_locked: ${result.data.is_transfer_locked}`);

        // Map Registrar Lock (is_locked for Frontend) based on status string
        // 'clientUpdateProhibited' or 'clientDeleteProhibited' = Registrar Lock (Update Lock)
        const hasUpdateProhibited = status.includes('clientupdateprohibited') || status.includes('clientdeleteprohibited');
        result.data.is_locked = hasUpdateProhibited;
        console.log(`[RdashService] Domain ${domainId} final is_locked (Registrar Lock): ${result.data.is_locked}`);
      }

      return result;
    } catch (error: any) {
      return { success: false, data: null as any, message: error.message };
    }
  }



  async getDomainDetails(domainName: string): Promise<RdashResponse<any>> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/domains/details?domain_name=${encodeURIComponent(domainName)}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    const result = await response.json() as RdashResponse<any>;

    if (!response.ok) {
      return {
        success: false,
        data: null as any,
        message: result.message || `Rdash API error: ${response.statusText}`,
      };
    }

    return result;
  }

  // Transactions
  async getTransactions(params: {
    page?: number;
    limit?: number;
    type?: number;
    tld?: string;
    date_range?: string;
  }): Promise<RdashListResponse<unknown>> {
    const searchParams = new URLSearchParams();
    if (params.page) searchParams.append('page', params.page.toString());
    if (params.limit) searchParams.append('limit', params.limit.toString());
    if (params.type) searchParams.append('type', params.type.toString());
    if (params.tld) searchParams.append('tld', params.tld);
    if (params.date_range) searchParams.append('date_range', params.date_range);

    const response = await this.fetchWithTimeout(`${this.baseUrl}/account/transactions?${searchParams}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Rdash API error: ${response.statusText}`);
    }

    return response.json() as Promise<RdashListResponse<unknown>>;
  }

  // Pricing
  async getPricing(): Promise<RdashListResponse<unknown>> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/pricing`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Rdash API error: ${response.statusText}`);
    }

    return response.json() as Promise<RdashListResponse<unknown>>;
  }

  /**
   * Get domain extension prices (with promo support)
   */
  async getExtensionPrices(page = 1, limit = 100, promo = false, extension = ''): Promise<any> {
    const params = new URLSearchParams({
      page: page.toString(),
      limit: limit.toString(),
      promo: promo ? '1' : '0',
    });

    if (extension) {
      params.append('domainExtension[extension]', extension);
    }

    const response = await this.fetchWithTimeout(`${this.baseUrl}/account/prices?${params}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Rdash API error: ${response.statusText}`);
    }

    return response.json() as Promise<any>;
  }

  /**
   * Get all extension prices automatically handling pagination
   */
  async getAllExtensionPrices(promo = false): Promise<any[]> {
    let allPrices: any[] = [];
    let currentPage = 1;
    let totalPages = 1;

    do {
      const response = await this.getExtensionPrices(currentPage, 100, promo);
      if (response.data) {
        allPrices = allPrices.concat(response.data);
      }
      totalPages = response.meta?.last_page || 1;
      currentPage++;
    } while (currentPage <= totalPages);

    return allPrices;
  }

  // Check domain availability
  async checkDomainAvailability(domain: string): Promise<RdashResponse<{ available: boolean; premium: boolean; price?: number }>> {
    try {
      // Rdash API uses GET /domains/availability?domain=xxx&include_premium_domains=true
      const queryParams = new URLSearchParams({
        domain,
        include_premium_domains: 'true'
      });

      const url = `${this.baseUrl}/domains/availability?${queryParams.toString()}`;

      const response = await this.fetchWithTimeout(url, {
        method: 'GET',
        headers: this.getHeaders(),
      });

      const responseText = await response.text();
      let result: any;
      try { result = JSON.parse(responseText); } catch { result = { message: responseText }; }

      if (!response.ok || result.success === false) {
        return {
          success: false,
          data: { available: false, premium: false },
          message: result.message || `Rdash API error: ${response.status}`,
        };
      }

      // Rdash returns data as array of availability results
      const availabilityData = Array.isArray(result.data) ? result.data[0] : result.data;

      return {
        success: true,
        data: {
          available: availabilityData?.available ?? availabilityData?.is_available ?? false,
          premium: availabilityData?.premium ?? availabilityData?.is_premium ?? false,
          price: availabilityData?.price ?? availabilityData?.register_price,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        data: { available: false, premium: false },
        message: error?.message || 'Failed to check domain availability',
      };
    }
  }

  // Register domain
  async registerDomain(data: {
    domain: string;
    customer_id: number;
    period: number;
    whois_protection?: boolean;
  }): Promise<RdashResponse<RdashDomain>> {
    try {
      const formData = new URLSearchParams();
      formData.append('name', data.domain);
      formData.append('customer_id', data.customer_id.toString());
      formData.append('period', data.period.toString());
      if (data.whois_protection) {
        formData.append('buy_whois_protection', 'true');
      }

      const response = await this.fetchWithTimeout(`${this.baseUrl}/domains`, {
        method: 'POST',
        headers: {
          ...this.getHeaders(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString(),
      });

      const result = await response.json() as RdashResponse<RdashDomain>;

      if (!response.ok) {
        return {
          success: false,
          data: null as any,
          message: result.message || `Rdash API error: ${response.statusText}`,
        };
      }

      return result;
    } catch (error) {
      return {
        success: false,
        data: null as any,
        message: 'Failed to register domain',
      };
    }
  }

  // Transfer domain
  async transferDomain(data: {
    domain: string;
    customer_id: number;
    auth_code: string;
    period?: number;
    whois_protection?: boolean;
  }): Promise<RdashResponse<RdashDomain>> {
    try {
      const formData = new URLSearchParams();
      formData.append('domain', data.domain);
      formData.append('customer_id', data.customer_id.toString());
      formData.append('auth_code', data.auth_code);
      if (data.period) {
        formData.append('period', data.period.toString());
      }
      if (data.whois_protection) {
        formData.append('whois_protection', '1');
      }

      const response = await this.fetchWithTimeout(`${this.baseUrl}/domains/transfer`, {
        method: 'POST',
        headers: {
          ...this.getHeaders(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString(),
      });

      const result = await response.json() as RdashResponse<RdashDomain>;

      if (!response.ok) {
        return {
          success: false,
          data: null as any,
          message: result.message || `Rdash API error: ${response.statusText}`,
        };
      }

      return result;
    } catch (error) {
      return {
        success: false,
        data: null as any,
        message: 'Failed to transfer domain',
      };
    }
  }

  // Create customer
  async createCustomer(data: {
    name: string;
    email: string;
    organization?: string;
    street_1: string;
    city: string;
    state: string;
    country_code: string;
    postal_code: string;
    voice: string;
  }): Promise<RdashResponse<{ id: number }>> {
    try {
      const formData = new URLSearchParams();
      formData.append('name', data.name);
      formData.append('email', data.email);
      // Generate a random password for Rdash (customer won't use it directly)
      const randomPassword = `Pwd${Math.random().toString(36).slice(2, 10)}!${Math.floor(Math.random() * 100)}`;
      formData.append('password', randomPassword);
      formData.append('password_confirmation', randomPassword);
      // Organization is required by Rdash - use company name or default to "-"
      formData.append('organization', data.organization || '-');
      formData.append('street_1', data.street_1);
      formData.append('city', data.city);
      formData.append('state', data.state);
      formData.append('country_code', data.country_code);
      formData.append('postal_code', data.postal_code);
      // Voice must be 9-20 digits
      formData.append('voice', data.voice.replace(/[^\d+]/g, ''));

      console.log('[Rdash] Creating customer:', Object.fromEntries(formData));

      const response = await this.fetchWithTimeout(`${this.baseUrl}/customers`, {
        method: 'POST',
        headers: {
          ...this.getHeaders(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString(),
      });

      const result = await response.json() as any;
      console.log('[Rdash] Create customer response:', result);

      if (!response.ok) {
        return {
          success: false,
          data: null as any,
          message: result.message || `Rdash API error: ${response.statusText}`,
        };
      }

      // Extract customer ID from response
      const customerId = result.data?.id || result.data?.customer_id;

      if (!customerId) {
        return {
          success: false,
          data: null as any,
          message: 'Customer created but ID not returned',
        };
      }

      return {
        success: true,
        data: { id: customerId },
      };
    } catch (error) {
      return {
        success: false,
        data: null as any,
        message: 'Failed to create customer',
      };
    }
  }

  // Renew domain
  async renewDomain(data: {
    domain_id: number;
    period: number;
    current_date: string;
    whois_protection?: boolean;
  }): Promise<RdashResponse<RdashDomain>> {
    try {
      const formData = new URLSearchParams();
      formData.append('period', data.period.toString());
      formData.append('current_date', data.current_date);
      if (data.whois_protection) {
        formData.append('buy_whois_protection', 'true');
      }

      const response = await this.fetchWithTimeout(`${this.baseUrl}/domains/${data.domain_id}/renew`, {
        method: 'POST',
        headers: {
          ...this.getHeaders(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString(),
      });

      const result = await response.json() as RdashResponse<RdashDomain>;
      if (!response.ok) {
        return {
          success: false,
          data: null as any,
          message: result.message || `Rdash API error: ${response.statusText}`,
        };
      }

      return result;
    } catch (error) {
      return {
        success: false,
        data: null as any,
        message: 'Failed to renew domain',
      };
    }
  }

  // Auth Code
  async getAuthCode(domainId: number): Promise<RdashResponse<{ auth_code: string }>> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/domains/${domainId}/auth_code`, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    return response.json() as Promise<RdashResponse<{ auth_code: string }>>;
  }

  async updateAuthCode(domainId: number, authCode: string): Promise<RdashResponse<any>> {
    const formData = new URLSearchParams();
    formData.append('auth_code', authCode);
    const response = await this.fetchWithTimeout(`${this.baseUrl}/domains/${domainId}/auth_code`, {
      method: 'PUT',
      headers: {
        ...this.getHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[RdashService] updateAuthCode failed: ${response.status} ${text}`);
      try {
        return JSON.parse(text);
      } catch {
        return { success: false, data: null, message: `Rdash error: ${text}` };
      }
    }

    return response.json() as Promise<RdashResponse<any>>;
  }

  // Registrar Lock (clientUpdateProhibited, clientDeleteProhibited)
  async setRegistrarLock(domainId: number, locked: boolean, reason?: string): Promise<RdashResponse<any>> {
    try {
      const url = `${this.baseUrl}/domains/${domainId}/registrar-locked`;
      const options: any = {
        method: locked ? 'PUT' : 'DELETE',
        headers: this.getHeaders(),
      };

      if (locked) {
        const formData = new URLSearchParams();
        if (reason) formData.append('reason', reason);
        options.body = formData.toString();
        options.headers = { ...options.headers, 'Content-Type': 'application/x-www-form-urlencoded' };
      }

      const response = await this.fetchWithTimeout(url, options);
      const text = await response.text();
      let result: any;
      try {
        result = JSON.parse(text);
      } catch {
        result = { success: false, message: text || `Rdash error: ${response.status}` };
      }

      if (!response.ok) {
        if (!locked && result.message?.toLowerCase().includes('not associated')) {
          return { success: true, data: result.data, message: 'Registrar lock already disabled' };
        }
        return {
          success: false,
          data: result.data,
          message: result.message || `Rdash API error: ${response.statusText}`,
        };
      }

      return result;
    } catch (error: any) {
      console.error('[RdashService] setRegistrarLock error:', error);
      return { success: false, data: null, message: error.message };
    }
  }


  // Theft Protection (clientTransferProhibited) - Uses /locked endpoint
  async setTheftProtection(domainId: number, locked: boolean, reason?: string): Promise<RdashResponse<any>> {
    console.log(`[RdashService] setTheftProtection called: domainId=${domainId}, locked=${locked}, reason=${reason}`);
    try {
      const url = `${this.baseUrl}/domains/${domainId}/locked`;
      console.log(`[RdashService] Request URL: ${url}, Method: ${locked ? 'PUT' : 'DELETE'}`);

      const options: any = {
        method: locked ? 'PUT' : 'DELETE',
        headers: this.getHeaders(),
      };

      if (locked) {
        const formData = new URLSearchParams();
        if (reason) formData.append('reason', reason);
        options.body = formData.toString();
        options.headers = { ...options.headers, 'Content-Type': 'application/x-www-form-urlencoded' };
      }

      const response = await this.fetchWithTimeout(url, options);
      const text = await response.text();
      console.log(`[RdashService] Response status: ${response.status}, body: ${text}`);

      let result: any;
      try {
        result = JSON.parse(text);
      } catch {
        result = { success: false, message: text || `Rdash error: ${response.status}` };
      }

      if (!response.ok) {
        if (!locked && result.message?.toLowerCase().includes('not associated')) {
          return { success: true, data: result.data, message: 'Theft protection already disabled' };
        }
        if (locked && result.message?.toLowerCase().includes('already associated')) {
          return { success: true, data: result.data, message: 'Theft protection already enabled' };
        }
        return {
          success: false,
          data: result.data,
          message: result.message || `Rdash API error: ${response.statusText}`,
        };
      }
      return result;
    } catch (error: any) {
      console.error('[RdashService] setTheftProtection error:', error);
      return { success: false, data: null, message: error.message };
    }
  }

  // WHOIS Protection
  async getWhoisProtection(domainId: number): Promise<RdashResponse<any>> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/domains/${domainId}/whois-protection`, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    return response.json() as Promise<RdashResponse<any>>;
  }

  async setWhoisProtection(domainId: number, enabled: boolean): Promise<RdashResponse<any>> {
    try {
      const url = `${this.baseUrl}/domains/${domainId}/whois-protection`;
      const response = await this.fetchWithTimeout(url, {
        method: enabled ? 'PUT' : 'DELETE',
        headers: this.getHeaders(),
      });

      const text = await response.text();
      let result: any;
      try {
        result = JSON.parse(text);
      } catch {
        result = { success: false, message: text || `Rdash error: ${response.status}` };
      }

      if (!response.ok) {
        if (!enabled && result.message?.toLowerCase().includes('not associated')) {
          return { success: true, data: result.data, message: 'WHOIS protection already disabled' };
        }
        return {
          success: false,
          data: result.data,
          message: result.message || `Rdash API error: ${response.statusText}`,
        };
      }

      return result;
    } catch (error: any) {
      console.error('[RdashService] setWhoisProtection error:', error);
      return { success: false, data: null, message: error.message };
    }
  }

  // Nameservers
  async updateNameservers(domainId: number, nameservers: string[]): Promise<RdashResponse<any>> {
    const formData = new URLSearchParams();
    nameservers.forEach((ns, index) => {
      if (ns) formData.append(`nameserver[${index}]`, ns);
    });

    const response = await this.fetchWithTimeout(`${this.baseUrl}/domains/${domainId}/ns`, {
      method: 'PUT',
      headers: {
        ...this.getHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });
    return response.json() as Promise<RdashResponse<any>>;
  }

  // DNS Records
  async getDnsRecords(domainId: number): Promise<RdashResponse<any>> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/domains/${domainId}/dns`, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    return response.json() as Promise<RdashResponse<any>>;
  }

  async updateDnsRecords(domainId: number, records: Array<{ name: string, type: string, content: string, ttl: number }>): Promise<RdashResponse<any>> {
    const formData = new URLSearchParams();
    records.forEach((record, index) => {
      formData.append(`records[${index}][host]`, record.name);
      formData.append(`records[${index}][type]`, record.type);
      formData.append(`records[${index}][value]`, record.content);
      formData.append(`records[${index}][ttl]`, (record.ttl || 3600).toString());
    });

    const response = await this.fetchWithTimeout(`${this.baseUrl}/domains/${domainId}/dns`, {
      method: 'POST',
      headers: {
        ...this.getHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });
    return response.json() as Promise<RdashResponse<any>>;
  }

  async deleteDnsRecord(domainId: number, record: { name: string, type: string, content: string }): Promise<RdashResponse<any>> {
    const formData = new URLSearchParams();
    formData.append('host', record.name);
    formData.append('type', record.type);
    formData.append('value', record.content);

    const response = await this.fetchWithTimeout(`${this.baseUrl}/domains/${domainId}/dns/record`, {
      method: 'DELETE',
      headers: {
        ...this.getHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });
    return response.json() as Promise<RdashResponse<any>>;
  }

  // Child Nameservers (Hosts)
  async getHosts(domainId: number): Promise<RdashResponse<any>> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/domains/${domainId}/hosts?domain_id=${domainId}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    return response.json() as Promise<RdashResponse<any>>;
  }

  async createHost(domainId: number, data: { hostname: string, ip_address: string, customer_id?: number }): Promise<RdashResponse<any>> {
    const formData = new URLSearchParams();
    formData.append('hostname', data.hostname);
    formData.append('ip_address', data.ip_address);
    if (data.customer_id) formData.append('customer_id', data.customer_id.toString());

    const response = await this.fetchWithTimeout(`${this.baseUrl}/domains/${domainId}/hosts`, {
      method: 'POST',
      headers: {
        ...this.getHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });
    return response.json() as Promise<RdashResponse<any>>;
  }

  async updateHost(domainId: number, hostId: number, data: { hostname?: string, ip_address?: string, old_ip_address?: string }): Promise<RdashResponse<any>> {
    const formData = new URLSearchParams();
    if (data.hostname) formData.append('hostname', data.hostname);
    if (data.ip_address) formData.append('ip_address', data.ip_address);
    if (data.old_ip_address) formData.append('old_ip_address', data.old_ip_address);

    const response = await this.fetchWithTimeout(`${this.baseUrl}/domains/${domainId}/hosts/${hostId}`, {
      method: 'PUT',
      headers: {
        ...this.getHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });
    return response.json() as Promise<RdashResponse<any>>;
  }

  async deleteHost(domainId: number, hostId: number): Promise<RdashResponse<any>> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/domains/${domainId}/hosts/${hostId}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    return response.json() as Promise<RdashResponse<any>>;
  }

  // Forwarding
  async getForwarding(domainId: number): Promise<RdashResponse<any>> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/domains/${domainId}/forwarding`, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    return response.json() as Promise<RdashResponse<any>>;
  }

  async createForwarding(domainId: number, data: { from: string, to: string }): Promise<RdashResponse<any>> {
    const formData = new URLSearchParams();
    formData.append('from', data.from);
    formData.append('to', data.to);

    const response = await this.fetchWithTimeout(`${this.baseUrl}/domains/${domainId}/forwarding`, {
      method: 'POST',
      headers: {
        ...this.getHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });
    return response.json() as Promise<RdashResponse<any>>;
  }

  async deleteForwarding(domainId: number, forwardingId: number): Promise<RdashResponse<any>> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/domains/${domainId}/forwarding/${forwardingId}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    return response.json() as Promise<RdashResponse<any>>;
  }

  // DNSSEC
  async setDnssec(domainId: number, enabled: boolean): Promise<RdashResponse<any>> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/domains/${domainId}/dns/sec`, {
      method: enabled ? 'POST' : 'DELETE',
      headers: this.getHeaders(),
    });
    return response.json() as Promise<RdashResponse<any>>;
  }

  // WHOIS raw
  async whoisLookup(domain: string): Promise<RdashResponse<any>> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/domains/whois?domain=${encodeURIComponent(domain)}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    return response.json() as Promise<RdashResponse<any>>;
  }
}


export const rdashService = new RdashService();
