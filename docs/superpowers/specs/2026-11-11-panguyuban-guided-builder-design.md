# Panguyuban Guided Builder — Product & Architecture Specification

**Date:** 2026-11-11
**Status:** Draft for approval
**Supersedes:** `2026-11-11-panguyuban-blueprint-design.md` for product scope. That document's Plane/GitHub menus were placeholder content used to design the layout. Its shell decisions (Tauri v2, Rust workspace, three-pane layout, Hallmark `Console` theme) still stand.

---

## 1. Intent & Why

Teams at the company sometimes build something to show a client without consulting engineering first, then hand it over. Two things go wrong:

1. The build does not follow our standards, so engineering has to rework or rebuild it.
2. The context is lost: nobody can tell what was asked for, what was decided, what is real and what is faked.

**Panguyuban** is a desktop app where a non-technical user builds a prototype by chatting. Each chat session is bound to one of our skills, so the agent works inside our rules by construction. Before anything is built, the agent interviews the user to produce a specification and an MVP scope. Everything the session produces is recorded, so a handover carries its own context.

## 2. Goals, Non-Goals, Anti-Goals

### Goals (v0.1)
- **Chat sessions bound to a skill.** The user picks what they want to do in plain language; the app attaches the matching skill. The user never sees or chooses a skill name.
- **Discovery before building.** Every new project starts with an interview that ends in an approved brief: the specification plus the MVP scope.
- **Standards enforced by checks, not by prompt.** Lint, typecheck and tests run after each agent turn; failures block "Share preview" and "Hand over".
- **Live preview.** The user judges the running app, never a diff.
- **Handover package generated from the session record.**

### Non-Goals (v0.1)
- Deploying to production. Output is a handover-ready prototype; engineering owns the path to production.
- Tickets and pull-request menus (the placeholder screens).
- Letting users write or edit skills.
- Multi-user collaboration on one session.

### Anti-Goals
- **A guarded path slower than the unguarded one.** If this is harder than opening a public AI builder, people will go around it.
- **Real client data in a prototype.** Sessions use synthetic data only.
- **Free-form sessions with no skill attached.** That recreates the problem this app exists to prevent.

## 3. Core Concepts

| Concept | Meaning |
|---|---|
| **Project** | One prototype. A folder on disk with a hidden git history, a brief, and one or more sessions. |
| **Session** | One chat thread inside a project, bound to one product skill for its whole life, plus an allowlist of engineering skills. |
| **Session type** | What the user picks, in product terms. Maps to a product skill and the engineering skills it may use. |
| **Brief** | The approved specification and MVP scope. Stored as `prd.md` in the project. |
| **Standards status** | Result of the deterministic checks: passing, or a plain-language list of what is blocked. |
| **Handover package** | Brief + decision log + mock/real inventory + open items, generated on demand. |

### 3.1 Session types (initial set)

The user only picks product-level things. They never choose between backend, frontend or database work.

| User sees | Product skill | Engineering skills | Available when |
|---|---|---|---|
| Start a new app | `prd-interview` | none | Always (creates the project) |
| Build the next step | `build-story` | any in `skills/engineering/` | PRD approved |
| Change something | `change-request` | any in `skills/engineering/` | PRD approved |
| Hand over to engineering | `handover-writer` | none | PRD approved |

A build session works on one story from `prd.md`. The agent loads whichever engineering skills that story needs; the REY skills already refer to each other (design tables, then the backend layers, then the pages), so binding a session to a single one would cut that chain.

The mapping lives in `skills/registry.toml`, not in code, so engineering can add session types without a release of the UI.

## 4. The Session Flow

**Revised 2026-11-12.** The non-technical user does not produce application code. They produce a working HTML prototype on made-up data, show it to the client, and hand over. Building the real app is a separate choice on the same prototype, open to engineers (or anyone) at the end, so the flow is one way and both kinds of user share it.

```text
user -> interview -> prototype -> show client -> hand over to engineering
                                              \-> build it here -> plan -> set up -> build -> hand over
```

