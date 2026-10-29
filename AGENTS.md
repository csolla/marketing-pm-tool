# Marketing PM Tool

A project management tool for DSD's Marketing team: campaigns, tasks, time logging and director dashboards. It is a new, standalone tool, separate from DSD Atlas (`../dsd-projects`), and must not share its data or Supabase project.

- **Stack:** plain HTML, CSS and JavaScript (no build step), hosted on GitHub Pages, with a new, dedicated Supabase project for the database, login, file storage and live updates.
- **Owner:** Carlota (csolla@digitalsmiledesign.com), who is not technical. Explain each step in plain language.
- **SQL:** Carlota runs database changes by hand in the Supabase SQL editor. Save each one as a numbered file under `supabase/migrations/` and put it on her clipboard with `pbcopy`.

## Build history

All five build milestones are complete (October 2026). The original PRD, milestone prompts and milestone logs were moved out of this folder to `../archive/marketing-pm-tool-build-plan/`. They are a historical record, not current documentation: the code has moved past some of their decisions, and nothing in the code depends on them. The milestone logs are still the best summary of why things were built the way they were.

- Database changes so far: `supabase/migrations/01` to `08`. The next one is `09`.
- Capacity rules exist twice and must be kept in step: `js/capacity.js` (`availability`, `monthBudget`) and the SQL functions `person_working_hours` / `unit_month_budget`.
- When embedding a subtask's parent task in a Supabase request, name it by column (`parent:parent_id(...)`), not by constraint name.
