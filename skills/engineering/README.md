# Engineering skills

Skills that govern how code is written: project structure, design patterns, naming,
database design, testing. The user never picks or sees these. The build agent applies
them while working on a story from the approved `prd.md`.

Here now:

- `endpoint-requests` — every HTTP endpoint gets a ready-to-send request in the project's
  Postman collection (`docs/api/<project>.postman_collection.json`), which opens in Postman
  or in Panguyuban's Requests view

Expected here (not written yet):

- app scaffold — project structure and overall conventions
- database design — tables, normalization, migrations
- backend modules — feature layers (repository + Impl, service + Impl, ...)
- frontend — pages, components, design system, translations
- unit tests — tests and the coverage gate

Add a skill here when a coding rule should apply to every prototype.
