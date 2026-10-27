# Marketing PM Tool

A project management tool for DSD's Marketing team: campaigns, tasks, time logging and director dashboards. It is a new, standalone tool, separate from DSD Atlas (`../dsd-projects`), and must not share its data or Supabase project.

- **Stack:** plain HTML, CSS and JavaScript (no build step), hosted on GitHub Pages, with a new, dedicated Supabase project for the database, login, file storage and live updates.
- **Owner:** Carlota (csolla@digitalsmiledesign.com), who is not technical. Explain each step in plain language.
- **SQL:** Carlota runs database changes by hand in the Supabase SQL editor. Save each one as a numbered file under `supabase/migrations/` and put it on her clipboard with `pbcopy`.

## `_build_plan/`

The `_build_plan/` folder contains the initial PRD and per-milestone prompts used to scaffold this codebase during its initial build-out phase. These files are **temporary** — they exist for documentation and guidance only. They are **not** functional: no code, configuration, or runtime logic in this codebase should import, reference, or depend on anything inside `_build_plan/`.

Do not treat `_build_plan/` as long-living documentation for the codebase. The codebase will evolve past the assumptions and decisions captured here. Once the initial milestones are complete, this folder is expected to be deleted.
