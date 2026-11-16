# PRD team review — design

Date: 2026-11-16
Status: Draft

## Intent

Bring the leader–specialist pattern behind Grok's multi-agent mode into Panguyuban.
Several agents look at the same thing from different angles, at the same time, a
contrarian pushes back on what they agree on, and a leader turns it all into one
answer. The first place it runs is the guided builder (Prototypes): a team reviews
the draft PRD before the user approves it, and the user watches the team work as a
live flow diagram.

## Goals

- A **Review with team** button next to Approve on the PRD tab.
- Three specialists (Engineer, UX, QA) review the PRD in parallel, then a
  Contrarian reads their findings and challenges them, then a Leader merges
  everything into a verdict.
- A live flow diagram shows each agent's state (waiting, working, done, failed) as
  it changes. Clicking an agent shows its findings. The leader's verdict sits under
  the diagram.
- **Apply fixes** sends the leader's fixes into the interview as a user message, so
  the existing interview turn revises the PRD. **Approve anyway** is the existing
  approve.
- The same live diagram on the **Agents** page, in a **Team reviews** group next
  to the Claude Code and Antigravity sessions.

## Non-goals

- The leader choosing which specialists to call (approach B). Can be added later
  on the same code.
- Multi-round debate between agents.
- Tools for the agents (web search, reading the repo). They see only the PRD text,
  like every other builder agent today.
- Team review anywhere else (PR review, tickets).
- A different model per role.

## Anti-goals

- The review must never block approval. It advises; the user decides.
- One model role-playing all agents in a single call. The agents must not see each
  other's output, except the Contrarian and the Leader, by design.

## Constraints

- Every agent call goes through the existing `AgentRuntime::complete()` in
  `crates/agent-runtime`, with the harness and model already chosen for the project
  (Claude Code, Antigravity or an OpenAI-compatible provider). Stateless, no tools.
- Role prompts live in the skill library like the other builder skills:
  `skills/product/prd-review/SKILL.md`, compiled in with `include_str!`.
- Sample data and prompts stay neutral (no company names).

## Approaches considered

| | Approach | Trade-off |
|---|---|---|
| **A (picked)** | Fixed roles. Wave 1: Engineer, UX, QA in parallel. Wave 2: Contrarian sees their findings. Wave 3: Leader merges. | 5 calls, 3 waits. Predictable output, easy to test. |
| B | Leader first decides roles and questions, then fans out, then merges. | Closest to "leader assigns tasks", reusable. One more wait, less predictable. |
| C | One call role-plays the whole team. | Cheapest, but agents anchor on each other, which defeats the point. Dropped. |

The user picked A, and picked the **live flow diagram** (mockup A) for the view.

## Design

### Agent output

Every role answers with JSON between `<review>` and `</review>`:

```json
{
  "findings": [
    { "severity": "blocker" | "suggestion", "step": "S3" | null, "text": "..." }
  ]
}
```

