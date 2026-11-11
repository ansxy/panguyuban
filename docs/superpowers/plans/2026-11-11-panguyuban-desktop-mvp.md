# Panguyuban Desktop MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Panguyuban cross-platform Tauri v2 + Rust desktop workflow app with separated Plane.so Tickets and GitHub Pull Request menus, modular provider traits, local SQLite cache, and the Hallmark `Console` UI.

**Architecture:** A Cargo workspace separates `panguyuban-core` (domain models, `IssueProvider` and `GitProvider` traits, regex ticket-to-PR linker, SQLite cache, and workflow orchestration) from platform adapters (`provider-plane` and `provider-github`). The Tauri v2 desktop app (`apps/panguyuban-desktop`) exposes `panguyuban-core` services via `#[tauri::command]` handlers to a React/TypeScript frontend styled with the Hallmark `Console` CSS system (`design/hallmark/`).

**Tech Stack:** Rust (2021 edition), Tokio, Serde, `async-trait`, `rusqlite` (bundled), `reqwest`, `git2`, `keyring`, Tauri v2, React 18, TypeScript, Vite, Hallmark `Console` CSS (`tokens.css`, `base.css`, `app.css`).

**Spec:** `docs/superpowers/specs/2026-11-11-panguyuban-blueprint-design.md`

## Global Constraints

- **Target Platforms:** macOS, Linux, Windows.
- **Strict Separation:** The frontend must only ever speak to `panguyuban-core` domain structs (`Ticket`, `PullRequest`, `WorkspaceConfig`). Never leak raw Plane.so or GitHub API JSON shapes to the UI.
- **Modular Providers:** `IssueProvider` and `GitProvider` traits live in `crates/panguyuban-core` with initial implementations in `crates/provider-plane` and `crates/provider-github`.
- **Hallmark Console UI Floor:** Every colour and font goes through tokens declared in `tokens.css` (`--color-paper: oklch(17% 0.008 250)`, `--font-display: "Host Grotesk"`, `--font-outlier: "Atkinson Hyperlegible Mono"`). Never `transition: all`, never animate `width`/`height`/`top`/`left`, and every data region must support `full`, `loading`, `empty`, and `error` states.
- **Deferred Scope:** Do not build `crates/panguyuban-cli` or multi-file inline diff commenting in v0.1.

## Review Focus

1. **Case-insensitive and multi-key branch/title extraction (`fix/pan-142-jwt` vs `PAN-142`):** Branch names are almost always lowercase (`fix/pan-142-jwt`), while Plane ticket keys are uppercase (`PAN-142`). `extract_ticket_key` must normalize extracted keys to uppercase and return the first valid `[A-Z]{2,10}-\d+` key without matching false positives like `UTF-8` or `SHA-256`.
2. **Partial failure during `merge_and_complete` (GitHub PR merges, then Plane API fails):** If `git_provider.merge_pull_request` succeeds on GitHub, the PR is irreversibly merged; if `issue_provider.transition_ticket` then fails (e.g., network timeout or 401), `WorkflowService::merge_and_complete` must still update the local PR cache, return a typed `CoreError::TicketTransitionAfterMerge { pr_number, ticket_key, reason }`, and surface a clear recovery message rather than pretending the merge didn't happen.
3. **Dirty local git working tree when creating/checking out a branch (`create_and_checkout_branch`):** If a developer has uncommitted conflicting changes in their local repository, `git2` checkout or branch creation from `HEAD` must detect or safely report a dirty/unborn HEAD error (`CoreError::GitLocalError`) instead of panicking or overwriting uncommitted work.
4. **Expired or invalid API token (`HTTP 401 / 403`) from Plane.so or GitHub:** Both `PlaneProvider` and `GithubProvider` must map HTTP 401/403 responses to `CoreError::AuthExpired { provider }` so the UI immediately renders the `error` state with the "Open provider settings" recovery action.
5. **SQLite cache upsert idempotency & unlinked PR persistence:** Syncing the same tickets and PRs repeatedly must update existing rows in-place (`INSERT OR REPLACE`) without duplicating records or losing PRs where `linked_ticket_key` is `None`.

---

## Workspace File Map

