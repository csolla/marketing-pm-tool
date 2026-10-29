-- 09_task_required.sql
-- Campaign time must always go on a task (or subtask); only Internal time
-- has no task. Existing entries are not changed by this file: the rule
-- applies to new entries and to any entry that is edited.
-- Safe to run more than once.

alter table public.time_entries drop constraint if exists campaign_time_needs_task;
alter table public.time_entries add constraint campaign_time_needs_task
  check (campaign_id is null or task_id is not null) not valid;

-- Read-only: campaign entries that have no task today (to review before
-- deciding what to delete)
select c.name as campaign, p.name as person, e.entry_date as date,
       round(e.minutes / 60.0, 2) as hours, coalesce(e.note, '') as note
from public.time_entries e
join public.people p on p.id = e.person_id
join public.campaigns c on c.id = e.campaign_id
where e.task_id is null
order by p.name, e.entry_date;
