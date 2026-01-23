import { config } from 'dotenv';
config();

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const RDASH_API_KEY = process.env.RDASH_API_KEY!;
const RDASH_RESELLER_ID = process.env.RDASH_RESELLER_ID!;
const RDASH_BASE_URL = process.env.RDASH_BASE_URL!;

// Seller ID from users table
const SELLER_ID = 'f404050f-d55b-449a-8cce-cc43f0ec4dff';

async function fetchRdash(endpoint: string) {
  const response = await fetch(`${RDASH_BASE_URL}${endpoint}`, {
    headers: {
      'Authorization': `Bearer ${RDASH_API_KEY}`,
      'X-RESELLER-ID': RDASH_RESELLER_ID,
      'Accept': 'application/json',
    },
  });
  return response.json();
}

async function syncCustomers() {
  console.log('Syncing customers...');
  const data = await fetchRdash('/customers?limit=100');
  
  for (const customer of data.data || []) {
    const { error } = await supabase.from('customers').upsert({
      id: customer.id,
      seller_id: SELLER_ID,
      name: customer.name,
      email: customer.email,
      organization: customer.organization,
      street_1: customer.street_1,
      city: customer.city,
      state: customer.state,
      country: customer.country,
      country_code: customer.country_code,
      postal_code: customer.postal_code,
      voice: customer.voice,
      rdash_created_at: customer.created_at,
      rdash_updated_at: customer.updated_at,
      synced_at: new Date().toISOString(),
    }, { onConflict: 'id' });
    
    if (error) console.error(`Error syncing customer ${customer.id}:`, error);
    else console.log(`Synced customer: ${customer.name}`);
  }
}

async function syncDomains() {
  console.log('Syncing domains...');
  
  // Get all customers first
  const { data: customers } = await supabase.from('customers').select('id');
  
  for (const customer of customers || []) {
    const data = await fetchRdash(`/domains?customer_id=${customer.id}&limit=100`);
    
    for (const domain of data.data || []) {
      const { error } = await supabase.from('rdash_domains').upsert({
        id: domain.id,
        seller_id: SELLER_ID,
        customer_id: customer.id,
        name: domain.name,
        status: domain.status,
        status_label: domain.status_label,
        expired_at: domain.expired_at,
        nameserver_1: domain.nameserver_1,
        nameserver_2: domain.nameserver_2,
        nameserver_3: domain.nameserver_3,
        nameserver_4: domain.nameserver_4,
        nameserver_5: domain.nameserver_5,
        is_premium: domain.is_premium === 1,
        is_locked: domain.is_locked === 1,
        rdash_created_at: domain.created_at,
        synced_at: new Date().toISOString(),
      }, { onConflict: 'id' });
      
      if (error) console.error(`Error syncing domain ${domain.name}:`, error);
      else console.log(`Synced domain: ${domain.name} (customer: ${customer.id})`);
    }
  }
}

async function main() {
  try {
    await syncCustomers();
    await syncDomains();
    console.log('Sync complete!');
  } catch (error) {
    console.error('Sync failed:', error);
  }
}

main();