```text
panguyuban/
├── .gitignore
├── Cargo.toml                                    # Workspace root (members: crates/*, apps/panguyuban-desktop/src-tauri)
├── crates/
│   ├── panguyuban-core/
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── error.rs                          # CoreError enum
│   │       ├── models.rs                         # Ticket, PullRequest, TicketState, ReviewState, CiState, MergeMethod, WorkspaceConfig
│   │       ├── traits.rs                         # IssueProvider, GitProvider, SecretStore traits
│   │       ├── linker.rs                         # extract_ticket_key, format_branch_name, link_prs_to_tickets
│   │       ├── storage.rs                        # SqliteStore (tickets, pull_requests, workspace_config tables)
│   │       └── service.rs                        # WorkflowService orchestrating providers + SqliteStore
│   ├── provider-plane/
│   │   ├── Cargo.toml
│   │   └── src/
│   │       └── lib.rs                            # PlaneProvider implementing IssueProvider
│   └── provider-github/
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs                            # GithubProvider implementing GitProvider
│           └── local_git.rs                      # git2 local branch creation & checkout helpers
└── apps/
    └── panguyuban-desktop/
        ├── package.json
        ├── tsconfig.json
        ├── vite.config.ts
        ├── index.html
        ├── src/
        │   ├── main.tsx
        │   ├── App.tsx                           # 3-pane Hallmark Console shell + separated Tickets, Git, Settings views
        │   ├── api.ts                            # Typed Tauri invoke() wrapper + offline demo fallback
        │   └── styles/
        │       ├── tokens.css                    # Copied from design/hallmark/tokens.css
        │       ├── base.css                      # Copied from design/hallmark/base.css
        │       └── app.css                       # Copied from design/hallmark/app.css
        └── src-tauri/
            ├── Cargo.toml
            ├── build.rs
            ├── tauri.conf.json
            └── src/
                ├── lib.rs                        # Tauri state + #[tauri::command] handlers
                └── main.rs
```

---

### Task 1: Workspace Root & `panguyuban-core` Domain Models, Traits, and Linker

**Files:**
- Create: `.gitignore`
- Create: `Cargo.toml`
- Create: `crates/panguyuban-core/Cargo.toml`
- Create: `crates/panguyuban-core/src/lib.rs`
- Create: `crates/panguyuban-core/src/error.rs`
- Create: `crates/panguyuban-core/src/models.rs`
- Create: `crates/panguyuban-core/src/traits.rs`
- Create: `crates/panguyuban-core/src/linker.rs`

**Interfaces:**
- Produces:
  - `panguyuban_core::error::CoreError`
  - `panguyuban_core::models::{Ticket, TicketState, PullRequest, ReviewState, CiState, MergeMethod, WorkspaceConfig}`
  - `panguyuban_core::traits::{IssueProvider, GitProvider, SecretStore}`
  - `panguyuban_core::linker::{extract_ticket_key, format_branch_name}`

- [ ] **Step 1: Create root `Cargo.toml`, `.gitignore`, and `crates/panguyuban-core` skeleton with failing linker unit tests**

