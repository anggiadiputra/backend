-- Create payment_methods table for caching Duitku payment methods
-- Run this in Supabase SQL Editor: https://supabase.com/dashboard/project/whhlqegovvtfcztzqhpx/sql

CREATE TABLE IF NOT EXISTS payment_methods (
  id SERIAL PRIMARY KEY,
  code VARCHAR(20) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  image_url TEXT,
  fee INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add index for faster lookup
CREATE INDEX IF NOT EXISTS idx_payment_methods_is_active ON payment_methods(is_active);
CREATE INDEX IF NOT EXISTS idx_payment_methods_code ON payment_methods(code);

-- Enable RLS but allow public read access
ALTER TABLE payment_methods ENABLE ROW LEVEL SECURITY;

-- Policy: Anyone can read active payment methods
CREATE POLICY "Allow public read access to active payment methods" 
  ON payment_methods 
  FOR SELECT 
  USING (is_active = true);

-- Policy: Service role can do everything
CREATE POLICY "Service role has full access" 
  ON payment_methods 
  FOR ALL 
  USING (auth.role() = 'service_role');
