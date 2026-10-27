-- 02_tasks.sql
-- Milestone 2: tasks and subtasks inside campaigns, with live updates.
-- Safe to run more than once.

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  parent_id uuid references public.tasks(id) on delete cascade,
  title text not null check (length(trim(title)) > 0),
  description text,
  assignee_id uuid references public.people(id),
  due_date date,
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'in_review', 'done')),
  position double precision not null default 0,
  created_by uuid default auth.uid() references public.people(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tasks_campaign_idx on public.tasks (campaign_id);
create index if not exists tasks_parent_idx on public.tasks (parent_id);
create index if not exists tasks_assignee_idx on public.tasks (assignee_id);

-- Subtasks always belong to their parent's campaign, and go one level deep.
-- Tasks can't move to another campaign (not in scope).
create or replace function public.check_task_shape()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  parent record;
begin
  if tg_op = 'UPDATE' and new.campaign_id is distinct from old.campaign_id and new.parent_id is null then
    raise exception 'Tasks can''t be moved to another campaign';
  end if;

  if new.parent_id is not null then
    select campaign_id, parent_id into parent from public.tasks where id = new.parent_id;
    if not found then
      raise exception 'Parent task not found';
    end if;
    if parent.parent_id is not null then
      raise exception 'Subtasks can''t have their own subtasks';
    end if;
    if exists (select 1 from public.tasks where parent_id = new.id) then
      raise exception 'A task with subtasks can''t become a subtask';
    end if;
    new.campaign_id := parent.campaign_id;
  end if;

  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  return new;
end $$;

drop trigger if exists check_task_shape on public.tasks;
create trigger check_task_shape
  before insert or update on public.tasks
  for each row execute function public.check_task_shape();

-- Permission rules: everyone active reads; admin and team members change
revoke all on public.tasks from anon;
grant select, insert, update, delete on public.tasks to authenticated;
alter table public.tasks enable row level security;

drop policy if exists "tasks: active users read" on public.tasks;
create policy "tasks: active users read" on public.tasks
  for select to authenticated using (public.is_active_user());

drop policy if exists "tasks: admin and members create" on public.tasks;
create policy "tasks: admin and members create" on public.tasks
  for insert to authenticated with check (public.can_edit_work());

drop policy if exists "tasks: admin and members edit" on public.tasks;
create policy "tasks: admin and members edit" on public.tasks
  for update to authenticated using (public.can_edit_work()) with check (public.can_edit_work());

drop policy if exists "tasks: admin and members delete" on public.tasks;
create policy "tasks: admin and members delete" on public.tasks
  for delete to authenticated using (public.can_edit_work());

-- Live updates
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tasks') then
    alter publication supabase_realtime add table public.tasks;
  end if;
end $$;

-- Check: every column should say true
select
  to_regclass('public.tasks') is not null as tasks_table,
  exists (select 1 from pg_trigger where tgname = 'check_task_shape') as subtask_rules,
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'tasks') = 4 as permission_rules,
  exists (select 1 from pg_publication_tables
          where pubname = 'supabase_realtime' and tablename = 'tasks') as live_updates;
