-- 08_budget_alert_wording.sql
-- Budget alerts: one message per step. Passing 80% and reaching 100% read
-- differently, and a unit that jumps past both at once gets only the 100%
-- alert. Safe to run more than once.

create or replace function public.check_budget_alerts(p_month date)
returns void language plpgsql security definer set search_path = public as $$
declare
  first_day date := date_trunc('month', p_month)::date;
  month_label text := trim(to_char(date_trunc('month', p_month), 'FMMonth YYYY'));
  budget record;
  used_edu numeric;
  used_pc numeric;
  unit record;
  threshold int;
  message text;
  admin uuid;
begin
  select * into budget from public.unit_month_budget(first_day);
  select coalesce(sum(education_hours), 0), coalesce(sum(planning_center_hours), 0) into used_edu, used_pc
  from public.time_entries
  where entry_date >= first_day and entry_date < first_day + interval '1 month';

  for unit in
    select 'education' as key, 'Education' as label, used_edu as used, budget.education as limit_hours
    union all
    select 'planning_center', 'Planning Center', used_pc, budget.planning_center
  loop
    continue when unit.limit_hours is null or unit.limit_hours <= 0;

    if unit.used >= unit.limit_hours then
      threshold := 100;
      message := format('%s has reached its %s budget: %s of %s h (%s%%)', unit.label, month_label,
        round(unit.used, 1), round(unit.limit_hours), round(unit.used / unit.limit_hours * 100));
    elsif unit.used >= unit.limit_hours * 0.8 then
      threshold := 80;
      message := format('%s has passed 80%% of its %s budget: %s of %s h (%s%%)', unit.label, month_label,
        round(unit.used, 1), round(unit.limit_hours), round(unit.used / unit.limit_hours * 100));
    else
      continue;
    end if;

    for admin in select id from public.people where role = 'admin' and active loop
      perform public.notify(admin, 'budget_alert', message, null, null,
        'budget:' || first_day || ':' || unit.key || ':' || threshold, unit.key, first_day);
    end loop;
  end loop;
end $$;

revoke execute on function public.check_budget_alerts(date) from public, anon, authenticated;

-- Check: October 2026 with 1-hour budgets now gives one alert per unit
select * from public.preview_budget_alerts('2026-10-01', 1, 1);
