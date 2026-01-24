-- Create app_settings table for storing key-value configurations
create table if not exists public.app_settings (
  key text not null primary key,
  value jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

-- Enable RLS (though we might mostly access via service role for now)
alter table public.app_settings enable row level security;

-- Allow read access to everyone (public settings like branding need to be visible)
create policy "Allow public read access"
  on public.app_settings for select
  using (true);

-- Allow write access only to authenticated users (middleware checks role effectively, but good to have)
-- Actually, likely only sellers/admins should update.
-- For now, we rely on backend API role checks.

-- Insert default branding settings
insert into public.app_settings (key, value)
values (
  'branding',
  '{
    "logo_url": null,
    "primary_color": "#2563eb",
    "font_family": "Inter"
  }'::jsonb
) on conflict (key) do nothing;
