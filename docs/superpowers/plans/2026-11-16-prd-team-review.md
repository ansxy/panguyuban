# PRD Team Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A leader–specialist agent team (Engineer, UX, QA → Contrarian → Leader) reviews a draft PRD in the guided builder. The user watches it as a live flow diagram on the PRD tab and on the Agents page.

**Architecture:** `agent-runtime` gets a `review` module that runs one role per call through the existing stateless `AgentRuntime::complete()`. Tauri exposes it as one command, `builder_review_step`. The frontend runs the three waves itself (`Promise.allSettled` over the specialists, then the Contrarian, then the Leader) and writes each node's state into the persisted builder `Project`. That gives a live diagram with no event channel.

**Tech Stack:** Rust (agent-runtime crate, Tauri 2), React + TypeScript (Vite), Node 25 type stripping for the TS self-check.

**Spec:** `docs/superpowers/specs/2026-11-16-prd-team-review-design.md`

## Global Constraints

- Every agent call goes through `AgentRuntime::complete()`, with the harness and model of the project's `interviewAgent`. Stateless, no tools.
- Role prompts live in `skills/product/prd-review/SKILL.md`, compiled in with `include_str!`.
- Every role answers JSON between `<review>` and `</review>`: `{"findings":[{"severity":"blocker"|"suggestion","step":"S3"|null,"text":"..."}]}`. The Leader also returns `"verdict"` and `"fixes"`.
- At most 5 findings per role, each at most 300 characters (the parser enforces this too).
- An unknown severity is coerced to `suggestion`, and a step id not in the PRD to `null`. Neither is an error.
- Timeout per call: 180 s.
- The review never blocks approval.
- Sample data, prompts and tests use neutral names (orders/customers domain). No company names. Before committing, check that `git config user.email` is `ansxy@users.noreply.github.com`.

## Review Focus

1. **All three specialists fail** (offline, bad key, 429). The review stops with a message. The Contrarian and Leader never run. → Task 3 check `stops_when_every_specialist_failed`.
2. **App closed mid-review.** Nodes still marked working reopen as failed "Interrupted, run again". Nothing spins forever. → Task 3 check `interrupt_marks_working_nodes_failed`.
3. **PRD changes or gets approved while calls are running.** Late results are dropped, not written over a newer state. → Task 3 check `stale_after_prd_changes`, plus the guard in Task 4 Step 3.
4. **Leader fails after the others succeeded.** Findings stay visible, and Retry re-runs only the Leader. → Task 3 check `retry_leader_keeps_the_rest`.
5. **The model answers prose, a code fence, an unknown severity or a made-up step id.** The node is coerced or failed with a readable error, and nothing panics. → Task 1 tests.

---

### Task 1: Review module in agent-runtime

**Files:**
- Create: `skills/product/prd-review/SKILL.md`
- Create: `crates/agent-runtime/src/review.rs`
- Modify: `crates/agent-runtime/src/lib.rs` (add `mod review; pub use review::*;`; tests live in `review.rs`)

**Interfaces:**
- Produces (all `pub`, re-exported from the crate root):
  - `enum ReviewRole { Engineer, Ux, Qa, Contrarian, Leader }`: `Serialize/Deserialize`, `#[serde(rename_all = "lowercase")]`, `Copy`.
  - `enum Severity { Blocker, Suggestion }`, lowercase serde.
  - `struct Finding { severity: Severity, step: Option<String>, text: String }`.
  - `struct RoleReview { role: ReviewRole, findings: Vec<Finding>, #[serde(default)] verdict: String, #[serde(default)] fixes: String }`. Derives `Debug, Clone, PartialEq, Eq, Serialize, Deserialize`.
  - `fn review_system_prompt(role: ReviewRole) -> String`
  - `fn review_prompt(prd: &str, earlier: &[RoleReview]) -> String`
  - `fn parse_review(role: ReviewRole, raw: &str, step_ids: &[String]) -> Result<RoleReview, String>`
  - `fn prd_step_ids(prd: &str) -> Vec<String>`: ids from lines `### S<n>. …`, e.g. `["S1","S2"]`.
  - `fn review_turn(runtime: &dyn AgentRuntime, role: ReviewRole, prd: &str, earlier: &[RoleReview], model: Option<&str>, work_dir: &Path) -> Result<RoleReview, RuntimeError>`