Create `.gitignore` ignoring `/target`, `node_modules/`, `dist/`, `.superpowers/`, and `*.db`.
Create root `Cargo.toml` with `members = ["crates/panguyuban-core"]` and `resolver = "2"`.
In `crates/panguyuban-core/src/linker.rs`, write the test module first:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_uppercase_key_from_lowercase_branch_and_title() {
        assert_eq!(
            extract_ticket_key("fix/pan-142-jwt-refresh", "fix(auth): serialize token refresh"),
            Some("PAN-142".to_string())
        );
        assert_eq!(
            extract_ticket_key("chore/deps", "feat(webhook): [PAN-145] retry queue"),
            Some("PAN-145".to_string())
        );
    }

    #[test]
    fn ignores_common_technical_prefixes_like_utf8_and_sha256() {
        assert_eq!(
            extract_ticket_key("chore/utf-8-encoding", "Update SHA-256 and HTTP-2 helpers"),
            None
        );
    }

    #[test]
    fn formats_clean_branch_name_from_ticket_key_and_title() {
        assert_eq!(
            format_branch_name("PAN-149", "Expose rate-limit headers on public endpoints!"),
            "feat/pan-149-expose-rate-limit-headers"
        );
    }
}
```

- [ ] **Step 2: Run `cargo test` to verify compilation/test failure**

Run: `cargo test -p panguyuban-core`
Expected: FAIL (`extract_ticket_key` and `format_branch_name` not implemented).

- [ ] **Step 3: Implement `error.rs`, `models.rs`, `traits.rs`, and `linker.rs`**

In `crates/panguyuban-core/src/error.rs`, define `CoreError` using `thiserror::Error` with variants:
- `AuthExpired { provider: String }`
- `ProviderHttp { provider: String, status: u16, message: String }`
- `TicketTransitionAfterMerge { pr_number: u64, ticket_key: String, reason: String }`
- `GitLocalError(String)`
- `StorageError(String)`
- `NotFound(String)`

In `crates/panguyuban-core/src/models.rs`, define the exact structs from Spec § 4.1 (`Ticket`, `TicketState`, `PullRequest`, `ReviewState`, `CiState`, `MergeMethod`) plus:
```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceConfig {
    pub issue_provider: String,
    pub plane_base_url: String,
    pub plane_workspace_slug: String,
    pub plane_project_id: String,
    pub git_provider: String,
    pub github_api_url: String,
    pub github_repo: String,
    pub local_repo_path: String,
}
```

In `crates/panguyuban-core/src/traits.rs`, define `IssueProvider` and `GitProvider` from Spec § 4.2 plus `SecretStore`:
```rust
pub trait SecretStore: Send + Sync {
    fn get_secret(&self, key: &str) -> Result<Option<String>, CoreError>;
    fn set_secret(&self, key: &str, value: &str) -> Result<(), CoreError>;
}
```

In `crates/panguyuban-core/src/linker.rs`:
- `pub fn extract_ticket_key(source_branch: &str, title: &str) -> Option<String>`: Match case-insensitive `(?i)\b([a-z]{2,10}-\d+)\b` across `source_branch` then `title`, uppercase the match, and skip noisy technical tokens (`UTF-8`, `UTF-16`, `SHA-1`, `SHA-256`, `SHA-512`, `HTTP-1`, `HTTP-2`, `HTTP-3`, `ISO-8601`, `RSA-2048`).
- `pub fn format_branch_name(ticket_key: &str, title: &str) -> String`: Lowercase `ticket_key` and take up to the first 4 alphanumeric slug words from `title` (`feat/<key-lower>-<slug>`).

- [ ] **Step 4: Run `cargo test -p panguyuban-core` to verify all tests pass**

Run: `cargo test -p panguyuban-core`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add .gitignore Cargo.toml Cargo.lock crates/panguyuban-core
git commit -m "feat(core): add domain models, provider traits, and ticket-branch linker"
```

---

### Task 2: Local SQLite Storage & `WorkflowService` Orchestration in `panguyuban-core`

**Files:**
- Create: `crates/panguyuban-core/src/storage.rs`
- Create: `crates/panguyuban-core/src/service.rs`
- Modify: `crates/panguyuban-core/src/lib.rs`
- Modify: `crates/panguyuban-core/Cargo.toml`

**Interfaces:**
- Consumes: `Ticket`, `PullRequest`, `WorkspaceConfig`, `IssueProvider`, `GitProvider`, `CoreError`, `extract_ticket_key`, `format_branch_name`
- Produces:
  - `SqliteStore::open_in_memory() -> Result<Self, CoreError>`
  - `SqliteStore::open_path(path: &Path) -> Result<Self, CoreError>`
  - `SqliteStore::upsert_tickets(&self, tickets: &[Ticket]) -> Result<(), CoreError>`
  - `SqliteStore::list_cached_tickets(&self) -> Result<Vec<Ticket>, CoreError>`
  - `SqliteStore::upsert_pull_requests(&self, prs: &[PullRequest]) -> Result<(), CoreError>`
  - `SqliteStore::list_cached_pull_requests(&self) -> Result<Vec<PullRequest>, CoreError>`
  - `SqliteStore::get_config(&self) -> Result<WorkspaceConfig, CoreError>`
  - `SqliteStore::save_config(&self, cfg: &WorkspaceConfig) -> Result<(), CoreError>`
  - `WorkflowService::new(store: SqliteStore, issue_provider: Arc<dyn IssueProvider>, git_provider: Arc<dyn GitProvider>) -> Self`
  - `WorkflowService::sync_all(&self) -> Result<(Vec<Ticket>, Vec<PullRequest>), CoreError>`
  - `WorkflowService::start_ticket_branch(&self, ticket_key: &str) -> Result<String, CoreError>`
  - `WorkflowService::merge_and_complete(&self, pr_number: u64, method: MergeMethod, ticket_key: Option<&str>) -> Result<(), CoreError>`

