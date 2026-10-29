-- 06_collaboration.sql
-- Milestone 5: comments, attachments, notifications, budget alerts and the
-- scheduled reminders. Safe to run more than once.

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------
create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  author_id uuid not null default auth.uid() references public.people(id),
  body text not null check (length(trim(body)) > 0 and length(body) <= 10000),
  mentions uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  edited_at timestamptz
);
create index if not exists comments_task_idx on public.comments (task_id, created_at);

create or replace function public.comment_edited()
returns trigger language plpgsql as $$
begin
  if new.body is distinct from old.body then
    new.edited_at := now();
  end if;
  new.task_id := old.task_id;
  new.author_id := old.author_id;
  new.created_at := old.created_at;
  return new;
end $$;

drop trigger if exists comment_edited on public.comments;
create trigger comment_edited
  before update on public.comments
  for each row execute function public.comment_edited();

-- ---------------------------------------------------------------------------
-- Attachments: uploaded files (private storage) or pasted links
-- ---------------------------------------------------------------------------
create table if not exists public.attachments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  uploaded_by uuid not null default auth.uid() references public.people(id),
  kind text not null check (kind in ('file', 'link')),
  name text not null check (length(trim(name)) > 0),
  size bigint check (size is null or size between 0 and 26214400),
  mime_type text,
  storage_path text,
  url text,
  created_at timestamptz not null default now(),
  constraint attachment_target check (
    (kind = 'file' and storage_path is not null) or (kind = 'link' and url ~* '^https?://'))
);
create index if not exists attachments_task_idx on public.attachments (task_id, created_at);

insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, 26214400)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

-- Comment and attachment counts for task cards
create or replace view public.task_activity_counts with (security_invoker = true) as
  select t.id as task_id, t.campaign_id,
         (select count(*) from public.comments c where c.task_id = t.id) as comments,
         (select count(*) from public.attachments a where a.task_id = t.id) as attachments
  from public.tasks t;

-- ---------------------------------------------------------------------------
-- Notifications (only created by the database)
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.people(id) on delete cascade,
  type text not null check (type in
    ('assigned', 'mentioned', 'commented', 'due_tomorrow', 'overdue', 'hours_reminder', 'budget_alert')),
  task_id uuid references public.tasks(id) on delete cascade,
  actor_id uuid references public.people(id),
  business_unit text,
  month date,
  message text not null,
  dedupe_key text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_recipient_idx on public.notifications (recipient_id, created_at desc);
create unique index if not exists notifications_dedupe_idx on public.notifications (recipient_id, dedupe_key)
  where dedupe_key is not null;

-- Sends one notification. Never to the person who caused it, nor to
-- inactive people; a dedupe key makes sure it is only sent once.
create or replace function public.notify(
  p_recipient uuid, p_type text, p_message text, p_task uuid default null, p_actor uuid default null,
  p_dedupe text default null, p_unit text default null, p_month date default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_recipient is null or p_recipient = p_actor then
    return;
  end if;
  if not exists (select 1 from public.people where id = p_recipient and active) then
    return;
  end if;
  insert into public.notifications (recipient_id, type, task_id, actor_id, business_unit, month, message, dedupe_key)
  values (p_recipient, p_type, p_task, p_actor, p_unit, p_month, p_message, p_dedupe)
  on conflict (recipient_id, dedupe_key) where dedupe_key is not null do nothing;
end $$;

revoke execute on function public.notify(uuid, text, text, uuid, uuid, text, text, date) from public, anon, authenticated;

create or replace function public.person_name(p_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select name from public.people where id = p_id), 'Someone')
$$;

-- Assigned a task or subtask
create or replace function public.notify_task_assigned()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.assignee_id is not null
     and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id) then
    perform public.notify(
      new.assignee_id, 'assigned',
      format('%s assigned you %s “%s”', public.person_name(auth.uid()),
             case when new.parent_id is null then 'the task' else 'the subtask' end, new.title),
      coalesce(new.parent_id, new.id), auth.uid());
  end if;
  return new;
end $$;

