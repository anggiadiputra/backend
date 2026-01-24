// User types
export interface User {
  id: string;
  email: string;
  role: 'admin' | 'seller' | 'customer';
  full_name: string | null;
  company_name: string | null;
  phone: string | null;
  margin: number;
  created_at: string;
  updated_at: string;
}

// Customer types
export interface Customer {
  id: number;
  seller_id: string;
  user_id: string | null;
  name: string;
  email: string;
  organization: string | null;
  street_1: string;
  street_2: string | null;
  city: string;
  state: string;
  country_code: string;
  postal_code: string;
  voice: string;
  fax: string | null;
  is_2fa_enabled: boolean;
  created_at: string;
  updated_at: string;
  synced_at: string;
}

// Domain types
export interface Domain {
  id: number;
  seller_id: string;
  customer_id: number | null;
  name: string;
  status: string;
  status_label: string | null;
  expired_at: string;
  nameserver_1: string | null;
  nameserver_2: string | null;
  nameserver_3: string | null;
  nameserver_4: string | null;
  nameserver_5: string | null;
  is_premium: boolean;
  is_locked: boolean;
  created_at: string;
  updated_at: string;
  synced_at: string;
}

// API Response types
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  total: number;
  page: number;
  totalPages: number;
  limit: number;
}

// Rdash API types
export interface RdashCustomer {
  id: number;
  name: string;
  email: string;
  organization: string;
  street_1: string;
  street_2: string | null;
  city: string;
  state: string;
  country: string;
  country_code: string;
  postal_code: string;
  voice: string;
  fax: string | null;
  is_2fa_enabled: boolean;
  created_at: string;
  updated_at: string;
  domains?: RdashDomain[];
}

export interface RdashDomain {
  id: number;
  name: string;
  status: string;
  status_label: string;
  expired_at: string;
  customer_id?: number;
  nameserver_1: string | null;
  nameserver_2: string | null;
  nameserver_3: string | null;
  nameserver_4: string | null;
  nameserver_5: string | null;
  is_premium: boolean;
  is_locked: boolean;
  created_at: string;
  updated_at: string;
}

// Auth types
export interface AuthUser {
  id: string;
  email: string;
  role: 'admin' | 'seller' | 'customer';
}
