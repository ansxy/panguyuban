# Engineering skills

Skills that govern how code is written: project structure, design patterns, naming,
database design, testing. The user never picks or sees these. The build agent applies
them while working on a story from the approved `prd.md`.

Expected here (not copied in yet, they live in the `rey-nextjs` plugin today):

- `rey-nextjs-app` — scaffold and overall conventions
- `rey-db-design` — tables, normalization, migrations
- `rey-nextjs-module` — backend feature layers (repository + Impl, service + Impl, ...)
- `rey-nextjs-frontend` — pages, components, design system, translations
- `rey-nextjs-unit-test` — tests and the coverage gate

Add a skill here when a coding rule should apply to every prototype.