- [ ] **Step 1: Write failing tests for `SqliteStore` idempotency and `WorkflowService::merge_and_complete` partial failure recovery**

In `crates/panguyuban-core/src/storage.rs` and `crates/panguyuban-core/src/service.rs`, write unit tests verifying:
1. Upserting the same ticket (`PAN-142`) and PR (`#89`) twice updates state in-place without duplicating rows, and preserves unlinked PRs (`#94` with `linked_ticket_key: None`).
2. `WorkflowService::sync_all` automatically populates `linked_ticket_key` on PRs from `extract_ticket_key(&pr.source_branch, &pr.title)` before saving to SQLite.
3. When `git_provider.merge_pull_request(89, MergeMethod::Squash)` succeeds and `issue_provider.transition_ticket("PAN-142", TicketState::Done)` returns an error, `merge_and_complete` removes/marks the merged PR in cache and returns ` Err(CoreError::TicketTransitionAfterMerge { pr_number: 89, ticket_key: "PAN-142".into(), .. })`.

- [ ] **Step 2: Run `cargo test -p panguyuban-core` to verify failure**

Run: `cargo test -p panguyuban-core`
Expected: FAIL (`storage` and `service` modules not implemented).

- [ ] **Step 3: Implement `SqliteStore` (`storage.rs`) and `WorkflowService` (`service.rs`)**

Use `rusqlite` with the `bundled` feature and `std::sync::Mutex<rusqlite::Connection>` so `SqliteStore` is `Send + Sync`. Store JSON-serialized `Ticket` and `PullRequest` payloads alongside indexed `key` / `number` columns for fast lookup and schema evolution, plus a single-row `workspace_config` table with sensible defaults (`plane.so` + `github`).

In `WorkflowService::start_ticket_branch(&self, ticket_key: &str)`:
1. Look up the ticket via `issue_provider.get_ticket(ticket_key).await?`.
2. Format branch name via `format_branch_name(&ticket.key, &ticket.title)`.
3. Call `git_provider.create_and_checkout_branch(&branch)?`.
4. Call `issue_provider.transition_ticket(ticket_key, TicketState::InProgress).await?` and upsert in `SqliteStore`.

- [ ] **Step 4: Run `cargo test -p panguyuban-core` to verify all storage and service tests pass**

Run: `cargo test -p panguyuban-core`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml Cargo.lock crates/panguyuban-core
git commit -m "feat(core): add SQLite cache store and workflow orchestration service"
```

---

### Task 3: Plane.so Adapter Crate (`crates/provider-plane`)

**Files:**
- Create: `crates/provider-plane/Cargo.toml`
- Create: `crates/provider-plane/src/lib.rs`
- Modify: `Cargo.toml`

**Interfaces:**
- Consumes: `panguyuban_core::{traits::IssueProvider, models::{Ticket, TicketState}, error::CoreError}`
- Produces:
  - `provider_plane::PlaneConfig { pub base_url: String, pub workspace_slug: String, pub project_id: String, pub api_token: String }`
  - `provider_plane::PlaneProvider::new(config: PlaneConfig) -> Self` (implements `IssueProvider`)

- [ ] **Step 1: Write failing unit tests for Plane JSON deserialization, state mapping, and HTTP 401 handling**

In `crates/provider-plane/src/lib.rs`, write tests covering:
1. Mapping Plane API issue JSON (`id`, `sequence_id: 142`, `project_detail.identifier: "PAN"`, `name`, `description_stripped`, `priority`, `state_detail.group: "started"`, ` assignee_details`) into `panguyuban_core::models::Ticket` with `key == "PAN-142"` and `state == TicketState::InProgress`.
2. Mapping HTTP status `401` and `403` into `CoreError::AuthExpired { provider: "plane.so".to_string() }`.

- [ ] **Step 2: Run `cargo test -p provider-plane` to verify failure**

Run: `cargo test -p provider-plane`
Expected: FAIL.

- [ ] **Step 3: Implement `PlaneProvider` in `crates/provider-plane/src/lib.rs`**

Use `reqwest::Client` with header `X-API-Key: <api_token>`.
- `provider_name(&self) -> &'static str` returns `"plane.so"`.
- `list_tickets`: `GET {base_url}/api/v1/workspaces/{workspace_slug}/projects/{project_id}/issues/`
- `get_ticket`: Filters or fetches by key (`PAN-142`).
- `create_ticket`: `POST {base_url}/api/v1/workspaces/{workspace_slug}/projects/{project_id}/issues/` with `{"name": title, "description_html": format!("<p>{description}</p>")}`.
- `transition_ticket`: `PATCH` issue state group mapping (`backlog` -> `Backlog`, `unstarted` -> `Todo`, `started` -> `InProgress`, `completed` -> `Done`, `cancelled` -> `Cancelled`).

