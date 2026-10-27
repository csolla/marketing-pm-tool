-- 01_foundation.sql
-- Milestone 1: people, campaigns, sign-in rules and profile photos.
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- People: one row per account, created automatically on first sign-in
-- ---------------------------------------------------------------------------
create table if not exists public.people (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  name text not null,
  photo_url text,
  role text not null default 'member' check (role in ('admin', 'member', 'director')),
  hours_per_day numeric(4,2) not null default 8 check (hours_per_day >= 0 and hours_per_day <= 24),
  counts_in_capacity boolean not null default true,
  holiday_calendar text not null default 'Madrid' check (holiday_calendar in ('Madrid', 'England')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Helpers used by the permission rules. security definer so they can read
-- people without looping back through the people policies.
create or replace function public.my_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.people where id = auth.uid() and active
$$;

create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = public as $$
  select public.my_role() is not null
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() = 'admin', false)
$$;

-- Admins and team members can create and edit work; directors only view
create or replace function public.can_edit_work()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('admin', 'member'), false)
$$;

-- New accounts: DSD emails only. Any other email is refused before the
-- account exists, so no sign-in link is sent. Carlota starts as admin.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.email is null or lower(new.email) not like '%@digitalsmiledesign.com' then
    raise exception 'Only @digitalsmiledesign.com emails can sign in';
  end if;

  insert into public.people (id, email, name, role)
  values (
    new.id,
    lower(new.email),
    coalesce(nullif(new.raw_user_meta_data->>'name', ''),
             initcap(replace(split_part(new.email, '@', 1), '.', ' '))),
    case when lower(new.email) = 'csolla@digitalsmiledesign.com' then 'admin' else 'member' end
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Anyone who signed in before this ran gets a people row too
insert into public.people (id, email, name, role)
select u.id, lower(u.email),
       initcap(replace(split_part(u.email, '@', 1), '.', ' ')),
       case when lower(u.email) = 'csolla@digitalsmiledesign.com' then 'admin' else 'member' end
from auth.users u
where lower(u.email) like '%@digitalsmiledesign.com'
on conflict (id) do nothing;

-- Only the admin changes roles and capacity settings. Everyone can change
-- their own name and photo. Active/inactive only through set_person_active.
create or replace function public.protect_people_cols()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Changes made in the SQL editor (no signed-in user) are allowed
  if auth.uid() is null then
    return new;
  end if;

  if new.id is distinct from old.id or new.email is distinct from old.email then
    raise exception 'Email cannot be changed';
  end if;

  if new.active is distinct from old.active
     and coalesce(current_setting('app.setting_active', true), '') <> 'on' then
    raise exception 'Use set_person_active to activate or deactivate someone';
  end if;

  if not public.is_admin()
     and (new.role is distinct from old.role
          or new.hours_per_day is distinct from old.hours_per_day
          or new.counts_in_capacity is distinct from old.counts_in_capacity
          or new.holiday_calendar is distinct from old.holiday_calendar) then
    raise exception 'Only the admin can change roles and capacity settings';
  end if;

  if old.id = auth.uid() and old.role = 'admin' and new.role <> 'admin' then
    raise exception 'You can''t remove your own admin access';
  end if;

  return new;
end $$;

drop trigger if exists protect_people_cols on public.people;
create trigger protect_people_cols
  before update on public.people
  for each row execute function public.protect_people_cols();

-- Deactivate or reactivate someone. Deactivated people are blocked from
-- signing in and signed out everywhere; their data is kept.
create or replace function public.set_person_active(person_id uuid, make_active boolean)
returns void language plpgsql security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then
    raise exception 'Only the admin can do this';
  end if;
  if person_id = auth.uid() then
    raise exception 'You can''t deactivate yourself';
  end if;

  perform set_config('app.setting_active', 'on', true);
  update public.people set active = make_active where id = person_id;
  if not found then
    raise exception 'Person not found';
  end if;
  perform set_config('app.setting_active', 'off', true);

  update auth.users
     set banned_until = case when make_active then null else now() + interval '100 years' end
   where id = person_id;
  if not make_active then
    delete from auth.sessions where user_id = person_id;
  end if;
end $$;

revoke execute on function public.set_person_active(uuid, boolean) from public, anon;
grant execute on function public.set_person_active(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Campaigns
-- ---------------------------------------------------------------------------
create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  description text,
  business_unit text not null check (business_unit in ('education', 'planning_center', 'shared')),
  start_date date,
  end_date date,
  owner_id uuid references public.people(id),
  status text not null default 'planned' check (status in ('planned', 'in_progress', 'done', 'on_hold')),
  planned_hours numeric(7,2) not null default 0 check (planned_hours >= 0),
  created_by uuid default auth.uid() references public.people(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaign_dates check (start_date is null or end_date is null or end_date >= start_date)
);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists campaigns_updated_at on public.campaigns;
create trigger campaigns_updated_at
  before update on public.campaigns
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Permission rules
-- ---------------------------------------------------------------------------
revoke all on public.people, public.campaigns from anon;
grant select, update on public.people to authenticated;
grant select, insert, update, delete on public.campaigns to authenticated;

alter table public.people enable row level security;
alter table public.campaigns enable row level security;

drop policy if exists "people: active users see everyone" on public.people;
create policy "people: active users see everyone" on public.people
  for select to authenticated using (public.is_active_user());

drop policy if exists "people: edit own row or admin" on public.people;
create policy "people: edit own row or admin" on public.people
  for update to authenticated
  using ((id = auth.uid() and public.is_active_user()) or public.is_admin())
  with check ((id = auth.uid() and public.is_active_user()) or public.is_admin());

drop policy if exists "campaigns: active users read" on public.campaigns;
create policy "campaigns: active users read" on public.campaigns
  for select to authenticated using (public.is_active_user());

drop policy if exists "campaigns: admin and members create" on public.campaigns;
create policy "campaigns: admin and members create" on public.campaigns
  for insert to authenticated with check (public.can_edit_work());

drop policy if exists "campaigns: admin and members edit" on public.campaigns;
create policy "campaigns: admin and members edit" on public.campaigns
  for update to authenticated using (public.can_edit_work()) with check (public.can_edit_work());

drop policy if exists "campaigns: admin deletes" on public.campaigns;
create policy "campaigns: admin deletes" on public.campaigns
  for delete to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Profile photos: public bucket, each person writes only to their own folder
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "avatars: see own" on storage.objects;
create policy "avatars: see own" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "avatars: upload own" on storage.objects;
create policy "avatars: upload own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars'
              and (storage.foldername(name))[1] = auth.uid()::text
              and public.is_active_user());

drop policy if exists "avatars: delete own" on storage.objects;
create policy "avatars: delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------------------------------------------------------------------------
-- Check: every column should say true
-- ---------------------------------------------------------------------------
select
  to_regclass('public.people') is not null as people_table,
  to_regclass('public.campaigns') is not null as campaigns_table,
  exists (select 1 from pg_trigger where tgname = 'on_auth_user_created') as dsd_only_signup,
  exists (select 1 from pg_trigger where tgname = 'protect_people_cols') as roles_locked,
  (select count(*) from pg_policies where schemaname = 'public' and tablename in ('people', 'campaigns')) = 6 as permission_rules,
  exists (select 1 from storage.buckets where id = 'avatars') as photo_bucket;
