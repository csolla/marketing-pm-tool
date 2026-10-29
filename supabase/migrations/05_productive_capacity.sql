-- 05_productive_capacity.sql
-- Productive time (default 80%), working days per person, and automatic
-- monthly budgets: a budget row now only holds manual overrides.
-- Safe to run more than once.

-- Team settings: share of working time that is productive, and how
-- productive hours divide between the units for budgets
alter table public.team_settings
  add column if not exists productive_pct integer not null default 80
    check (productive_pct between 0 and 100),
  add column if not exists budget_split_education integer not null default 70
    check (budget_split_education between 0 and 100);

-- Working days per person: 1 = Monday ... 7 = Sunday
alter table public.people
  add column if not exists working_days smallint[] not null default '{1,2,3,4,5}';

alter table public.people drop constraint if exists people_working_days_check;
alter table public.people add constraint people_working_days_check
  check (working_days <@ array[1,2,3,4,5,6,7]::smallint[]);

-- Only the admin changes working days (adds working_days to the 01 rules)
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
          or new.holiday_calendar is distinct from old.holiday_calendar
          or new.working_days is distinct from old.working_days) then
    raise exception 'Only the admin can change roles and capacity settings';
  end if;

  if old.id = auth.uid() and old.role = 'admin' and new.role <> 'admin' then
    raise exception 'You can''t remove your own admin access';
  end if;

  return new;
end $$;

-- Budgets: an empty value means "automatic, from productive capacity"
alter table public.monthly_budgets alter column education_hours drop not null;
alter table public.monthly_budgets alter column education_hours drop default;
alter table public.monthly_budgets alter column planning_center_hours drop not null;
alter table public.monthly_budgets alter column planning_center_hours drop default;

-- Check: every column should say true
select
  (select productive_pct from public.team_settings) = 80 as productive_80,
  (select budget_split_education from public.team_settings) = 70 as budget_split_70,
  exists (select 1 from information_schema.columns
          where table_name = 'people' and column_name = 'working_days') as working_days,
  pg_get_functiondef('public.protect_people_cols'::regproc) like '%working_days%' as working_days_locked,
  (select is_nullable from information_schema.columns
    where table_name = 'monthly_budgets' and column_name = 'education_hours') = 'YES' as budgets_optional,
  (select count(*) from public.monthly_budgets) as manual_budget_rows;
