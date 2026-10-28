-- 03_time.sql
-- Milestone 3: time entries, timers, the Shared split and hours totals.
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- Team settings (one row): how Shared hours split between the two units
-- ---------------------------------------------------------------------------
create table if not exists public.team_settings (
  id boolean primary key default true check (id),
  shared_split_education integer not null default 70 check (shared_split_education between 0 and 100),
  updated_at timestamptz not null default now()
);
insert into public.team_settings (id) values (true) on conflict (id) do nothing;

drop trigger if exists team_settings_updated_at on public.team_settings;
create trigger team_settings_updated_at
  before update on public.team_settings
  for each row execute function public.touch_updated_at();

revoke all on public.team_settings from anon;
grant select, update on public.team_settings to authenticated;
alter table public.team_settings enable row level security;

drop policy if exists "team settings: active users read" on public.team_settings;
create policy "team settings: active users read" on public.team_settings
  for select to authenticated using (public.is_active_user());

drop policy if exists "team settings: admin edits" on public.team_settings;
create policy "team settings: admin edits" on public.team_settings
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- Time entries. One row per entry; Shared hours are split behind the scenes
-- into education_hours and planning_center_hours.
-- ---------------------------------------------------------------------------
create table if not exists public.time_entries (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null default auth.uid() references public.people(id),
  entry_date date not null,
  minutes integer not null check (minutes > 0 and minutes <= 1440),
  note text,
  -- No campaign = Internal time. Hours block deleting their campaign or task.
  campaign_id uuid references public.campaigns(id) on delete restrict,
  task_id uuid references public.tasks(id) on delete restrict,
  -- Set by the trigger below, from the campaign
  business_unit text not null default 'internal'
    check (business_unit in ('education', 'planning_center', 'shared', 'internal')),
  education_share numeric(5,4) check (education_share between 0 and 1),
  hours numeric(8,4) generated always as (minutes / 60.0) stored,
  education_hours numeric(8,4) generated always as (
    case when business_unit = 'internal' then 0 else round(minutes / 60.0 * education_share, 4) end) stored,
  planning_center_hours numeric(8,4) generated always as (
    case when business_unit = 'internal' then 0 else round(minutes / 60.0 * (1 - education_share), 4) end) stored,
  internal_hours numeric(8,4) generated always as (
    case when business_unit = 'internal' then minutes / 60.0 else 0 end) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists time_entries_person_date_idx on public.time_entries (person_id, entry_date);
create index if not exists time_entries_campaign_idx on public.time_entries (campaign_id);
create index if not exists time_entries_task_idx on public.time_entries (task_id);

-- Works out the business unit and split for each entry. Entries that are
-- already Shared keep the split they were saved with.
create or replace function public.set_time_entry_unit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  campaign_unit text;
  task_campaign uuid;
  split numeric;
begin
  if new.campaign_id is null then
    if new.task_id is not null then
      raise exception 'Internal time can''t be logged on a task';
    end if;
    new.business_unit := 'internal';
    new.education_share := null;
  else
    select business_unit into campaign_unit from public.campaigns where id = new.campaign_id;
    if new.task_id is not null then
      select campaign_id into task_campaign from public.tasks where id = new.task_id;
      if task_campaign is distinct from new.campaign_id then
        raise exception 'That task belongs to a different campaign';
      end if;
    end if;

    if campaign_unit = 'shared' then
      if tg_op = 'UPDATE' and old.business_unit = 'shared' and old.education_share is not null then
        new.education_share := old.education_share;
      else
        select shared_split_education / 100.0 into split from public.team_settings limit 1;
        new.education_share := coalesce(split, 0.7);
      end if;
    elsif campaign_unit = 'education' then
      new.education_share := 1;
    else
      new.education_share := 0;
    end if;
    new.business_unit := campaign_unit;
  end if;

  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  return new;
end $$;

drop trigger if exists set_time_entry_unit on public.time_entries;
create trigger set_time_entry_unit
  before insert or update on public.time_entries
  for each row execute function public.set_time_entry_unit();

-- When a campaign's business unit changes, its entries follow
create or replace function public.campaign_unit_changed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.time_entries set business_unit = business_unit where campaign_id = new.id;
  return new;
end $$;

drop trigger if exists campaign_unit_changed on public.campaigns;
create trigger campaign_unit_changed
  after update of business_unit on public.campaigns
  for each row when (old.business_unit is distinct from new.business_unit)
  execute function public.campaign_unit_changed();

revoke all on public.time_entries from anon;
grant select, insert, update, delete on public.time_entries to authenticated;
alter table public.time_entries enable row level security;

-- Everyone on the team can see everyone's hours; you change your own,
-- the admin changes anyone's; directors only read
drop policy if exists "time: active users read" on public.time_entries;
create policy "time: active users read" on public.time_entries
  for select to authenticated using (public.is_active_user());

drop policy if exists "time: own or admin create" on public.time_entries;
create policy "time: own or admin create" on public.time_entries
  for insert to authenticated
  with check ((person_id = auth.uid() and public.can_edit_work()) or public.is_admin());

drop policy if exists "time: own or admin edit" on public.time_entries;
create policy "time: own or admin edit" on public.time_entries
  for update to authenticated
  using ((person_id = auth.uid() and public.can_edit_work()) or public.is_admin())
  with check ((person_id = auth.uid() and public.can_edit_work()) or public.is_admin());

drop policy if exists "time: own or admin delete" on public.time_entries;
create policy "time: own or admin delete" on public.time_entries
  for delete to authenticated
  using ((person_id = auth.uid() and public.can_edit_work()) or public.is_admin());

-- ---------------------------------------------------------------------------
-- Timers: at most one running per person, kept in the database so it
-- survives closing the browser
-- ---------------------------------------------------------------------------
create table if not exists public.timers (
  person_id uuid primary key default auth.uid() references public.people(id) on delete cascade,
  started_at timestamptz not null default now(),
  campaign_id uuid references public.campaigns(id) on delete set null,
  task_id uuid references public.tasks(id) on delete set null
);

revoke all on public.timers from anon;
grant select, insert, update, delete on public.timers to authenticated;
alter table public.timers enable row level security;

drop policy if exists "timers: own only" on public.timers;
create policy "timers: own only" on public.timers
  for all to authenticated
  using (person_id = auth.uid() and public.can_edit_work())
  with check (person_id = auth.uid() and public.can_edit_work());

-- ---------------------------------------------------------------------------
-- Totals per campaign and per task (follow the same permission rules)
-- ---------------------------------------------------------------------------
create or replace view public.campaign_hours with (security_invoker = true) as
  select campaign_id,
         sum(hours) as hours,
         sum(education_hours) as education_hours,
         sum(planning_center_hours) as planning_center_hours
  from public.time_entries
  where campaign_id is not null
  group by campaign_id;

create or replace view public.task_hours with (security_invoker = true) as
  select task_id, sum(hours) as hours
  from public.time_entries
  where task_id is not null
  group by task_id;

revoke all on public.campaign_hours, public.task_hours from anon;
grant select on public.campaign_hours, public.task_hours to authenticated;

-- ---------------------------------------------------------------------------
-- Live updates
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['time_entries', 'timers'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- Check: every column should say true
select
  (select shared_split_education from public.team_settings) = 70 as shared_split_70,
  to_regclass('public.time_entries') is not null as time_entries_table,
  exists (select 1 from pg_trigger where tgname = 'set_time_entry_unit') as split_rules,
  to_regclass('public.timers') is not null as timers_table,
  to_regclass('public.campaign_hours') is not null and to_regclass('public.task_hours') is not null as totals,
  (select count(*) from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename in ('time_entries', 'timers')) = 2 as live_updates;