| # | Stage | What the user does | What the app and agent do | Gate to move on |
|---|---|---|---|---|
| 1 | Start | Names the prototype and the client; may paste a description or load an existing PRD | Creates the project and its record; notifies engineering that it exists | None |
| 2 | Interview | Answers only what the description left out, one question at a time | Runs `prd-interview`, writes `prd.md`. A PRD already in the library's format is used as it is, reset to Draft | User approves the PRD |
| 3 | Prototype | Tries each step in the Preview tab and ticks every acceptance line; asks for changes in the chat | Runs `html-prototype`: one working HTML file on made-up data, saved as `design.html`. A revision clears the ticks | Every line ticked, no change pending |
| 4 | Show | Shows the file to the client, then answers three questions | Records the reaction, what was promised in the room, and what they asked for next. A change asked for before showing goes back to stage 3 | Three answers |
| 5 | Hand over | Chooses **Hand over to engineering** or **Build it here** | Hand over writes `handover.md` and locks the prototype | None for a prototype |
| 6 | Plan (build path) | Reads the sizing; clears or defers flagged steps | Runs `prd-to-stories` | Flagged steps cleared |
| 7 | Set up (build path) | Waits | Scaffolds from the REY template | Standards checks pass |
| 8 | Build (build path) | Confirms each step against its acceptance lines | Builds one step at a time with the assigned agent, runs checks | Checks pass and user confirms |
| 9 | Hand over (build path) | Hands over the built app | Writes `handover.md` naming the agent per step | Standards checks pass |

"Build it here" can also be chosen after a prototype has been handed over, which reopens it; this is how an engineer picks up someone else's prototype on the same machine. It can be chosen once.

### 4.1 Rules that hold across stages
- **Engineering is told at stage 1, not asked.** Engineers act only when a story is flagged (a real system, sign-in, real data) or when the user asks for help.
- **Nothing runs on the user's machine before the build path.** The prototype is one file shown in a locked frame; no Node, no installs, no agent with file or command access.
- **The user checks every acceptance line against the prototype.** On the build path there is a second check per step, owned by the app: the standards checks. Both must pass there.
- **"Ask an engineer" is available at every stage.** If the agent fails the same check repeatedly it stops and offers it; the engineer receives the story, the error and the record.
- **Every built step can be undone** until the built app is handed over.
- **A request outside the PRD is recorded, not refused.** The user chooses: small fix, something new (added as a story, scope change logged), or later.
- **Interview rules** (one question at a time, plain language, never technical questions, sample data only) are defined in `skills/product/prd-interview/SKILL.md`.

### 4.2 Handover contents
- The PRD, including every recorded scope change.
- What was built, story by story, and what was parked for later.
- What is real and what is pretend.
- What was promised to the client, before the demo and in the room.
- The client's reaction and what they asked for next.
- Standards status, skill library version, and the full record.

### 4.3 Implementation status (2026-11-12)
**Connected to a real agent: the interview, the prototype, and the plan on the build path.** `crates/agent-runtime` runs one stateless turn at a time: the interview skill, the PRD template and the whole conversation go in; the agent's next message comes out. The agent gets no tools. It returns the PRD between `<prd>` tags and the app saves it to `<Documents>/Panguyuban/<name>-<id>/prd.md`, then reads the steps, acceptance criteria and later list from it. Approval rewrites the saved file with `Status: Approved`.

- Claude Code (`claude -p`, tools, MCP servers and skills switched off): tested against a real install, including a full PRD from the skill.
- Antigravity (`agy -p`): written from third-party documentation, not tested. It has no known way to switch tools off, so "no tools" rests on the instructions alone.
- The skill, template and registry version are compiled into the binary; the agent list is still mirrored in `builder_flow.ts`.

After approval the same agent runs `prd-to-stories` on the approved PRD: it returns a size (`small` or `hard`), an engineer flag and a one-sentence reason per step, saved as `plan.json` beside `prd.md`. Set up stays blocked until the plan arrives; if the agent fails, the user can retry or continue with the built-in keyword sizing. The agent may not add, merge, drop or rename steps.