drop trigger if exists notify_task_assigned on public.tasks;
create trigger notify_task_assigned
  after insert or update of assignee_id on public.tasks
  for each row execute function public.notify_task_assigned();

-- Mentioned in a comment, or someone commented on your task
create or replace function public.notify_comment()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  task record;
  person uuid;
  open_task uuid;
begin
  select id, title, parent_id, assignee_id into task from public.tasks where id = new.task_id;
  open_task := coalesce(task.parent_id, task.id);

  foreach person in array new.mentions loop
    if tg_op = 'INSERT' or not (person = any(old.mentions)) then
      perform public.notify(person, 'mentioned',
        format('%s mentioned you on “%s”', public.person_name(new.author_id), task.title),
        open_task, new.author_id, 'mention:' || new.id || ':' || person);
    end if;
  end loop;

  if tg_op = 'INSERT' and task.assignee_id is not null and not (task.assignee_id = any(new.mentions)) then
    perform public.notify(task.assignee_id, 'commented',
      format('%s commented on your task “%s”', public.person_name(new.author_id), task.title),
      open_task, new.author_id, 'comment:' || new.id);
  end if;
  return new;
end $$;

drop trigger if exists notify_comment on public.comments;
create trigger notify_comment
  after insert or update of mentions on public.comments
  for each row execute function public.notify_comment();

-- ---------------------------------------------------------------------------
-- Capacity maths in SQL (same as js/capacity.js): a person's working hours
-- between two dates, and a month's budget per unit
-- ---------------------------------------------------------------------------
create or replace function public.person_working_hours(p_person uuid, p_from date, p_to date)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(count(d.day) * max(p.hours_per_day), 0)
  from public.people p
  cross join lateral generate_series(p_from, p_to, interval '1 day') as d(day)
  where p.id = p_person
    and extract(isodow from d.day)::smallint = any(p.working_days)
    and not exists (select 1 from public.bank_holidays h
                    where h.calendar = p.holiday_calendar and h.date = d.day::date)
    and not exists (select 1 from public.time_off t
                    where t.person_id = p.id and d.day::date between t.start_date and t.end_date)
$$;

-- Automatic budget = team productive hours x budget split; a typed value wins
create or replace function public.unit_month_budget(p_month date, out education numeric, out planning_center numeric)
language plpgsql stable security definer set search_path = public as $$
declare
  first_day date := date_trunc('month', p_month)::date;
  last_day date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  team_hours numeric;
  s record;
  typed record;
begin
  select coalesce(sum(public.person_working_hours(id, first_day, last_day)), 0) into team_hours
  from public.people where active and counts_in_capacity;
  select productive_pct, budget_split_education into s from public.team_settings limit 1;
  select education_hours, planning_center_hours into typed from public.monthly_budgets where month = first_day;

  education := coalesce(typed.education_hours,
    team_hours * coalesce(s.productive_pct, 80) / 100.0 * coalesce(s.budget_split_education, 70) / 100.0);
  planning_center := coalesce(typed.planning_center_hours,
    team_hours * coalesce(s.productive_pct, 80) / 100.0 * (100 - coalesce(s.budget_split_education, 70)) / 100.0);
end $$;

-- Alert the admin(s) once when a unit reaches 80% and 100% of a month's budget
create or replace function public.check_budget_alerts(p_month date)
returns void language plpgsql security definer set search_path = public as $$
declare
  first_day date := date_trunc('month', p_month)::date;
  budget record;
  used_edu numeric;
  used_pc numeric;
  unit record;
  threshold int;
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
    foreach threshold in array array[80, 100] loop
      if unit.used >= unit.limit_hours * threshold / 100.0 then
        for admin in select id from public.people where role = 'admin' and active loop
          perform public.notify(admin, 'budget_alert',
            format('%s has used %s%% of its %s budget (%s of %s h)', unit.label,
              round(unit.used / unit.limit_hours * 100), trim(to_char(first_day, 'FMMonth YYYY')),
              round(unit.used, 1), round(unit.limit_hours)),
            null, null, 'budget:' || first_day || ':' || unit.key || ':' || threshold, unit.key, first_day);
        end loop;
      end if;
    end loop;
  end loop;
