# Panguyuban Blueprint & Architecture Specification

**Date:** 2026-11-11  
**Status:** Draft for Approval  
**Target Platforms:** macOS, Linux, Windows  
**Core Stack:** Rust (Workspace Core + Adapters) + Tauri v2 (Desktop App Shell)  
**UI Design System:** Hallmark v2.0.0 (`Console` theme — Graphite / Host Grotesk / Atkinson Hyperlegible Mono)

---

## 1. Intent & Why

Developers lose focus switching between an issue tracker browser tab (Plane.so) and a git forge browser tab (GitHub) just to find out which ticket is ready to branch, which pull request is waiting on review, and which approved pull request can be merged and closed.

**Panguyuban** is a native cross-platform desktop application written in Rust (powered by Tauri v2) that unifies **ticket management** and **git pull request review/merge** into one fast, keyboard-first instrument. Backend logic and platform integrations are strictly separated into Rust crates behind traits so:
1. You can swap **Plane.so** for Linear/Jira or **GitHub** for GitLab/Gitea without rewriting the app or UI.
2. The Tauri desktop app ships first, while a future **CLI binary (`pgy`)** can import the exact same `panguyuban-core` crate later with zero duplication.

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals (v0.1 Desktop MVP)
- **Dedicated Tickets Menu (Plane.so):** List assigned/backlog/in-progress tickets, inspect description & state, create new tickets, transition ticket states (`Todo` -> `In Progress` -> `Done`), and create/checkout a local git branch named after the ticket key (e.g., `feat/pan-149-rate-limit`).
- **Dedicated Git & PR Menu (GitHub + Local Git):** List pull requests in **Git to review** and **Git to merge** queues, display CI check status, review approvals, linked ticket ID, summary diff excerpt, and execute **Approve PR** or **Squash & Merge PR + Close Linked Plane Ticket** in one action.
- **Modular Provider Architecture:** Define `IssueProvider` and `GitProvider` traits in `panguyuban-core` with initial implementations in `provider-plane` and `provider-github`.
- **Local-First Responsiveness:** Cache tickets, pull requests, and ticket-to-PR links in a local SQLite database (`sqlx` / `rusqlite`) so switching views is instant (<16ms), while syncing in the background.
- **Cross-Platform Security:** Store Plane API tokens and GitHub Personal Access Tokens in the native OS keychain (`keyring` crate: macOS Keychain, Linux Secret Service, Windows Credential Manager).

### Non-Goals (Deferred to Later Versions)
- **CLI Binary (`pgy`):** Architectural hooks remain in `panguyuban-core`, but the CLI crate will be built after the Tauri desktop app is stable.
- **Full Inline Multi-File Code Review Editor:** v0.1 shows PR metadata, CI checks, review state, and a summary diff preview (with a quick link to open full multi-file diffs on GitHub when needed). Full inline line-by-line commenting will come in v0.2.
- **Sprint / Cycle Analytics & Automation Rules:** Reserved as future sidebar modules.

### Anti-Goals (What Would Make This a Failure)
- **Hardcoding Plane.so or GitHub payloads inside UI components:** The frontend must only ever speak to `panguyuban-core` domain structs (`Ticket`, `PullRequest`, `LinkedRecord`).
- **Bloated Electron memory footprint:** Must stay a lean Tauri v2 + Rust binary.

---

## 3. UI & Visual Design Blueprint (Hallmark `Console` System)