**The prototype (stage 3) is connected.** The agent returns one HTML file between `<design>` tags: one inline script, no libraries, nothing loaded from outside, no network or storage calls, data as plain constants, each screen marked `data-step`, pretend parts marked `// PRETEND:`, design decisions as CSS variables. The app shows it in a frame sandboxed to `allow-scripts allow-forms` (no same-origin, so no access to the app or to storage) under a content security policy that allows inline script and style only and blocks every network load and form submission. A change request sends the current file and the request back to the agent. `html-prototype` is the library's stand-in for the Hallmark skill, which is not in the repository yet. To verify on macOS: that the sandboxed frame has no Tauri IPC (`window.__TAURI_INTERNALS__` undefined inside it).

The plan (`prd-to-stories`) is connected too, but now runs only when "Build it here" is chosen.

**Still simulated (build path only):** set up, build, standards checks (always pass), the preview, engineering notifications, escalation and handoff notes. With no agent installed, or in the browser preview, the interview falls back to the scripted stand-in. Project state other than `prd.md` is kept in the webview's local storage.

## 5. Layout (three panes, Hallmark `Console`)

```text
+--------------------+------------------------------+-------------------------------+
| LEFT SIDEBAR       | MIDDLE: SESSION              | RIGHT: INSPECTOR              |
|                    |                              |                               |
| Projects           | [Phase: Discover > Build ..] | [Preview] [Brief] [Handover]  |
|  - My prototypes   |                              |                               |
|  - Handed over     | agent: Who is this for?      | Live app preview              |
|                    | you:   ...                   |                               |
| Sessions (project) |                              | Standards: passing / blocked  |
|  - Start a new app | [message input]              |                               |
|  - Add a screen    |                              | [Primary action button]       |
| Standards          |                              |                               |
| Settings           |                              |                               |
+--------------------+------------------------------+-------------------------------+
```

Colour semantics carry over: amber for the human and the single primary action, cool blue for agent/system output, ok/bad only for standards status. All four data states (full, loading, empty, error) apply to every pane.

## 6. Architecture

```text
crates/
├── panguyuban-core/      # Project, Session, Brief, phases, traits, SQLite, orchestration
├── runtime-claude/       # AgentRuntime implementation
├── skills-local/         # SkillRegistry implementation (reads skill folders + registry file)
└── checks-node/          # StandardsChecker implementation (lint, typecheck, tests)
apps/panguyuban-desktop/  # Tauri v2 shell, React UI
```

### 6.1 Traits (`panguyuban-core`)

```rust
#[async_trait]
pub trait AgentRuntime: Send + Sync {
    /// Starts or resumes a session with a fixed skill and working directory.
    async fn send(&self, session: &Session, message: &str)
        -> Result<EventStream, CoreError>;
    async fn cancel(&self, session_id: &str) -> Result<(), CoreError>;
}

pub trait SkillRegistry: Send + Sync {
    fn session_types(&self) -> Result<Vec<SessionType>, CoreError>;
    fn resolve(&self, session_type_id: &str) -> Result<Skill, CoreError>;
}

#[async_trait]
pub trait StandardsChecker: Send + Sync {
    async fn check(&self, project: &Project) -> Result<StandardsStatus, CoreError>;
}
```

### 6.2 Models

```rust
pub enum Phase { Discover, Build, HandedOver }

pub struct Project { pub id: String, pub name: String, pub path: PathBuf,
                     pub phase: Phase, pub brief_approved_at: Option<String> }

pub struct Session { pub id: String, pub project_id: String,
                     pub session_type_id: String, pub skill_version: String,
                     pub runtime_session_ref: Option<String> }

pub struct StandardsStatus { pub passing: bool, pub blocked: Vec<BlockedItem> }
```

`skill_version` is stored on the session so a handover records which version of the standards the prototype was built against.

### 6.3 How the binding is enforced
- The product skill and the engineering allowlist are set when the session is created and are immutable. Only skills inside the app's library can be loaded.
- The phase is held by `panguyuban-core`, not by the agent. In `Discover`, the runtime is started with shell disabled and writes limited to `prd.md` (per `skills/registry.toml`), so the agent cannot build early whatever it is told.
- Standards checks run in Rust after every agent turn. The UI reads `StandardsStatus`; the agent's own claim that things pass is never used.