end $$;

create or replace function public.time_entry_budget_check()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.check_budget_alerts(new.entry_date);
  return new;
end $$;

drop trigger if exists time_entry_budget_check on public.time_entries;
create trigger time_entry_budget_check
  after insert or update of minutes, entry_date, campaign_id on public.time_entries
  for each row execute function public.time_entry_budget_check();

-- ---------------------------------------------------------------------------
-- Scheduled reminders, run every hour on weekdays. For each person, at 8:00
-- their local time: due soon and overdue; Friday 12:00: hours reminder.
-- p_now can be set to test a given moment.
-- ---------------------------------------------------------------------------
create or replace function public.run_scheduled_notifications(p_now timestamptz default now())
returns void language plpgsql security definer set search_path = public as $$
declare
  p record;
  t record;
  local_time timestamp;
  today date;
  dow int;
  next_working date;
  week_start date;
  expected numeric;
  logged numeric;
begin
  for p in select * from public.people where active and role in ('admin', 'member') loop
    local_time := p_now at time zone case p.holiday_calendar when 'England' then 'Europe/London' else 'Europe/Madrid' end;
    today := local_time::date;
    dow := extract(isodow from local_time);
    continue when dow > 5;

    if extract(hour from local_time) = 8 then
      -- Due by the next working day (Friday covers the weekend and Monday)
      next_working := today + case when dow = 5 then 3 else 1 end;
      for t in
        select tk.id, tk.title, coalesce(tk.parent_id, tk.id) as open_task,
               coalesce(tk.due_date, parent.due_date) as due
        from public.tasks tk
        left join public.tasks parent on parent.id = tk.parent_id
        where tk.assignee_id = p.id and tk.status <> 'done'
          and coalesce(tk.due_date, parent.due_date) > today
          and coalesce(tk.due_date, parent.due_date) <= next_working
      loop
        perform public.notify(p.id, 'due_tomorrow',
          format('“%s” is due %s', t.title,
            case when t.due = today + 1 then 'tomorrow' else 'on ' || trim(to_char(t.due, 'FMDay FMDD Mon')) end),
          t.open_task, null, 'due:' || t.id || ':' || t.due);
      end loop;

      -- Became overdue (sent once per task; the last 7 days only)
      for t in
        select tk.id, tk.title, coalesce(tk.parent_id, tk.id) as open_task,
               coalesce(tk.due_date, parent.due_date) as due
        from public.tasks tk
        left join public.tasks parent on parent.id = tk.parent_id
        where tk.assignee_id = p.id and tk.status <> 'done'
          and coalesce(tk.due_date, parent.due_date) < today
          and coalesce(tk.due_date, parent.due_date) >= today - 7
      loop
        perform public.notify(p.id, 'overdue',
          format('“%s” is overdue (it was due %s)', t.title, trim(to_char(t.due, 'FMDay FMDD Mon'))),
          t.open_task, null, 'overdue:' || t.id || ':' || t.due);
      end loop;
    end if;

    -- Friday 12:00: logged under 90% of this week's working hours
    if dow = 5 and extract(hour from local_time) = 12 and p.counts_in_capacity then
      week_start := today - (dow - 1);
      expected := public.person_working_hours(p.id, week_start, week_start + 6);
      select coalesce(sum(minutes), 0) / 60.0 into logged
      from public.time_entries where person_id = p.id and entry_date between week_start and week_start + 6;
      if expected > 0 and logged < expected * 0.9 then
        perform public.notify(p.id, 'hours_reminder',
          format('Remember to complete your timesheet: you''ve logged %s of %s h this week', round(logged, 1), round(expected, 1)),
          null, null, 'hours:' || week_start);
      end if;
    end if;
  end loop;
end $$;

revoke execute on function public.run_scheduled_notifications(timestamptz) from public, anon, authenticated;
revoke execute on function public.check_budget_alerts(date) from public, anon, authenticated;
revoke execute on function public.unit_month_budget(date) from public, anon;
revoke execute on function public.person_working_hours(uuid, date, date) from public, anon;