The interactive Hallmark HTML/CSS prototype is located in:
- [`design/hallmark/index.html`](file:///Users/ansar/project/panguyuban/design/hallmark/index.html)
- [`design/hallmark/app.css`](file:///Users/ansar/project/panguyuban/design/hallmark/app.css)
- [`design/hallmark/tokens.css`](file:///Users/ansar/project/panguyuban/design/hallmark/tokens.css)
- [`design/hallmark/base.css`](file:///Users/ansar/project/panguyuban/design/hallmark/base.css)

### 3.1 Three-Pane Split Layout (`Layout A` with Separated Sidebar Menus)
```text
+-----------------------------------------------------------------------------------+
| Topbar: Panguyuban   [Plane: panguyuban-core] [GitHub: ansar/panguyuban]          |
+--------------------+------------------------------+-------------------------------+
| LEFT SIDEBAR       | MIDDLE QUEUE PANE            | RIGHT INSPECTOR PANE          |
|                    |                              |                               |
| Tickets (Plane.so) | [Search / Filter input]      | PAN-142 / PR #89 Header       |
|  - Assigned to me  |                              |                               |
|  - Todo queue      | +--------------------------+ | Description / Summary         |
|  - In progress     | | [Inspect PAN-142] [Ready]| |                               |
|                    | | Fix JWT refresh race     | | +-------+---------+---------+ |
| Git & Pull Requests| | @ansar         In review | | | State | Linked  | CI      | |
|  - Git to review   | +--------------------------+ | | Review| PR #89  | 3/3 pass| |
|  - Git to merge    | | [Inspect PAN-145]        | | +-------+---------+---------+ |
|  - Local branches  | | Add exponential backoff  | |                               |
|                    | | @alex        In progress | | Audit Trail / Summary Diff    |
| System             | +--------------------------+ |                               |
|  - Settings &      |                              | [Primary Action Button]       |
|    providers       |                              | [Secondary Actions]           |
+--------------------+------------------------------+-------------------------------+
```

### 3.2 Hallmark `Console` Material Tokens
- **Surface Hierarchy:** Three stepped graphite OKLCH layers (`--color-paper: oklch(17% 0.008 250)`, `--color-paper-2: oklch(21% 0.009 250)`, `--color-paper-3: oklch(13.5% 0.007 250)`) separated by `1px` `--color-rule` hairlines (`oklch(31% 0.01 250)`). No drop shadows or neon glows.
- **Typography:** `Host Grotesk` (400, 500) for human reading, headings, and controls; `Atkinson Hyperlegible Mono` (400, 500, `tabular-nums slashed-zero`) strictly for instrument readings, ticket keys (`PAN-142`), PR numbers (`#89`), timestamps, and diff lines.
- **Semantic Colour Signals:**
  - **Amber (`--color-accent: oklch(82% 0.15 80)`):** Marks human actors (`@ansar`, `@alex`), items needing human review, and the single primary action button per screen.
  - **Cool Blue (`--color-cool: oklch(77% 0.12 245)`):** Marks instrument/system telemetry, repository bindings, and timestamps.
  - **OK / Bad (`--color-ok`, `--color-bad`):** Used exclusively for CI status and code diff additions/deletions.
- **Data States:** Every data pane implements all four states (`full`, `loading` skeleton, `empty` with sync action, and `error` with recovery action).

---

## 4. Modular Rust Workspace Architecture

```text
panguyuban/
├── Cargo.toml                     # Rust Workspace manifest
├── design/
│   └── hallmark/                  # Hallmark v2.0.0 Console reference HTML/CSS
├── crates/
│   ├── panguyuban-core/           # Domain models, traits, SQLite cache, linking engine
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── models.rs          # Ticket, PullRequest, CiStatus, ReviewDecision
│   │       ├── traits.rs          # IssueProvider, GitProvider, SecretStore
│   │       ├── linker.rs          # Regex/branch matching between Ticket Key <-> PR
│   │       ├── storage.rs         # Local SQLite cache (rusqlite / sqlx)
│   │       └── service.rs         # High-level orchestration (merge_pr_and_close_ticket)
│   ├── provider-plane/            # Plane.so REST API v1 implementation of IssueProvider
│   │   └── src/lib.rs
│   ├── provider-github/           # GitHub REST/GraphQL + local git2 implementation of GitProvider
│   │   └── src/lib.rs
│   └── panguyuban-cli/            # (Deferred Phase 2) Thin CLI binary calling panguyuban-core
└── apps/
    └── panguyuban-desktop/        # Tauri v2 Desktop App
        ├── src-tauri/             # Tauri Rust bridge exposing panguyuban-core commands
        │   ├── Cargo.toml
        │   └── src/
        │       ├── main.rs
        │       └── commands.rs    # #[tauri::command] handlers
        └── src/                   # Frontend UI consuming Hallmark tokens.css & base.css
```

### 4.1 Core Domain Models (`crates/panguyuban-core/src/models.rs`)

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum TicketState {
    Backlog,
    Todo,
    InProgress,
    InReview,
    Done,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ticket {
    pub id: String,              // Internal UUID from provider
    pub key: String,             // Human key, e.g., "PAN-142"
    pub title: String,
    pub description: String,
    pub state: TicketState,
    pub assignee: Option<String>,
    pub priority: Option<String>,
    pub updated_at: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ReviewState {
    ReviewRequired,
    Approved,
    ChangesRequested,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum CiState {
    Pending,
    Passing { passed: usize, total: usize },
    Failing { failed: usize, total: usize },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PullRequest {
    pub number: u64,             // e.g., 89
    pub title: String,
    pub author: String,
    pub source_branch: String,   // e.g., "fix/pan-142-jwt"
    pub target_branch: String,   // e.g., "main"
    pub mergeable: bool,
    pub additions: u32,
    pub deletions: u32,
    pub review_state: ReviewState,
    pub ci_state: CiState,
    pub linked_ticket_key: Option<String>, // Extracted by linker (e.g. "PAN-142")
    pub diff_preview: Vec<String>,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Copy)]
pub enum MergeMethod {
    Squash,
    MergeCommit,
    Rebase,
}
```

### 4.2 Modular Provider Traits (`crates/panguyuban-core/src/traits.rs`)

```rust
use async_trait::async_trait;
use crate::models::{MergeMethod, PullRequest, Ticket, TicketState};

#[async_trait]
pub trait IssueProvider: Send + Sync {
    fn provider_name(&self) -> &'static str;
    async fn list_tickets(&self) -> Result<Vec<Ticket>, CoreError>;
    async fn get_ticket(&self, key: &str) -> Result<Ticket, CoreError>;
    async fn create_ticket(&self, title: &str, description: &str) -> Result<Ticket, CoreError>;
    async fn transition_ticket(&self, key: &str, next: TicketState) -> Result<Ticket, CoreError>;
}

#[async_trait]
pub trait GitProvider: Send + Sync {
    fn provider_name(&self) -> &'static str;
    async fn list_pull_requests(&self) -> Result<Vec<PullRequest>, CoreError>;
    async fn approve_pull_request(&self, number: u64) -> Result<PullRequest, CoreError>;
    async fn merge_pull_request(&self, number: u64, method: MergeMethod) -> Result<(), CoreError>;
    fn create_and_checkout_branch(&self, branch_name: &str) -> Result<(), CoreError>;
    fn checkout_existing_branch(&self, branch_name: &str) -> Result<(), CoreError>;
}
```

### 4.3 Ticket-to-Git Linking Engine (`crates/panguyuban-core/src/linker.rs`)
- Matches ticket keys (`[A-Z]{2,10}-\d+`, case-insensitive, such as `PAN-142`) against:
  1. PR `source_branch` (e.g., `fix/pan-142-jwt`)
  2. PR `title` (e.g., `fix(auth): PAN-142 serialize token refresh`)
- When a user clicks **"Squash and merge PR #89 + close PAN-142"**, `WorkflowService::merge_and_complete()` executes:
  1. `git_provider.merge_pull_request(89, MergeMethod::Squash).await?`
  2. `issue_provider.transition_ticket("PAN-142", TicketState::Done).await?`
  3. Updates the local SQLite cache and emits an event to the Tauri window.

---

## 5. Builder Calls & Defaults (Left to Builder / Sensible Defaults)

The following technical choices are set as sensible defaults so implementation can proceed cleanly:
- **Tauri Frontend Stack:** TypeScript + React (Vite) inside `apps/panguyuban-desktop/src`, directly importing the Hallmark `tokens.css`, `base.css`, and `app.css` classes generated in `design/hallmark/` so the live app matches the approved HTML prototype pixel-for-pixel.
- **Local Git Operations:** Use the `git2` crate (libgit2 bindings) inside `provider-github` for local branch creation and checkout against the user's configured local repository path, combined with `reqwest` + `tokio` for GitHub REST v3 API calls.
- **Plane.so Integration:** Use `reqwest` against Plane REST API v1 (`/api/v1/workspaces/{slug}/projects/{project_id}/issues/`).
- **Local Cache & Config:** Store non-secret workspace settings (active provider names, Plane slug, project ID, GitHub `owner/repo`, local repo path) in SQLite inside the OS app data folder (`dirs::data_local_dir()/panguyuban/state.db`), and store API tokens in OS Keychain via the `keyring` crate.