- [ ] **Step 1: Write the skill** `skills/product/prd-review/SKILL.md`, with frontmatter `name: prd-review`. Include shared rules: you review a draft PRD; answer only the `<review>` JSON; at most 5 findings, each under 300 characters; `step` is the `S<n>` id or null; `blocker` = the PRD cannot be built or tested as written, `suggestion` = everything else. Then one `## <Role>` section each for Engineer (can it be built as scoped: missing integrations, data, hidden work), UX (flows, empty/error states, unclear screens), QA (each acceptance line testable, with measurable numbers), Contrarian (you receive the others' findings; challenge the ones they agree on, say which to drop and why, add what they all missed) and Leader (you receive everything; return the final deduplicated findings, a 1–2 sentence `verdict`, and `fixes`: a plain message to the interviewer listing changes to make, or `""` when nothing must change).

- [ ] **Step 2: Write the failing tests** in `review.rs` `#[cfg(test)] mod tests`, using an orders-domain PRD fixture with `### S1. Place an order` and `### S2. Track an order`:
  - `parses_tagged_json`: `<review>{"findings":[{"severity":"blocker","step":"S1","text":"No payment provider"}]}</review>` gives 1 finding, `Severity::Blocker`, `step == Some("S1")`.
  - `tolerates_fence_and_missing_tags`: "Here:\n```json\n{\"findings\":[]}\n```" gives `Ok` with 0 findings.
  - `no_json_is_an_error`: `"Looks fine to me."` gives `Err`.
  - `coerces_unknown_severity_and_step`: `"severity":"critical","step":"S9"` gives `Suggestion` and `step == None`. `"step":"s2"` gives `Some("S2")`.
  - `caps_count_and_length`: 7 findings, one 400 chars long, gives 5 findings with `text.chars().count() <= 300`.
  - `reads_leader_fields`: the Leader JSON with `verdict` and `fixes` is carried through. A non-leader with no `verdict` gives `verdict == ""`.
  - `system_prompt_names_role_and_forbids_tools`: for every role, the prompt contains its section heading (e.g. `"## QA"`), contains `"You are the"`, and contains `"You have no tools"`. It does not contain `"name: prd-review"`.
  - `prompt_includes_earlier_findings_only_when_given`: `review_prompt(prd, &[])` does not contain `"Findings so far"`. With one Engineer review it contains `"Findings so far"` and that finding's text.
  - `step_ids_from_headings`: `prd_step_ids(fixture) == ["S1","S2"]`.

- [ ] **Step 3: Run and see them fail.** Run: `cargo test -p agent-runtime review` and expect compile errors or FAIL.

- [ ] **Step 4: Implement `review.rs`.** Follow the `plan_turn`/`parse_plan` shape in `lib.rs`. The system prompt is `strip_frontmatter(SKILL)` (reachable as `super::strip_frontmatter`) + `"\n\n---\n\nYou are the <Role label>. Follow the shared rules and your section only.\nYou have no tools. You cannot read, write or run anything."`. `review_prompt` = `"Draft PRD:\n\n{prd}"`, plus a `"Findings so far:"` block of JSON-serialised `earlier` when it is non-empty, ending with `"Send your review."`. To coerce, parse into a private raw struct with `severity: String, step: Option<String>`, then map. `review_turn` calls `complete` with `REVIEW_TIMEOUT = Duration::from_secs(180)` and maps parse errors to `RuntimeError::Failed { detail: "its review could not be read (…)" }`, as `plan_turn` does.

- [ ] **Step 5: Run the tests and see them pass.** Run: `cargo test -p agent-runtime` and expect every test to PASS, the old ones included.

- [ ] **Step 6: Commit.** `git add skills/product/prd-review crates/agent-runtime && git commit -m "Add PRD team review roles to agent-runtime"`

### Task 2: Tauri command and TS API

**Files:**
- Modify: `apps/panguyuban-desktop/src-tauri/src/builder.rs` (add `ReviewStepArgs` and `run_review_step` next to `run_plan`)
- Modify: `apps/panguyuban-desktop/src-tauri/src/lib.rs` (add command `builder_review_step` next to `builder_plan`; register it at the `builder_plan, builder_design,` list ~line 938)
- Modify: `apps/panguyuban-desktop/src/api.ts` (after `builderPlan`)

**Interfaces:**
- Consumes: Task 1's `review_turn`, `RoleReview`, `ReviewRole`, `prd_step_ids`.
- Produces:
  - Rust `ReviewStepArgs { project_id, project_name, harness: String, model: Option<String>, role: ReviewRole, prd: String, earlier: Vec<RoleReview> }`, `#[serde(rename_all = "camelCase")]`.
  - `pub fn run_review_step(store: &SqliteStore, args: ReviewStepArgs) -> Result<RoleReview, String>`: same runtime and work-dir setup as `run_plan`. It saves nothing.
  - TS types `ReviewRole = "engineer" | "ux" | "qa" | "contrarian" | "leader"`, `Finding { severity: "blocker" | "suggestion"; step: string | null; text: string }` and `RoleReview { role; findings: Finding[]; verdict: string; fixes: string }`.
  - `builderReviewStep(args: { projectId: string; projectName: string; harness: string; model: string | null; role: ReviewRole; prd: string; earlier: RoleReview[] }): Promise<RoleReview>`, which throws `"A real agent needs the desktop app"` outside Tauri, like `builderPlan`.

- [ ] **Step 1: Implement** the args, `run_review_step`, the command (`spawn_blocking`, same shape as `builder_plan`), its registration, and the TS wrapper and types.
- [ ] **Step 2: Verify.** Run `cargo check -p panguyuban-desktop` (or the crate name in `src-tauri/Cargo.toml`) and `npm run build` in `apps/panguyuban-desktop`. Expect both to pass with no errors.
- [ ] **Step 3: Commit.** `git commit -m "Add builder_review_step command"`

### Task 3: Review state (pure TS) and persistence

**Files:**
- Create: `apps/panguyuban-desktop/src/team_review.ts`. It must be self-contained, with only `import type` from `./api`, so Node can run it.
- Create: `apps/panguyuban-desktop/src/team_review.check.mjs`, run with `node src/team_review.check.mjs`.
- Modify: `apps/panguyuban-desktop/src/builder_flow.ts`: add `teamReview: TeamReview | null` to `Project`, `null` in `createProject`, and in `parseProjects` set `teamReview: p.teamReview ? interrupt(p.teamReview) : null`. Add `"review"` to `LogEntry["kind"]`.

**Interfaces:**
- Consumes: Task 2's TS `ReviewRole` and `RoleReview`.
- Produces:
  - `type NodeStatus = "waiting" | "working" | "done" | "failed"`
  - `interface ReviewNode { status: NodeStatus; result: RoleReview | null; error: string | null }`
  - `interface TeamReview { prd: string; startedAt: number; finishedAt: number | null; nodes: Record<ReviewRole, ReviewNode> }`
  - `const SPECIALISTS: ReviewRole[] = ["engineer", "ux", "qa"]`, plus `ROLE_LABEL: Record<ReviewRole, string>` (`"Engineer"`, `"UX"`, `"QA"`, `"Contrarian"`, `"Leader"`).
  - `startReview(prd: string, now: number): TeamReview`: every node waiting.
  - `setNode(r: TeamReview, role: ReviewRole, patch: Partial<ReviewNode>, now: number): TeamReview`: sets `finishedAt = now` once `reviewState` becomes `"done"` or `"stopped"`.
  - `nextWave(r: TeamReview): ReviewRole[]`: waiting specialists if any. Otherwise `[]` while a specialist is working. Otherwise `["contrarian"]` if it is waiting and at least one specialist is done. Otherwise `["leader"]` if it is waiting, the Contrarian is done or failed, and at least one specialist is done. Otherwise `[]`.
  - `earlierFor(r: TeamReview, role: ReviewRole): RoleReview[]`: Contrarian gets the done specialists' results. Leader gets those plus the Contrarian's if done. Specialists get `[]`.
  - `retryFrom(r: TeamReview, role: ReviewRole): TeamReview`: resets that node and every later wave (Contrarian, Leader) to waiting, and clears their result, error and `finishedAt`.
  - `reviewState(r: TeamReview): "running" | "done" | "stopped"`: `stopped` when every specialist failed, `done` when the Leader is done or failed, otherwise `running`.
  - `interrupt(r: TeamReview): TeamReview`: working nodes become failed with `error = "Interrupted, run again"`.
  - `isStale(r: TeamReview, prd: string): boolean`: `r.prd !== prd`.
  - `reviewSummary(r: TeamReview): string`: running gives `"<n> of 5 done"`, counting done and failed. Done gives `"done · <b> blocker(s)"` from the Leader's findings, or `"done · no verdict"` if the Leader failed. Stopped gives `"stopped"`.

- [ ] **Step 1: Write the failing check** `team_review.check.mjs` (`import assert from "node:assert/strict"`, `import {...} from "./team_review.ts"`), with one block per case:
  - `first_wave_is_the_specialists`: `nextWave(startReview("p", 0))` deep-equals `["engineer","ux","qa"]`.
  - `contrarian_waits_for_all_specialists`: with engineer done, ux working and qa done, the wave is `[]`. With ux done, the wave is `["contrarian"]`, and `earlierFor(r,"contrarian").length === 3`.
  - `leader_runs_after_contrarian_fails`: with the specialists done and the Contrarian failed, the wave is `["leader"]`.
  - `stops_when_every_specialist_failed`: all 3 failed gives `nextWave` `[]`, `reviewState` `"stopped"` and `finishedAt !== null`.
  - `retry_leader_keeps_the_rest`: with everything done except a failed Leader, `retryFrom(r,"leader")` leaves 4 nodes done and sets the Leader to waiting.
  - `retry_specialist_resets_later_waves`: `retryFrom(r,"ux")` sets ux, contrarian and leader to waiting and keeps engineer and qa done.
  - `interrupt_marks_working_nodes_failed`: a working node becomes failed with `"Interrupted, run again"`, and done nodes stay done.
  - `stale_after_prd_changes`: `isStale(startReview("a",0),"b") === true`.
  - `summary_counts_blockers`: when the Leader is done with 1 blocker and 1 suggestion, the summary is `"done · 1 blocker"`.
- [ ] **Step 2: Run it and see it fail.** Run: `node src/team_review.check.mjs` and expect a module-not-found or assertion failure.
- [ ] **Step 3: Implement** `team_review.ts`, then make the `builder_flow.ts` changes listed under Files.
- [ ] **Step 4: Verify.** Run `node src/team_review.check.mjs` (expect no output, exit 0) and `npm run build` (expect it to pass).
- [ ] **Step 5: Commit.** `git commit -m "Add team review state to builder projects"`

### Task 4: Live flow diagram on the PRD tab

**Files:**
- Create: `apps/panguyuban-desktop/src/TeamFlow.tsx`
- Modify: `apps/panguyuban-desktop/src/Builder.tsx` (`PrdTab` ~line 1194; add the runner next to `useAgentTurn`)
- Modify: `apps/panguyuban-desktop/src/styles/app.css` (add `.team-flow*` rules using the existing tokens from `tokens.css`)

**Interfaces:**
- Consumes: Task 2's `builderReviewStep`; Task 3's helpers; `agentById`, `prdMarkdown`, `userSays`, `approvePrd` and `record` from `builder_flow.ts` (export `record` if it is not already exported).
- Produces:
  - `TeamFlow({ review, now, onRetry }: { review: TeamReview; now: number; onRetry?: (role: ReviewRole) => void })`: the diagram `PRD → [Engineer|UX|QA] → Contrarian → Leader`. Each node is a `<button>` showing its label, a status dot, and either its finding count, "working…", "waiting" or "failed". Clicking a node shows its findings below (blocker/suggestion tag, step, text) or its error, plus **Retry** when `onRetry` is given and the node failed. The Leader's verdict and final findings show under the diagram once done. While running it shows elapsed time `duration(now - startedAt)` (import `duration` from `./Agents`). No Apply or Approve buttons inside.
  - `runTeamReview(builder: Builder, projectId: string, review: TeamReview): Promise<void>`, exported from `Builder.tsx`.

- [ ] **Step 1: Implement `runTeamReview`.** Guard it with a module-level `reviewsInFlight: Set<string>`. Loop: `wave = nextWave(local)`, and stop if it is empty. Mark the wave working. Run `Promise.allSettled(wave.map(role => builderReviewStep({ …agent harness/model from agentById(p.interviewAgent), role, prd: local.prd, earlier: earlierFor(local, role) })))`. Write each result into `local` with `setNode`, and push it with `builder.updateById(id, p => …)`. Inside that updater, return `p` unchanged when `!p.teamReview`, `p.prdApproved`, or `isStale(p.teamReview, prdMarkdown(p))`. That is how late results get dropped. When `reviewState` leaves `"running"`, add `record(p, "review", "Team review: " + reviewSummary(local))`.
- [ ] **Step 2: Wire `PrdTab`.** When `isLive(project) && project.prdText && !project.prdApproved`, show **Review with team** (or **Run again** when a review exists) next to the existing doc view. It calls `startReview(prdMarkdown(project), Date.now())`, saves it to `teamReview`, then calls `runTeamReview`. Render `<TeamFlow>` above the `<pre className="doc-view">` when `project.teamReview` exists, with `onRetry={role => run retryFrom(...)}`. Under it:
  - When `reviewState` is `"done"` and the Leader's `fixes` is non-empty, show **Apply fixes**, which calls `builder.update(p => userSays(p, fixes))`.
  - Show **Approve anyway**, which calls `builder.update(approvePrd)`, while not approved.
  - When `isStale`, show the banner "PRD changed since this review" with **Run again**.
  - When `reviewState` is `"stopped"`, show "No specialist could finish, so the review stopped."
- [ ] **Step 3: Verify.** Run `npm run build` and expect it to pass. Then run the app (`npm run tauri dev`) with a live builder project that has a draft PRD, press **Review with team**, and check:
  - The specialist nodes turn amber together, then green one by one.
  - The Contrarian starts only after all three finish, and the Leader last.
  - Clicking a node shows its findings.
  - **Apply fixes** posts the message and the interview revises the PRD, after which the stale banner shows.
  - Quitting mid-run and reopening shows "Interrupted, run again".
- [ ] **Step 4: Commit.** `git commit -m "Show PRD team review as a live flow diagram"`

### Task 5: Team reviews on the Agents page

**Files:**
- Modify: `apps/panguyuban-desktop/src/Agents.tsx` (`AgentsView` ~lines 105–219)
- Modify: `apps/panguyuban-desktop/src/App.tsx` (the `<AgentsView` props ~line 1278)
- Modify: `apps/panguyuban-desktop/src/styles/app.css` (`.agents-strip` for the five-bar strip)

**Interfaces:**
- Consumes: `TeamFlow` (Task 4), `reviewState`, `reviewSummary` and `SPECIALISTS` (Task 3), `builder.projects` and `builder.select`, and `agentById` for the harness label.
- Produces: new `AgentsView` props `teams: { projectId: string; name: string; agentLabel: string; review: TeamReview }[]` and `onOpenTeam: (projectId: string) => void`.

- [ ] **Step 1: Implement.**
  - `App.tsx` passes `teams` built from `builder.projects.filter(p => p.teamReview)`, and `onOpenTeam = id => { builder.select(id); setSection("builder"); }`.
  - In `AgentsView`, a team counts as `busy` when `reviewState === "running"` and as `idle` otherwise. Include teams in the header count and the filter counts.
  - Render a **Team reviews** `ticket-group` above the session groups, holding the teams that match the filter. Each row is a `ticket-row` button with `selectedId === "team:" + projectId`. It shows the name, elapsed time, and the meta line `PRD review · <agentLabel> · <reviewSummary>`, with a five-bar `.agents-strip` in role order coloured by node status.
  - When the selection is a team id, the detail pane shows the project name, the line "PRD review · <agentLabel> · started <duration> ago", an **Open in Prototypes →** button calling `onOpenTeam`, and `<TeamFlow review now />` with no `onRetry` (read-only).
  - Keep the "No agent sessions running" empty text only when there are also no teams.
- [ ] **Step 2: Verify.** Run `npm run build` and expect it to pass. In `npm run tauri dev`, start a review, open Agents, and check:
  - The row appears under **Working** and its bars update live.
  - Selecting it shows the diagram.
  - **Open in Prototypes** lands on that project's builder.
  - Once finished, it moves under **Idle**.
- [ ] **Step 3: Commit.** `git commit -m "Show team reviews on the Agents page"`
