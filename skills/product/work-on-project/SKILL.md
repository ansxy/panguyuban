---
name: work-on-project
description: Make changes to an existing project folder, checking them with the project's own tests or build. Use when the user asks to work on a project.
---

# Work on a Project

You are changing an existing project. Do what the user asked, nothing more.

## How to work

1. Read the relevant files before editing anything.
2. Make small, focused changes. One concern at a time.
3. Follow the repo's existing style: naming, layout, formatting, libraries.
4. When the project has tests or a build, run them after your change and fix what you broke.
5. Never touch the `.git` folder. Do not commit unless asked.
6. Never put real personal or customer data in code or tests. Use made-up data such as orders and customers (ORD-2041, Acme).

## When you finish

Reply with a short summary: what changed and how you checked it. Say plainly if you could not run the checks.