- [ ] **Step 4: Run `cargo test -p provider-plane` to verify tests pass**

Run: `cargo test -p provider-plane`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml Cargo.lock crates/provider-plane
git commit -m "feat(provider-plane): implement IssueProvider adapter for Plane.so REST v1"
```

---

### Task 4: GitHub & Local `git2` Adapter Crate (`crates/provider-github`)

**Files:**
- Create: `crates/provider-github/Cargo.toml`
- Create: `crates/provider-github/src/lib.rs`
- Create: `crates/provider-github/src/local_git.rs`
- Modify: `Cargo.toml`

**Interfaces:**
- Consumes: `panguyuban_core::{traits::GitProvider, models::{PullRequest, ReviewState, CiState, MergeMethod}, error::CoreError, linker::extract_ticket_key}`
- Produces:
  - `provider_github::GithubConfig { pub api_url: String, pub repo: String, pub token: String, pub local_repo_path: PathBuf }`
  - `provider_github::GithubProvider::new(config: GithubConfig) -> Self` (implements `GitProvider`)

- [ ] **Step 1: Write failing tests for local `git2` branch creation/checkout (including dirty working tree check) and GitHub PR payload parsing**

In `crates/provider-github/src/local_git.rs` and `src/lib.rs`, write tests covering:
1. Initializing a temporary `git2::Repository` with an initial commit, calling `create_and_checkout_branch("feat/pan-149-rate-limit")`, and asserting `repo.head()?.shorthand() == Some("feat/pan-149-rate-limit")`.
2. Modifying a tracked file without committing and verifying `checkout_existing_branch` returns `Err(CoreError::GitLocalError(_))` when a checkout conflict or dirty index would be overwritten.
3. Mapping GitHub PR JSON + check runs + reviews into `PullRequest` with extracted `linked_ticket_key: Some("PAN-142")` and `CoreError::AuthExpired` on HTTP 401/403.

- [ ] **Step 2: Run `cargo test -p provider-github` to verify failure**

Run: `cargo test -p provider-github`
Expected: FAIL.

- [ ] **Step 3: Implement `local_git.rs` (`git2`) and `GithubProvider` (`lib.rs`)**

In `local_git.rs`:
- Open `git2::Repository::open(&self.local_repo_path)`.
- Peel `HEAD` to commit, create branch `repo.branch(branch_name, &head_commit, false)` (if it doesn't already exist), verify safe working tree with `git2::build::CheckoutBuilder::new().safe()`, and call `repo.set_head(&format!("refs/heads/{branch_name}"))`.

In `lib.rs`:
- `provider_name` returns `"github"`.
- `list_pull_requests`: `GET {api_url}/repos/{repo}/pulls?state=open`, mapping branch, additions/deletions, review state, CI status, and calling `extract_ticket_key`.
- `approve_pull_request`: `POST {api_url}/repos/{repo}/pulls/{number}/reviews` with `{"event": "APPROVE"}`.
- `merge_pull_request`: `PUT {api_url}/repos/{repo}/pulls/{number}/merge` with `{"merge_method": "squash" | "merge" | "rebase"}`.

- [ ] **Step 4: Run `cargo test -p provider-github` to verify all tests pass**

Run: `cargo test -p provider-github`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml Cargo.lock crates/provider-github
git commit -m "feat(provider-github): implement GitProvider with GitHub REST API and local git2"
```

---

### Task 5: Tauri v2 Desktop App (`apps/panguyuban-desktop`) with Hallmark `Console` UI