- The **Contrarian** gets the specialists' findings and returns its own findings,
  which may disagree with theirs ("S4 duplicates S1" or "the UX point is not worth
  it, because …").
- The **Leader** gets all findings and returns the same shape plus
  `"verdict"` (one or two sentences) and `"fixes"` (a plain message to the
  interviewer listing the changes to make; empty when there is nothing to fix).
  Its findings are the final, deduplicated list.

Parsing follows `parse_plan`: read between the tags, tolerate a code fence, fall
back to the whole reply, error if no JSON. Bad values are coerced, not fatal: an
unknown severity becomes `suggestion`, a step id that is not in the PRD becomes
`null`. *(My call.)*

Size cap: the skill tells each role to give at most 5 findings of at most 300
characters, and the parser keeps the first 5 and truncates longer text. So the
Contrarian and Leader prompts stay bounded (≤ 15 and ≤ 20 findings) for
providers with small context windows. *(My call.)*

### Backend (`crates/agent-runtime`, `src-tauri`)

- `agent-runtime`: a `ReviewRole` enum (`engineer`, `ux`, `qa`, `contrarian`,
  `leader`), `review_turn(runtime, role, prd, earlier: &[RoleFindings], model, work_dir)`
  and `parse_review`. The system prompt is the skill plus "You are the <role>"
  plus the same no-tools rules the other turns use. Timeout 180 s per call, like
  the plan.
- `src-tauri`: one command, `builder_review_step`, run in `spawn_blocking` like
  the other builder commands. It runs exactly one role and returns its result.

### Orchestration (frontend)

The Builder screen runs the waves itself: `Promise.all` over the three specialists,
then the Contrarian, then the Leader, each a `builder_review_step` call. Because
each call is its own command, each node's status updates the moment its call
returns, so the live diagram needs no event channel. *(My call: smallest way to
get live status.)*

Running in parallel is safe: each Claude Code call is its own `claude -p`
process with no tools, and each Antigravity call its own `agy -p`, so three at
once share nothing but the read-only work dir. Provider rate limits (429) just
show up as a failed node.

Failure rules:
- A failed node turns red with the error. The others carry on.
- The Contrarian and Leader run if at least one specialist succeeded; otherwise
  the review stops with a message.
- If the Leader fails, show the specialists' and Contrarian's findings without a
  verdict.
- Every failed node has **Retry**. Retrying a specialist or the Contrarian also
  re-runs every step after it (Contrarian, then Leader). *(My call.)*

In-flight runs: agent calls cannot be cancelled, so they finish, but their
results are dropped when the PRD text no longer matches the one under review or
the PRD was approved meanwhile. **Approve anyway** works during a run.
*(My call.)*

### The view

On the PRD tab, **Review with team** sits next to the existing approve action.
Pressing it opens a panel above the PRD with the flow diagram from mockup A:

```
PRD → [Engineer]  → [Contrarian] → [Leader]
      [UX]
      [QA]
```

- Node states: waiting (grey), working (amber, dashed), done (green, finding
  count), failed (red).
- Clicking a node expands its findings below the diagram, each tagged blocker or
  suggestion and with its PRD step.
- When the Leader is done, its verdict, counts and final findings show under the
  diagram, with **Apply fixes** (hidden when `fixes` is empty) and **Approve anyway**.
- Elapsed time shows while the review runs.

### On the Agents page

The same team is visible on the **Agents** page, next to the Claude Code and
Antigravity sessions it already lists.

- A **Team reviews** group sits at the top of the session list, one row per
  builder project that has a review: project name, "PRD review", harness, progress
  ("3 of 5 done", or "done · 1 blocker"), elapsed time, and a strip of five small
  bars coloured by each agent's state.
- Selecting a row shows the same flow diagram component in the detail pane, with
  click-to-read findings and the leader's verdict. It is read-only there: **Open in
  Prototypes** jumps to the project, where Apply fixes and Approve live.
  *(My call: decisions about the PRD stay on the PRD.)*
- Filters: a running review counts under **Working** and **All**; a finished one
  under **Idle** and **All**. The header count includes them.
- No new data source: `useBuilder` already lives in `App.tsx` next to
  `useAgents`, so `AgentsView` gets the builder projects as a prop and reads the
  review state from them. Selection ids for team rows are `team:<projectId>` so
  they never collide with session ids.

### State

The review lives on the builder `Project` (in `builder_flow.ts`) so it survives
switching tabs: per-role status, findings and the leader's verdict, plus the PRD
text it reviewed. `Project` is persisted (`usePersisted("builder", …)`), so the
review is too, with no separate file. On load, any node still marked working
becomes failed with "Interrupted, run again". *(My call.)*

When the PRD changes after a review (including through **Apply fixes**), the old
review stays visible under a "PRD changed since this review" banner with
**Run again**. Nothing re-runs on its own. The review is also noted in the
project log (`record`). *(My call.)*

## Tests

- Rust unit tests for `parse_review`: tagged JSON, fenced JSON, missing tags,
  no JSON, leader fields.
- A test that the system prompt for each role names that role.

## Left to the builder

- Exact wording of the role sections in `SKILL.md`.
- Styling of the diagram, within the app's existing look.
- Whether the five roles share one skill file with sections, or one file each.
