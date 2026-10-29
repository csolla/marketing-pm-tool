-- 10_remove_test_entries_without_task.sql
-- Carlota confirmed (30 October 2026) that every campaign entry without a
-- task was test data. Delete them, then make the "campaign time needs a
-- task" rule (09) apply to all rows, old and new.

delete from public.time_entries
where campaign_id is not null and task_id is null;

alter table public.time_entries validate constraint campaign_time_needs_task;

-- Check: should say 0 and true
select
  (select count(*) from public.time_entries where campaign_id is not null and task_id is null) as entries_without_task,
  (select convalidated from pg_constraint where conname = 'campaign_time_needs_task') as rule_applies_to_all;
