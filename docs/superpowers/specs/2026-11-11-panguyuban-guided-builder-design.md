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
| **Session** | One chat thread inside a project, bound to exactly one skill for its whole life. |
| **Session type** | What the user picks. Maps to a skill and an opening behaviour. |
| **Brief** | The approved specification and MVP scope. Stored as `brief.md` in the project. |
| **Standards status** | Result of the deterministic checks: passing, or a plain-language list of what is blocked. |
| **Handover package** | Brief + decision log + mock/real inventory + open items, generated on demand. |

### 3.1 Session types (initial set)

| User sees | Skill attached | Available when |
|---|---|---|
| Start a new app | `rey-nextjs-app` | Always (creates the project) |
| Add a screen or page | `rey-nextjs-frontend` | Brief approved |
| Add a feature or data behind it | `rey-nextjs-module` | Brief approved |
| Design the data | `rey-db-design` | Brief approved |

The mapping lives in a registry file, not in code, so engineering can add session types without a release of the UI.

## 4. The Session Flow

```text
Discover  ->  Brief approved  ->  Build  ->  Preview  ->  Hand over
(interview)   (user confirms)     (skill)    (share)      (package)
```

### 4.1 Discover (the interview)
The agent asks, one question at a time, in plain language. It may not write app code in this phase. It must cover:

- **Who and why:** which client, what problem, who will use it.
- **What it must show:** the screens or steps the client needs to see.
- **MVP scope:** sorted into *must have for the demo*, *later*, and *not doing*.
- **Data:** what information appears, confirmed as synthetic.
- **What is faked:** integrations or logic that will be mocked for the demo.
- **Deadline and audience:** when it is shown and to whom.

The agent ends by presenting the brief. The user approves or corrects it. Approval unlocks the build phase and the other session types.

### 4.2 Build
The agent works with the bound skill and the approved brief as fixed context. A request outside the MVP scope is not refused; the agent points out it is outside the brief and asks whether to update the brief. Scope changes are therefore recorded, not silent.

### 4.3 Preview
The right pane runs the app. "Share preview with client" is the primary action and is enabled only when standards status is passing.

### 4.4 Hand over
"Hand over to engineering" generates `handover.md` and marks the project read-only for the builder. Contents:

- The brief, including every recorded scope change.
- Decision log: each user request and what changed, in order.
- Mock/real inventory: which data and integrations are faked.
- What was promised to the client during the demo (asked of the user at handover).
- Standards status and any waived checks.

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
- The skill is set when the session is created and is immutable.
- The phase is held by `panguyuban-core`, not by the agent. In `Discover`, the runtime is started with file-write and shell tools disabled, so the agent cannot build early whatever it is told.
- Standards checks run in Rust after every agent turn. The UI reads `StandardsStatus`; the agent's own claim that things pass is never used.

### 6.4 The record (hidden git)
Each project folder is a git repository the user never sees. `panguyuban-core` commits after every agent turn with the user's message as the commit subject. The decision log and handover are derived from this history plus the stored chat. The local-git code in the existing `provider-github` crate can be reused for this.

## 7. Decisions needed before planning

1. **Agent runtime.** Default assumption: drive Claude Code in headless mode as a child process and parse its streamed events. To verify: the exact flags for restricting tools per phase and for loading a single skill, and how each user's machine is authenticated.
2. **Where the app runs.** Local preview needs Node on the user's machine. Alternative: a remote sandbox per project, which removes local setup but adds infrastructure.
3. **How skills are distributed and updated.** Bundled with the app, or pulled from a company repository on launch.
4. **How a client sees the preview.** Screen share only in v0.1, or a hosted preview link (needs a deploy target and access control).
5. **Where handover lands.** A folder and a notification in v0.1, or pushed to the company git forge.
6. **Notifying engineering at project start**, so consultation happens before the demo, not after.