**Files:**
- Create: `apps/panguyuban-desktop/src-tauri/Cargo.toml`
- Create: `apps/panguyuban-desktop/src-tauri/build.rs`
- Create: `apps/panguyuban-desktop/src-tauri/tauri.conf.json`
- Create: `apps/panguyuban-desktop/src-tauri/src/lib.rs`
- Create: `apps/panguyuban-desktop/src-tauri/src/main.rs`
- Create: `apps/panguyuban-desktop/package.json`
- Create: `apps/panguyuban-desktop/tsconfig.json`
- Create: `apps/panguyuban-desktop/vite.config.ts`
- Create: `apps/panguyuban-desktop/index.html`
- Create: `apps/panguyuban-desktop/src/styles/tokens.css`
- Create: `apps/panguyuban-desktop/src/styles/base.css`
- Create: `apps/panguyuban-desktop/src/styles/app.css`
- Create: `apps/panguyuban-desktop/src/api.ts`
- Create: `apps/panguyuban-desktop/src/App.tsx`
- Create: `apps/panguyuban-desktop/src/main.tsx`
- Modify: `Cargo.toml`

**Interfaces:**
- Consumes: `panguyuban_core`, `provider_plane`, `provider_github`, and Hallmark stylesheets (`design/hallmark/{tokens,base,app}.css`)
- Produces:
  - Tauri IPC commands in `apps/panguyuban-desktop/src-tauri/src/lib.rs`:
    - `get_dashboard_state() -> Result<DashboardPayload, String>` (returns cached tickets, PRs, and active `WorkspaceConfig`, seeding initial sample records when the database is empty so first launch is immediately inspectable)
    - `sync_providers() -> Result<DashboardPayload, String>`
    - `start_ticket_branch(ticket_key: String) -> Result<String, String>`
    - `transition_ticket_state(ticket_key: String, next_state: TicketState) -> Result<Ticket, String>`
    - `approve_pr(pr_number: u64) -> Result<PullRequest, String>`
    - `merge_pr_and_close_ticket(pr_number: u64, ticket_key: Option<String>) -> Result<DashboardPayload, String>`
    - `save_workspace_config(config: WorkspaceConfig, plane_token: Option<String>, github_token: Option<String>) -> Result<WorkspaceConfig, String>`

- [ ] **Step 1: Write failing Rust tests in `apps/panguyuban-desktop/src-tauri/src/lib.rs` for Tauri state initialization and command orchestration**

Test that initializing `AppState::new_in_memory()` seeds initial tickets (`PAN-142`, `PAN-145`, `PAN-149`) and pull requests (`#89`, `#92`, `#94`) when empty, transitions ticket states, and saves updated `WorkspaceConfig`.

- [ ] **Step 2: Run `cargo test -p panguyuban-desktop` to verify failure**

Run: `cargo test -p panguyuban-desktop`
Expected: FAIL.

- [ ] **Step 3: Implement the Tauri v2 backend (`src-tauri`) and React + Hallmark `Console` frontend (`src/`)**

1. Copy `design/hallmark/tokens.css`, `design/hallmark/base.css`, and `design/hallmark/app.css` into `apps/panguyuban-desktop/src/styles/`.
2. In `apps/panguyuban-desktop/src/App.tsx`, build the 3-pane desktop layout matching `design/hallmark/index.html` with:
   - Separate Left Sidebar sections: **Tickets (Plane.so)** (`Assigned to me`, `Todo queue`, `In progress`), **Git and Pull Requests** (`Git to review`, `Git to merge`, `Local branches`), and **System** (`Settings and providers`).
   - All four data states (`full`, `loading`, `empty`, `error`).
   - Live Tauri `invoke()` bindings via `src/api.ts` for ticket selection, branch creation, PR approval, one-click **Squash and merge PR + close Plane ticket**, and provider settings persistence.

- [ ] **Step 4: Verify Rust workspace tests, frontend build, and Hallmark `sloplint` pass**

Run:
1. `cargo test --workspace`
2. `npm --prefix apps/panguyuban-desktop install && npm --prefix apps/panguyuban-desktop run build`
3. `node /Users/ansar/.gemini/config/skills/hallmark/scripts/sloplint.mjs apps/panguyuban-desktop/src/App.tsx apps/panguyuban-desktop/src/styles/app.css --genre modern-minimal --scope app`

Expected: All Rust tests pass, Vite TypeScript build succeeds with zero errors, and `sloplint` reports `0 FAIL, 0 REFLEX`.

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml Cargo.lock apps/panguyuban-desktop design/hallmark docs/superpowers
git commit -m "feat(desktop): add Tauri v2 desktop app with Hallmark Console UI"
```
