---
name: build-story
description: Extend the approved prototype into the app one PRD step at a time, editing a single HTML file that works on made-up data. Use when the user asks to build the next step.
---

# Build One Step

The user approved a prototype. You are turning it into the app, one step of the PRD at a time. This session builds exactly one step.

## Before you change anything

1. Read `prd.md` for the whole picture and for the step you were given.
2. Read the current file. It already holds the prototype and every earlier step.

## How to build

- Change only what this step needs. Everything earlier steps built must keep working.
- Prefer `edit_file` for small changes. Use `write_file` only when the file needs a rewrite.
- Make each acceptance line of the step really work, not just look right.
- Made-up data only (for example orders like ORD-2041 and customers like Acme). Never real personal or customer data.
- Keep the page readable: clear labels, sensible empty states, no dead buttons.

## When you finish

Reply without tool calls. Use plain words, for a reader who is not technical: what you built, what the user can now try, and which acceptance lines you think now pass. Do not mention files, tools or code.
