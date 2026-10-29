-- 04_capacity.sql
-- Milestone 4: monthly budgets, bank holidays, time off and monthly hours.
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- Monthly budgets: hours Marketing can give each business unit per month
-- ---------------------------------------------------------------------------
create table if not exists public.monthly_budgets (
  month date primary key check (extract(day from month) = 1),
  education_hours numeric(7,2) not null default 0 check (education_hours >= 0),
  planning_center_hours numeric(7,2) not null default 0 check (planning_center_hours >= 0),
  updated_at timestamptz not null default now()
);

drop trigger if exists monthly_budgets_updated_at on public.monthly_budgets;
create trigger monthly_budgets_updated_at
  before update on public.monthly_budgets
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Bank holidays per calendar (Madrid or England)
-- ---------------------------------------------------------------------------
create table if not exists public.bank_holidays (
  id uuid primary key default gen_random_uuid(),
  calendar text not null check (calendar in ('Madrid', 'England')),
  date date not null,
  name text not null check (length(trim(name)) > 0),
  unique (calendar, date)
);

-- Preloaded: the rest of 2026 and all of 2027.
-- England: GOV.UK bank holidays (England and Wales).
-- Madrid: Comunidad de Madrid (Decreto 82/2026, BOCM 1 October 2026) plus
-- the city of Madrid's two local days. Days on a weekend are listed but
-- don't change anyone's capacity.
insert into public.bank_holidays (calendar, date, name) values
  ('England', '2026-12-25', 'Christmas Day'),
  ('England', '2026-12-28', 'Boxing Day (substitute day)'),
  ('England', '2027-01-01', 'New Year''s Day'),
  ('England', '2027-03-26', 'Good Friday'),
  ('England', '2027-03-29', 'Easter Monday'),
  ('England', '2027-05-03', 'Early May bank holiday'),
  ('England', '2027-05-31', 'Spring bank holiday'),
  ('England', '2027-08-30', 'Summer bank holiday'),
  ('England', '2027-12-27', 'Christmas Day (substitute day)'),
  ('England', '2027-12-28', 'Boxing Day (substitute day)'),
  ('Madrid', '2026-11-02', 'Todos los Santos (moved from Sunday)'),
  ('Madrid', '2026-11-09', 'Nuestra Señora de la Almudena (Madrid city)'),
  ('Madrid', '2026-12-07', 'Día de la Constitución (moved from Sunday)'),
  ('Madrid', '2026-12-08', 'Inmaculada Concepción'),
  ('Madrid', '2026-12-25', 'Navidad'),
  ('Madrid', '2027-01-01', 'Año Nuevo'),
  ('Madrid', '2027-01-06', 'Epifanía del Señor'),
  ('Madrid', '2027-03-19', 'San José'),
  ('Madrid', '2027-03-25', 'Jueves Santo'),
  ('Madrid', '2027-03-26', 'Viernes Santo'),
  ('Madrid', '2027-05-01', 'Fiesta del Trabajo'),
  ('Madrid', '2027-05-15', 'San Isidro (Madrid city)'),
  ('Madrid', '2027-08-16', 'Asunción de la Virgen (moved from Sunday)'),
  ('Madrid', '2027-10-12', 'Fiesta Nacional de España'),
  ('Madrid', '2027-11-01', 'Todos los Santos'),
  ('Madrid', '2027-11-09', 'Nuestra Señora de la Almudena (Madrid city)'),
  ('Madrid', '2027-12-06', 'Día de la Constitución'),
  ('Madrid', '2027-12-08', 'Inmaculada Concepción'),
  ('Madrid', '2027-12-25', 'Navidad')
on conflict (calendar, date) do nothing;

-- ---------------------------------------------------------------------------
-- Time off: full days, as a date range
-- ---------------------------------------------------------------------------
create table if not exists public.time_off (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null default auth.uid() references public.people(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  reason text not null default 'Holiday' check (reason in ('Holiday', 'Absence')),
  created_at timestamptz not null default now(),
  constraint time_off_dates check (end_date >= start_date)
);
create index if not exists time_off_person_idx on public.time_off (person_id, start_date);

-- ---------------------------------------------------------------------------
-- Hours per month per unit (Shared already split), for the trend chart
-- ---------------------------------------------------------------------------
create or replace view public.monthly_unit_hours with (security_invoker = true) as
  select date_trunc('month', entry_date)::date as month,
         sum(education_hours) as education_hours,
         sum(planning_center_hours) as planning_center_hours,
         sum(internal_hours) as internal_hours
  from public.time_entries
  group by 1;

-- ---------------------------------------------------------------------------
-- Permission rules: everyone active reads; the admin edits budgets and
-- holidays; people manage their own time off, the admin anyone's
-- ---------------------------------------------------------------------------
revoke all on public.monthly_budgets, public.bank_holidays, public.time_off, public.monthly_unit_hours from anon;
grant select, insert, update, delete on public.monthly_budgets, public.bank_holidays, public.time_off to authenticated;
grant select on public.monthly_unit_hours to authenticated;

alter table public.monthly_budgets enable row level security;
alter table public.bank_holidays enable row level security;
alter table public.time_off enable row level security;

drop policy if exists "budgets: active users read" on public.monthly_budgets;
create policy "budgets: active users read" on public.monthly_budgets
  for select to authenticated using (public.is_active_user());
drop policy if exists "budgets: admin edits" on public.monthly_budgets;
create policy "budgets: admin edits" on public.monthly_budgets
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "holidays: active users read" on public.bank_holidays;
create policy "holidays: active users read" on public.bank_holidays
  for select to authenticated using (public.is_active_user());
drop policy if exists "holidays: admin edits" on public.bank_holidays;
create policy "holidays: admin edits" on public.bank_holidays
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "time off: active users read" on public.time_off;
create policy "time off: active users read" on public.time_off
  for select to authenticated using (public.is_active_user());
drop policy if exists "time off: own or admin" on public.time_off;
create policy "time off: own or admin" on public.time_off
  for all to authenticated
  using ((person_id = auth.uid() and public.can_edit_work()) or public.is_admin())
  with check ((person_id = auth.uid() and public.can_edit_work()) or public.is_admin());

-- Check: every column should say true
select
  to_regclass('public.monthly_budgets') is not null as budgets_table,
  (select count(*) from public.bank_holidays where calendar = 'Madrid') >= 19 as madrid_holidays,
  (select count(*) from public.bank_holidays where calendar = 'England') >= 10 as england_holidays,
  to_regclass('public.time_off') is not null as time_off_table,
  to_regclass('public.monthly_unit_hours') is not null as monthly_hours,
  (select count(*) from pg_policies where schemaname = 'public'
    and tablename in ('monthly_budgets', 'bank_holidays', 'time_off')) = 6 as permission_rules;
