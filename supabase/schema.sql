-- =====================================================================
-- MAQAM v3 — Supabase schema
-- Run this once: Supabase Dashboard -> SQL Editor -> New query -> Run
-- =====================================================================

-- 1. Application settings (mosque identity, geofence, admin password, scene thresholds)
create table if not exists public.settings (
  key   text primary key,
  value text not null
);

-- 2. Registered worshippers ("jamaah")
create table if not exists public.users (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  email       text,
  phone       text,
  photo_url   text,                          -- public URL of the face sample in Storage
  descriptors jsonb not null default '[]',   -- single averaged 128-d descriptor (array of 128 floats)
  reminders   text,
  notes       text,
  is_active   boolean not null default true,
  admin_created_by text,
  created_at  timestamptz not null default now()
);

-- 3. Attendance records
create table if not exists public.attendance (
  id                uuid primary key default gen_random_uuid(),
  member_id         uuid references public.users(id) on delete set null,
  member_name       text not null,
  prayer            text not null check (prayer in ('Subuh','Zuhur','Ashar','Maghrib','Isya')),
  date              date not null,
  timestamp         timestamptz not null default now(),
  face_dist         real,
  geo_lat           double precision,
  geo_lng           double precision,
  geo_dist          real,
  scene_ref_sim     real,
  scene_black_sim   real,
  scene_note        text,
  scene_img_path    text,
  server_ts         bigint,
  created_at        timestamptz not null default now()
);
create index if not exists idx_attendance_created on public.attendance (created_at desc);
create index if not exists idx_attendance_member on public.attendance (member_id);
create index if not exists idx_attendance_date   on public.attendance (date);

-- 4. Scene reference photos ("mosque" / "black")
create table if not exists public.scene_refs (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('mosque','black')),
  image_url  text not null,
  embedding  jsonb,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- 5. Admin users (for /api/admin + /api/setup)
create table if not exists public.admins (
  id            uuid primary key default gen_random_uuid(),
  email         text unique not null,
  password_hash text not null,
  role          text not null default 'admin',
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

-- Row Level Security: everything is accessed through the serverless functions
-- with the service_role key, so lock the tables down completely.
alter table public.settings   enable row level security;
alter table public.users      enable row level security;
alter table public.attendance enable row level security;
alter table public.scene_refs enable row level security;
alter table public.admins     enable row level security;

-- =====================================================================
-- Storage bucket: one public bucket named "maqam-faces" for face samples,
-- attendance scene shots and scene reference photos.
-- =====================================================================
insert into storage.buckets (id, name, public)
values ('maqam-faces', 'maqam-faces', true)
on conflict (id) do nothing;

-- Public read access to the face bucket
create policy "Public read maqam-faces"
  on storage.objects for select
  using (bucket_id = 'maqam-faces');

-- Insert access for the attendance scene snapshot bucket (server-side)
create policy "Service insert maqam-scenes"
  on storage.objects for insert
  with check (bucket_id = 'maqam-scenes');

-- Create the scene snapshot bucket if missing
insert into storage.buckets (id, name, public)
values ('maqam-scenes', 'maqam-scenes', true)
on conflict (id) do nothing;

-- =====================================================================
-- Admin auth RPCs (used by /api/admin.js)
-- =====================================================================

create or replace function public.admin_verify(_token text)
returns table (id uuid, email text, role text)
language plpgsql security definer
as $$
begin
  return query
  select id, email, role from public.admins where is_active and email = split_part(_token, '.', 1)::text;
end;
$$;

-- Attendance counting RPCs (used by /api/admin.js chart + standings)
create or replace function public.attendance_count_range(_date_from date, _date_to date, _days int)
returns table (date date, count bigint)
language sql security definer
as $$
  select d::date, count(a.id)::bigint
  from generate_series(_date_from, _date_to, '1 day'::interval) as g(d)
  left join public.attendance a on a.date = d::date
  group by g.d
  order by g.d;
$$;

create or replace function public.attendance_standings(_days int)
returns table (name text, count bigint, member_id uuid)
language sql security definer
as $$
  select u.name, count(a.id)::bigint, u.id
  from public.users u
  left join public.attendance a on a.member_id = u.id
    and a.date >= current_date - _days
  where u.is_active
  group by u.id, u.name
  order by count desc nulls last;
$$;