create extension if not exists pg_cron with schema pg_catalog;
select cron.unschedule(jobid) from cron.job where jobname = 'marketing-notifications';
select cron.schedule('marketing-notifications', '0 * * * 1-5', 'select public.run_scheduled_notifications()');

-- ---------------------------------------------------------------------------
-- Permission rules
-- ---------------------------------------------------------------------------
revoke all on public.comments, public.attachments, public.notifications, public.task_activity_counts from anon;
grant select, insert, update, delete on public.comments, public.attachments to authenticated;
grant select, delete on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;
grant select on public.task_activity_counts to authenticated;

alter table public.comments enable row level security;
alter table public.attachments enable row level security;
alter table public.notifications enable row level security;

drop policy if exists "comments: active users read" on public.comments;
create policy "comments: active users read" on public.comments
  for select to authenticated using (public.is_active_user());
drop policy if exists "comments: admin and members write" on public.comments;
create policy "comments: admin and members write" on public.comments
  for insert to authenticated with check (public.can_edit_work() and author_id = auth.uid());
drop policy if exists "comments: edit own" on public.comments;
create policy "comments: edit own" on public.comments
  for update to authenticated using (author_id = auth.uid() and public.can_edit_work())
  with check (author_id = auth.uid());
drop policy if exists "comments: delete own" on public.comments;
create policy "comments: delete own" on public.comments
  for delete to authenticated using (author_id = auth.uid() and public.can_edit_work());

drop policy if exists "attachments: active users read" on public.attachments;
create policy "attachments: active users read" on public.attachments
  for select to authenticated using (public.is_active_user());
drop policy if exists "attachments: admin and members add" on public.attachments;
create policy "attachments: admin and members add" on public.attachments
  for insert to authenticated with check (public.can_edit_work() and uploaded_by = auth.uid());
drop policy if exists "attachments: uploader or admin deletes" on public.attachments;
create policy "attachments: uploader or admin deletes" on public.attachments
  for delete to authenticated using ((uploaded_by = auth.uid() and public.can_edit_work()) or public.is_admin());

drop policy if exists "notifications: own" on public.notifications;
create policy "notifications: own" on public.notifications
  for select to authenticated using (recipient_id = auth.uid());
drop policy if exists "notifications: mark own read" on public.notifications;
create policy "notifications: mark own read" on public.notifications
  for update to authenticated using (recipient_id = auth.uid()) with check (recipient_id = auth.uid());
drop policy if exists "notifications: delete own" on public.notifications;
create policy "notifications: delete own" on public.notifications
  for delete to authenticated using (recipient_id = auth.uid());

-- Storage: files are private; active people read, admin and members upload,
-- the uploader or the admin deletes
drop policy if exists "attachment files: read" on storage.objects;
create policy "attachment files: read" on storage.objects
  for select to authenticated using (bucket_id = 'attachments' and public.is_active_user());
drop policy if exists "attachment files: upload" on storage.objects;
create policy "attachment files: upload" on storage.objects
  for insert to authenticated with check (bucket_id = 'attachments' and public.can_edit_work());
drop policy if exists "attachment files: delete" on storage.objects;
create policy "attachment files: delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'attachments' and (owner_id = auth.uid()::text or public.is_admin()));

-- Live updates
do $$
declare
  t text;
begin
  foreach t in array array['comments', 'attachments', 'notifications'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- Check: every column should say true
select
  to_regclass('public.comments') is not null and to_regclass('public.attachments') is not null as comments_and_files,
  to_regclass('public.notifications') is not null as notifications_table,
  exists (select 1 from storage.buckets where id = 'attachments' and not public) as private_file_bucket,
  exists (select 1 from pg_trigger where tgname = 'notify_task_assigned')
    and exists (select 1 from pg_trigger where tgname = 'notify_comment')
    and exists (select 1 from pg_trigger where tgname = 'time_entry_budget_check') as notification_triggers,
  exists (select 1 from cron.job where jobname = 'marketing-notifications') as reminder_schedule,
  (select count(*) from pg_publication_tables where pubname = 'supabase_realtime'
    and tablename in ('comments', 'attachments', 'notifications')) = 3 as live_updates;