### 6.4 The record (hidden git)
Each project folder is a git repository the user never sees. `panguyuban-core` commits after every agent turn with the user's message as the commit subject. The decision log and handover are derived from this history plus the stored chat. The local-git code in the existing `provider-github` crate can be reused for this.

### 6.5 Built-in skill library
The user never installs a skill. The app ships with a library and each session type points into it.

```text
skills/
├── registry.toml            # session type -> skill, section, phase, allowed writes
├── product/                 # talk to the non-technical user; plain language only
│   ├── prd-interview/       # Discover phase: interview, writes prd.md
│   ├── prd-to-stories/      # slices the approved PRD into build stories
│   └── handover-writer/
└── engineering/             # govern how code is written; never shown to the user
    ├── rey-nextjs-app/
    ├── rey-db-design/
    ├── rey-nextjs-module/
    ├── rey-nextjs-frontend/
    └── rey-nextjs-unit-test/
```

The two sections have different owners and different rules. Product skills decide *what* is built and must never ask technical questions. Engineering skills decide *how* it is built and are not open to the user's input.

- The library is bundled as an app resource and is read-only to the user.
- `SkillRegistry` gives the runtime only the session's product skill and its allowed engineering skills. Skills installed elsewhere on the machine are ignored, so every user builds against the same rules.
- The library carries a version. Each session stores the version it started with (`skill_version`), and the handover reports it.
- Engineering owns the library. Changing a standard means changing a skill here, then releasing or syncing.
- To verify with the runtime decision (7.1): how the chosen runtime is pointed at a single skill folder and prevented from loading others.

### 6.6 Orchestrator and agent assignment
One agent is the orchestrator (`[orchestrator]` in `skills/registry.toml`). It plans, splits a story into tasks, writes a handoff note for each, and reviews the result. Other agents are workers; they may be a cheaper model on the same harness or a different harness (Claude, Antigravity, others later), each behind its own `AgentRuntime` implementation.

- **The app dispatches and waits, not the orchestrator.** The orchestrator decides who gets a task; the app starts that agent as a process, waits for it to exit, runs the standards checks, and returns the result. Permissions and time limits come from the registry, so no agent can grant another more access.
- **Autopilot (default):** each story is sized `hard` or `small`. Hard goes to the lead tier, small to the first worker.
- **Assign by hand:** a person picks the agent per story. Stories left on Auto follow the routing.
- **Escalation:** a worker that fails the checks `max_attempts` times returns the task to the lead; if the lead fails, "Ask an engineer".
- **Context between agents lives in the project folder,** not in any agent's memory: `prd.md`, the record, and one handoff note per task (what was done, what failed, what is left). Per-harness rules files (`CLAUDE.md`, `GEMINI.md`) are generated from the same engineering skills.
- **The record names the agent** that built each story and whether it was picked by the orchestrator or by hand; the handover repeats it.

Implemented in the app with the stand-in agent: mode switch, per-story assignment, sizing by keyword, and the record. Not implemented: starting real agents, escalation, handoff notes.

## 7. Decisions needed before planning

1. **Agent runtime.** Decided for the interview: the agent's own command-line tool, one stateless turn per call, signed in as whoever is signed in on that machine (section 4.3). Still open for the build stage: how to limit an agent to the project folder and a set of commands, and how to pass it the engineering skills.
2. **Where the app runs.** Local preview needs Node on the user's machine. Alternative: a remote sandbox per project, which removes local setup but adds infrastructure.
3. **Skill library updates.** Decided: skills ship inside the app (section 6.5). Still open: whether the library also syncs from a company repository between app releases.
4. **How a client sees the preview.** Screen share only in v0.1, or a hosted preview link (needs a deploy target and access control).
5. **Where handover lands.** A folder and a notification in v0.1, or pushed to the company git forge.
6. **Notifying engineering at project start**, so consultation happens before the demo, not after.
