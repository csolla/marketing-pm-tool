-- 07_notification_previews.sql
-- Helpers to see what the reminders and budget alerts would send, without
-- sending anything: each runs the real logic, reads the result, then undoes
-- it. Only usable from the SQL editor. Safe to run more than once.

-- What the hourly reminder job would send at a given moment
create or replace function public.preview_scheduled_notifications(p_now timestamptz)
returns table (person text, type text, message text)
language plpgsql security definer set search_path = public as $$
declare
  result jsonb;
begin
  begin
    perform public.run_scheduled_notifications(p_now);
    select coalesce(jsonb_agg(jsonb_build_object('person', pe.name, 'type', n.type, 'message', n.message)), '[]')
      into result
    from public.notifications n join public.people pe on pe.id = n.recipient_id
    where n.created_at = now() and n.type in ('due_tomorrow', 'overdue', 'hours_reminder');
    raise exception 'undo preview';
  exception when raise_exception then
    null;  -- everything above is rolled back; result is kept
  end;
  return query select r.person, r.type, r.message from jsonb_to_recordset(result) as r(person text, type text, message text);
end $$;

-- The budget alerts a month would trigger if its budget were the given hours
create or replace function public.preview_budget_alerts(p_month date, p_education numeric, p_planning_center numeric)
returns table (person text, message text)
language plpgsql security definer set search_path = public as $$
declare
  result jsonb;
  first_day date := date_trunc('month', p_month)::date;
begin
  begin
    insert into public.monthly_budgets (month, education_hours, planning_center_hours)
    values (first_day, p_education, p_planning_center)
    on conflict (month) do update set education_hours = excluded.education_hours,
                                      planning_center_hours = excluded.planning_center_hours;
    -- Forget alerts already sent for this month, so the preview shows them all
    delete from public.notifications where type = 'budget_alert' and month = first_day;
    perform public.check_budget_alerts(first_day);
    select coalesce(jsonb_agg(jsonb_build_object('person', pe.name, 'message', n.message)), '[]')
      into result
    from public.notifications n join public.people pe on pe.id = n.recipient_id
    where n.type = 'budget_alert' and n.month = first_day;
    raise exception 'undo preview';
  exception when raise_exception then
    null;
  end;
  return query select r.person, r.message from jsonb_to_recordset(result) as r(person text, message text);
end $$;

revoke execute on function public.preview_scheduled_notifications(timestamptz) from public, anon, authenticated;
revoke execute on function public.preview_budget_alerts(date, numeric, numeric) from public, anon, authenticated;

-- Preview: Friday 30 October 2026 at 8:00 and 12:00, Madrid and England.
-- Due reminders on Friday cover anything due Saturday to Monday 2 November.
select '8:00 Madrid' as moment, * from public.preview_scheduled_notifications('2026-10-30 07:00+00')
union all
select '8:00 England', * from public.preview_scheduled_notifications('2026-10-30 08:00+00')
union all
select '12:00 Madrid', * from public.preview_scheduled_notifications('2026-10-30 11:00+00')
union all
select '12:00 England', * from public.preview_scheduled_notifications('2026-10-30 12:00+00')
union all
-- Budget alerts for October 2026 if both budgets were only 5 hours
select 'Budget alert test', p.person, 'budget_alert', p.message from public.preview_budget_alerts('2026-10-01', 5, 5) p;
