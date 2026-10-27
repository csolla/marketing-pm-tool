# Marketing PM Tool

Project management for DSD's Marketing team: campaigns, tasks, time logging and director dashboards. A standalone tool, separate from DSD Atlas.

- **Live app:** https://csolla.github.io/marketing-pm-tool/
- **Stack:** plain HTML, CSS and JavaScript (no build step) on GitHub Pages, with a dedicated Supabase project for the database, sign-in and file storage.
- **Database changes:** numbered SQL files in `supabase/migrations/`, run by hand in the Supabase SQL editor, in order.

## Files

- `index.html`: the page shell
- `css/styles.css`: all styles (light and dark)
- `js/config.js`: Supabase address and public key
- `js/app.js`: sign-in state, top bar, navigation and page routing (`#/campaigns`, `#/people`, ...)
- `js/state.js`: the signed-in person, the people list and role checks
- `js/ui.js`: shared helpers (labels, tags, dates, dialogs, toasts)
- `js/pages/`: one file per page

## Run it locally

```
python3 -m http.server 8000
```

Then open http://localhost:8000/ (it must be listed under Supabase → Authentication → URL Configuration → Redirect URLs).
