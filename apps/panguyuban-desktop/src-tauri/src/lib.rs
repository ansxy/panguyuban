mod agents;
mod builder;
mod calendar;
mod spaces;
mod terminal;

use std::path::PathBuf;
use std::sync::Arc;

use panguyuban_core::error::CoreError;
use panguyuban_core::linker::format_branch_name;
use panguyuban_core::models::{
    CiState, MergeMethod, PullRequest, ReviewState, Ticket, TicketState, WorkspaceConfig,
};
use panguyuban_core::service::WorkflowService;
use panguyuban_core::storage::SqliteStore;
use panguyuban_core::traits::{GitProvider, IssueProvider, SecretStore};
use provider_github::{GithubConfig, GithubProvider};
use provider_plane::{PlaneConfig, PlaneProjectItem, PlaneProvider};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DashboardPayload {
    pub tickets: Vec<Ticket>,
    pub pull_requests: Vec<PullRequest>,
    pub config: WorkspaceConfig,
}

/// OS keychain, read at most once per key per launch. Every keychain read can
/// pop a macOS "allow access" prompt, so repeated syncs must not hit it again.
pub struct KeyringSecretStore {
    service_name: String,
    cache: std::sync::Mutex<std::collections::HashMap<String, Option<String>>>,
}

impl KeyringSecretStore {
    pub fn new(service_name: impl Into<String>) -> Self {
        Self {
            service_name: service_name.into(),
            cache: Default::default(),
        }
    }
}

impl SecretStore for KeyringSecretStore {
    fn get_secret(&self, key: &str) -> Result<Option<String>, CoreError> {
        let mut cache = self
            .cache
            .lock()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        if let Some(hit) = cache.get(key) {
            return Ok(hit.clone());
        }
        let entry = keyring::Entry::new(&self.service_name, key)
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        let value = match entry.get_password() {
            Ok(val) => Some(val),
            Err(keyring::Error::NoEntry) => None,
            Err(e) => return Err(CoreError::StorageError(e.to_string())),
        };
        cache.insert(key.to_string(), value.clone());
        Ok(value)
    }

    fn set_secret(&self, key: &str, value: &str) -> Result<(), CoreError> {
        let entry = keyring::Entry::new(&self.service_name, key)
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        entry
            .set_password(value)
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        if let Ok(mut cache) = self.cache.lock() {
            cache.insert(key.to_string(), Some(value.to_string()));
        }
        Ok(())
    }
}

/// Reads the token the GitHub CLI already stores (`gh auth login`), the same auth
/// top-bar reuses. Runs in a login zsh so Finder-launched apps still get the user's PATH.
pub fn gh_cli_token() -> Option<String> {
    let out = std::process::Command::new("/bin/zsh")
        .args(["-lc", "gh auth token"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!token.is_empty()).then_some(token)
}

#[derive(Clone)]
pub struct DesktopController {
    store: SqliteStore,
    secrets: Option<Arc<dyn SecretStore>>,
    issue_provider: Option<Arc<dyn IssueProvider>>,
    git_provider: Option<Arc<dyn GitProvider>>,
}

impl DesktopController {
    pub fn new_in_memory() -> Result<Self, CoreError> {
        let store = SqliteStore::open_in_memory()?;
        let controller = Self {
            store,
            secrets: None,
            issue_provider: None,
            git_provider: None,
        };
        controller.seed_initial_records_if_empty()?;
        Ok(controller)
    }

    pub fn new_with_providers(
        issue_provider: Arc<dyn IssueProvider>,
        git_provider: Arc<dyn GitProvider>,
    ) -> Result<Self, CoreError> {
        let store = SqliteStore::open_in_memory()?;
        let controller = Self {
            store,
            secrets: None,
            issue_provider: Some(issue_provider),
            git_provider: Some(git_provider),
        };
        controller.seed_initial_records_if_empty()?;
        Ok(controller)
    }

    pub fn open_default() -> Result<Self, CoreError> {
        let db_path = dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("panguyuban")
            .join("state.db");
        let store = SqliteStore::open_path(&db_path)?;
        // No sample seeding here: an empty sync result must stay empty, not come
        // back as fake PRs/tickets on the next launch. Samples are demo-only.
        Ok(Self {
            store,
            secrets: Some(Arc::new(KeyringSecretStore::new("com.ansar.panguyuban"))),
            issue_provider: None,
            git_provider: None,
        })
    }

    fn seed_initial_records_if_empty(&self) -> Result<(), CoreError> {
        if self.store.list_cached_tickets()?.is_empty() {
            let sample_tickets = vec![
                Ticket {
                    id: "b62f8d9a-0142".into(),
                    key: "PAN-142".into(),
                    title: "Fix JWT refresh race on concurrent requests".into(),
                    description: "When two requests expire within the same millisecond, parallel refresh calls invalidate the first rotated token. Guard rotation with an async mutex inside the session store.".into(),
                    state: TicketState::InReview,
                    assignee: Some("@ansar".into()),
                    priority: Some("high".into()),
                    updated_at: "2026-11-11T02:14:09Z".into(),
                    url: "https://app.plane.so/panguyuban/issues/PAN-142".into(),
                    assigned_to_me: true,
                },
                Ticket {
                    id: "b62f8d9a-0145".into(),
                    key: "PAN-145".into(),
                    title: "Add exponential backoff to webhook delivery".into(),
                    description: "Failed webhook deliveries currently retry immediately and trip downstream rate limits. Schedule retries with jitter over 5 attempts.".into(),
                    state: TicketState::InProgress,
                    assignee: Some("@alex".into()),
                    priority: Some("medium".into()),
                    updated_at: "2026-11-11T02:20:00Z".into(),
                    url: "https://app.plane.so/panguyuban/issues/PAN-145".into(),
                    assigned_to_me: false,
                },
                Ticket {
                    id: "b62f8d9a-0149".into(),
                    key: "PAN-149".into(),
                    title: "Expose rate-limit headers on public endpoints".into(),
                    description: "Return X-RateLimit-Limit, X-RateLimit-Remaining, and X-RateLimit-Reset on all authenticated API routes.".into(),
                    state: TicketState::Todo,
                    assignee: Some("@ansar".into()),
                    priority: Some("low".into()),
                    updated_at: "2026-11-11T02:30:00Z".into(),
                    url: "https://app.plane.so/panguyuban/issues/PAN-149".into(),
                    assigned_to_me: true,
                },
            ];
            self.store.upsert_tickets(&sample_tickets)?;
        }

        if self.store.list_cached_pull_requests()?.is_empty() {
            let sample_prs = vec![
                PullRequest {
                    repo: "ansar/panguyuban".into(),
                    review_requested: false,
                    number: 89,
                    title: "fix(auth): serialize token refresh with mutex".into(),
                    author: "@ansar".into(),
                    source_branch: "fix/pan-142-jwt".into(),
                    target_branch: "main".into(),
                    mergeable: true,
                    additions: 84,
                    deletions: 19,
                    review_state: ReviewState::Approved,
                    ci_state: CiState::Passing {
                        passed: 3,
                        total: 3,
                    },
                    linked_ticket_key: Some("PAN-142".into()),
                    diff_preview: vec![
                        "@@ -42,7 +42,9 @@ impl TokenManager {".into(),
                        "-    let next = self.client.refresh(&current).await?;".into(),
                        "+    let _guard = self.refresh_lock.lock().await;".into(),
                        "+    let next = self.client.refresh(&current).await?;".into(),
                    ],
                    url: "https://github.com/ansar/panguyuban/pull/89".into(),
                },
                PullRequest {
                    repo: "ansar/panguyuban".into(),
                    review_requested: true,
                    number: 92,
                    title: "feat(webhook): bounded retry queue with jitter".into(),
                    author: "@alex".into(),
                    source_branch: "feat/pan-145-webhook".into(),
                    target_branch: "main".into(),
                    mergeable: true,
                    additions: 142,
                    deletions: 11,
                    review_state: ReviewState::ReviewRequired,
                    ci_state: CiState::Passing {
                        passed: 2,
                        total: 3,
                    },
                    linked_ticket_key: Some("PAN-145".into()),
                    diff_preview: vec![
                        "@@ -18,4 +18,8 @@ pub fn next_backoff(attempt: u32) -> Duration {".into(),
                        "+    let base = 2_u64.saturating_pow(attempt);".into(),
                        "+    Duration::from_secs(base.min(300))".into(),
                    ],
                    url: "https://github.com/ansar/panguyuban/pull/92".into(),
                },
                PullRequest {
                    repo: "ansar/infra".into(),
                    review_requested: true,
                    number: 94,
                    title: "chore(cargo): bump tokio and reqwest crates".into(),
                    author: "@sarah".into(),
                    source_branch: "chore/tokio-bump".into(),
                    target_branch: "main".into(),
                    mergeable: true,
                    additions: 18,
                    deletions: 18,
                    review_state: ReviewState::ReviewRequired,
                    ci_state: CiState::Passing {
                        passed: 3,
                        total: 3,
                    },
                    linked_ticket_key: None,
                    diff_preview: vec![
                        "@@ -12,2 +12,2 @@ [dependencies]".into(),
                        "-tokio = \"1.39\"".into(),
                        "+tokio = \"1.54\"".into(),
                    ],
                    url: "https://github.com/ansar/panguyuban/pull/94".into(),
                },
            ];
            self.store.upsert_pull_requests(&sample_prs)?;
        }

        Ok(())
    }

    pub fn get_dashboard_payload(&self) -> Result<DashboardPayload, CoreError> {
        Ok(DashboardPayload {
            tickets: self.store.list_cached_tickets()?,
            pull_requests: self.store.list_cached_pull_requests()?,
            config: self.store.get_config()?,
        })
    }

    pub fn build_workflow_service(&self) -> Result<WorkflowService, CoreError> {
        let cfg = self.store.get_config()?;
        let issue_provider: Arc<dyn IssueProvider> = match &self.issue_provider {
            Some(p) => p.clone(),
            None => {
                let plane_token = self
                    .secrets
                    .as_ref()
                    .and_then(|s| s.get_secret("plane_api_token").ok().flatten())
                    .unwrap_or_default();
                Arc::new(PlaneProvider::new(PlaneConfig {
                    base_url: cfg.plane_base_url,
                    workspace_slug: cfg.plane_workspace_slug,
                    project_id: cfg.plane_project_id,
                    api_token: plane_token,
                }))
            }
        };

        let git_provider: Arc<dyn GitProvider> = match &self.git_provider {
            Some(p) => p.clone(),
            None => {
                let github_token = self.resolve_github_token().unwrap_or_default();
                Arc::new(GithubProvider::new(GithubConfig {
                    api_url: cfg.github_api_url,
                    repo: cfg.github_repo,
                    token: github_token,
                    local_repo_path: PathBuf::from(cfg.local_repo_path),
                }))
            }
        };

        Ok(WorkflowService::new(
            self.store.clone(),
            issue_provider,
            git_provider,
        ))
    }

    fn has_live_providers(&self) -> bool {
        if self.issue_provider.is_some() || self.git_provider.is_some() {
            return true;
        }
        let has_plane = self
            .secrets
            .as_ref()
            .and_then(|s| s.get_secret("plane_api_token").ok().flatten())
            .map(|t| !t.trim().is_empty())
            .unwrap_or(false);
        let has_github = self.resolve_github_token().is_some();
        has_plane || has_github
    }

    /// GitHub token lookup order: `gh auth token` (as in top-bar), then the keychain PAT.
    /// A stale saved PAT no longer shadows a working `gh` login.
    fn resolve_github_token(&self) -> Option<String> {
        gh_cli_token().or_else(|| {
            self.secrets
                .as_ref()
                .and_then(|s| s.get_secret("github_pat").ok().flatten())
                .filter(|t| !t.trim().is_empty())
        })
    }

    pub async fn sync_remote_or_cached(&self) -> Result<DashboardPayload, CoreError> {
        if self.has_live_providers() {
            let svc = self.build_workflow_service()?;
            let _ = svc.sync_all().await?;
        }
        self.get_dashboard_payload()
    }

    /// Refreshes only Plane tickets (the Plane section's refresh button).
    pub async fn sync_tickets(&self) -> Result<DashboardPayload, CoreError> {
        self.build_workflow_service()?.sync_tickets().await?;
        self.get_dashboard_payload()
    }

    /// Refreshes only GitHub PRs (the Git section's refresh button).
    pub async fn sync_pull_requests(&self) -> Result<DashboardPayload, CoreError> {
        self.build_workflow_service()?.sync_pull_requests().await?;
        self.get_dashboard_payload()
    }

    pub async fn pull_request_diff(&self, repo: &str, number: u64) -> Result<Vec<String>, CoreError> {
        self.build_workflow_service()?
            .git_provider()
            .pull_request_diff(repo, number)
            .await
    }

    pub async fn execute_start_ticket_branch(&self, ticket_key: &str) -> Result<String, CoreError> {
        if self.has_live_providers() {
            let svc = self.build_workflow_service()?;
            let branch = svc.start_ticket_branch(ticket_key).await?;
            let _ = self.transition_cached_ticket(ticket_key, TicketState::InProgress);
            return Ok(branch);
        }
        self.start_cached_ticket_branch(ticket_key)
    }

    pub async fn execute_transition_ticket(
        &self,
        ticket_key: &str,
        next_state: TicketState,
    ) -> Result<Ticket, CoreError> {
        if self.has_live_providers() {
            let svc = self.build_workflow_service()?;
            let updated = svc
                .issue_provider()
                .transition_ticket(ticket_key, next_state.clone())
                .await?;
            self.store.upsert_tickets(std::slice::from_ref(&updated))?;
            return Ok(updated);
        }
        self.transition_cached_ticket(ticket_key, next_state)
    }

    pub async fn execute_approve_pr(
        &self,
        repo: &str,
        pr_number: u64,
    ) -> Result<PullRequest, CoreError> {
        if self.has_live_providers() {
            let svc = self.build_workflow_service()?;
            let updated = svc.git_provider().approve_pull_request(repo, pr_number).await?;
            self.store
                .upsert_pull_requests(std::slice::from_ref(&updated))?;
            return Ok(updated);
        }
        self.approve_cached_pr(repo, pr_number)
    }

    pub async fn execute_merge_pr_and_close_ticket(
        &self,
        repo: &str,
        pr_number: u64,
        ticket_key: Option<&str>,
    ) -> Result<DashboardPayload, CoreError> {
        if self.has_live_providers() {
            let svc = self.build_workflow_service()?;
            svc.merge_and_complete(repo, pr_number, MergeMethod::Squash, ticket_key)
                .await?;
        }
        self.merge_cached_pr_and_close_ticket(repo, pr_number, ticket_key)
    }

    pub fn transition_cached_ticket(
        &self,
        ticket_key: &str,
        next_state: TicketState,
    ) -> Result<Ticket, CoreError> {
        let mut tickets = self.store.list_cached_tickets()?;
        let ticket = tickets
            .iter_mut()
            .find(|t| t.key.eq_ignore_ascii_case(ticket_key))
            .ok_or_else(|| CoreError::NotFound(format!("Ticket {ticket_key} not found")))?;
        ticket.state = next_state;
        let updated = ticket.clone();
        self.store.upsert_tickets(std::slice::from_ref(&updated))?;
        Ok(updated)
    }

    pub fn start_cached_ticket_branch(&self, ticket_key: &str) -> Result<String, CoreError> {
        let ticket = self.transition_cached_ticket(ticket_key, TicketState::InProgress)?;
        Ok(format_branch_name(&ticket.key, &ticket.title))
    }

    pub fn approve_cached_pr(&self, repo: &str, pr_number: u64) -> Result<PullRequest, CoreError> {
        let mut prs = self.store.list_cached_pull_requests()?;
        let pr = prs
            .iter_mut()
            .find(|p| p.repo == repo && p.number == pr_number)
            .ok_or_else(|| CoreError::NotFound(format!("PR {repo}#{pr_number} not found")))?;
        pr.review_state = ReviewState::Approved;
        let updated = pr.clone();
        self.store
            .upsert_pull_requests(std::slice::from_ref(&updated))?;
        Ok(updated)
    }

    pub fn merge_cached_pr_and_close_ticket(
        &self,
        repo: &str,
        pr_number: u64,
        ticket_key: Option<&str>,
    ) -> Result<DashboardPayload, CoreError> {
        self.store.remove_pull_request(repo, pr_number)?;
        if let Some(key) = ticket_key {
            let _ = self.transition_cached_ticket(key, TicketState::Done)?;
        }
        let _ = MergeMethod::Squash;
        self.get_dashboard_payload()
    }

    /// Projects for the settings picker. Uses the typed token when given (so the form
    /// can be tested before saving, like top-bar's "Test & Sync"), else the keychain one.
    pub async fn list_plane_projects(
        &self,
        base_url: String,
        workspace_slug: String,
        token: Option<String>,
    ) -> Result<Vec<PlaneProjectItem>, CoreError> {
        let api_token = token
            .filter(|t| !t.trim().is_empty())
            .or_else(|| {
                self.secrets
                    .as_ref()
                    .and_then(|s| s.get_secret("plane_api_token").ok().flatten())
            })
            .ok_or(CoreError::AuthExpired {
                provider: "plane.so".into(),
            })?;
        PlaneProvider::new(PlaneConfig {
            base_url,
            workspace_slug,
            project_id: String::new(),
            api_token: api_token.trim().to_string(),
        })
        .list_projects()
        .await
    }

    /// Download URL for an image in a Plane ticket description.
    pub async fn plane_asset_url(&self, asset_id: &str) -> Result<String, CoreError> {
        let cfg = self.store.get_config()?;
        let api_token = self
            .secrets
            .as_ref()
            .and_then(|s| s.get_secret("plane_api_token").ok().flatten())
            .unwrap_or_default();
        PlaneProvider::new(PlaneConfig {
            base_url: cfg.plane_base_url,
            workspace_slug: cfg.plane_workspace_slug,
            project_id: cfg.plane_project_id,
            api_token,
        })
        .asset_url(asset_id)
        .await
    }

    pub fn save_config(
        &self,
        config: WorkspaceConfig,
        plane_token: Option<String>,
        github_token: Option<String>,
        calendar_url: Option<String>,
    ) -> Result<WorkspaceConfig, CoreError> {
        self.store.save_config(&config)?;
        if let Some(secrets) = &self.secrets {
            if let Some(token) = plane_token {
                if !token.trim().is_empty() {
                    secrets.set_secret("plane_api_token", token.trim())?;
                }
            }
            if let Some(token) = github_token {
                if !token.trim().is_empty() {
                    secrets.set_secret("github_pat", token.trim())?;
                }
            }
            if let Some(url) = calendar_url {
                if !url.trim().is_empty() {
                    secrets.set_secret("calendar_ics_url", url.trim())?;
                }
            }
        }
        self.store.get_config()
    }

    /// The saved iCal link, if any. Kept in the keychain: anyone with it can read the calendar.
    pub fn calendar_url(&self) -> Option<String> {
        self.secrets
            .as_ref()
            .and_then(|s| s.get_secret("calendar_ics_url").ok().flatten())
            .filter(|u| !u.is_empty())
    }
}

#[tauri::command]
fn get_dashboard_state(
    state: tauri::State<'_, DesktopController>,
) -> Result<DashboardPayload, String> {
    state.get_dashboard_payload().map_err(|e| e.to_string())
}

#[tauri::command]
async fn sync_providers(
    state: tauri::State<'_, DesktopController>,
) -> Result<DashboardPayload, String> {
    state.sync_remote_or_cached().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn sync_plane(
    state: tauri::State<'_, DesktopController>,
) -> Result<DashboardPayload, String> {
    state.sync_tickets().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn sync_github(
    state: tauri::State<'_, DesktopController>,
) -> Result<DashboardPayload, String> {
    state.sync_pull_requests().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_pr_diff(
    state: tauri::State<'_, DesktopController>,
    repo: String,
    pr_number: u64,
) -> Result<Vec<String>, String> {
    state
        .pull_request_diff(&repo, pr_number)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn start_ticket_branch(
    state: tauri::State<'_, DesktopController>,
    ticket_key: String,
) -> Result<String, String> {
    state
        .execute_start_ticket_branch(&ticket_key)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn transition_ticket_state(
    state: tauri::State<'_, DesktopController>,
    ticket_key: String,
    next_state: TicketState,
) -> Result<Ticket, String> {
    state
        .execute_transition_ticket(&ticket_key, next_state)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn approve_pr(
    state: tauri::State<'_, DesktopController>,
    repo: String,
    pr_number: u64,
) -> Result<PullRequest, String> {
    state
        .execute_approve_pr(&repo, pr_number)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn merge_pr_and_close_ticket(
    state: tauri::State<'_, DesktopController>,
    repo: String,
    pr_number: u64,
    ticket_key: Option<String>,
) -> Result<DashboardPayload, String> {
    state
        .execute_merge_pr_and_close_ticket(&repo, pr_number, ticket_key.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_plane_projects(
    state: tauri::State<'_, DesktopController>,
    base_url: String,
    workspace_slug: String,
    plane_token: Option<String>,
) -> Result<Vec<PlaneProjectItem>, String> {
    state
        .list_plane_projects(base_url, workspace_slug, plane_token)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_plane_asset_url(
    state: tauri::State<'_, DesktopController>,
    asset_id: String,
) -> Result<String, String> {
    state
        .plane_asset_url(&asset_id)
        .await
        .map_err(|e| e.to_string())
}

type Tracker = Arc<agents::AgentTracker>;

/// Live agent sessions. File reads run off the async runtime's worker threads.
#[tauri::command]
async fn agent_sessions(tracker: tauri::State<'_, Tracker>) -> Result<Vec<agents::AgentSession>, String> {
    let tracker = tracker.inner().clone();
    tokio::task::spawn_blocking(move || tracker.sessions())
        .await
        .map_err(|e| e.to_string())
}

/// Token usage over the 5h / today / 7d windows, per harness.
#[tauri::command]
async fn agent_usage(tracker: tauri::State<'_, Tracker>) -> Result<Vec<agents::UsageReport>, String> {
    let tracker = tracker.inner().clone();
    tokio::task::spawn_blocking(move || tracker.usage())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn reveal_agent(pid: i32, cwd: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || agents::reveal(pid, &cwd))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn open_agent_folder(cwd: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || agents::open_folder(&cwd, false))
        .await
        .map_err(|e| e.to_string())?
}

/// Meetings between two instants, from the Mac's Calendar app, the iCal link and the imported file.
#[tauri::command]
async fn calendar_events(
    state: tauri::State<'_, DesktopController>,
    from_ms: i64,
    to_ms: i64,
) -> Result<Vec<calendar::CalendarEvent>, String> {
    calendar::events(state.calendar_url(), from_ms, to_ms).await
}

#[tauri::command]
fn import_calendar(ics: String) -> Result<usize, String> {
    calendar::import(&ics)
}

#[tauri::command]
fn open_meeting(url: String) -> Result<(), String> {
    calendar::open_url(&url)
}

/// Which agent command-line tools the guided builder can use on this machine.
#[tauri::command]
async fn builder_agents() -> Result<Vec<builder::HarnessStatus>, String> {
    tokio::task::spawn_blocking(builder::harness_statuses)
        .await
        .map_err(|e| e.to_string())
}

/// One PRD interview turn. The agent process runs off the async runtime's worker threads.
#[tauri::command]
async fn builder_interview_turn(
    args: builder::InterviewTurnArgs,
) -> Result<builder::InterviewTurnResult, String> {
    tokio::task::spawn_blocking(move || builder::run_interview_turn(args))
        .await
        .map_err(|e| e.to_string())?
}

/// Sizes the steps of an approved PRD and flags the ones an engineer must clear.
#[tauri::command]
async fn builder_plan(args: builder::PlanArgs) -> Result<agent_runtime::Plan, String> {
    tokio::task::spawn_blocking(move || builder::run_plan(args))
        .await
        .map_err(|e| e.to_string())?
}

/// Proposes or revises the HTML mock-up for an approved PRD.
#[tauri::command]
async fn builder_design(args: builder::DesignArgs) -> Result<builder::DesignResult, String> {
    tokio::task::spawn_blocking(move || builder::run_design(args))
        .await
        .map_err(|e| e.to_string())?
}

/// Overwrites a prototype's prd.md, used when the user approves the PRD.
#[tauri::command]
fn builder_save_prd(args: builder::SavePrdArgs) -> Result<String, String> {
    builder::save_prd(args)
}

#[tauri::command]
fn term_open(
    terms: tauri::State<'_, terminal::Terminals>,
    cols: u16,
    rows: u16,
    cwd: String,
) -> Result<u32, String> {
    terms.open(cols, rows, &cwd)
}

/// Next chunk of shell output as raw bytes; an empty buffer means the shell exited.
#[tauri::command]
async fn term_read(
    terms: tauri::State<'_, terminal::Terminals>,
    id: u32,
) -> Result<tauri::ipc::Response, String> {
    let out = terms.read(id).await?.unwrap_or_default();
    Ok(tauri::ipc::Response::new(out))
}

#[tauri::command]
fn term_write(terms: tauri::State<'_, terminal::Terminals>, id: u32, data: String) -> Result<(), String> {
    terms.write(id, &data)
}

#[tauri::command]
fn term_resize(
    terms: tauri::State<'_, terminal::Terminals>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    terms.resize(id, cols, rows)
}

#[tauri::command]
fn term_info(terms: tauri::State<'_, terminal::Terminals>, id: u32) -> Result<terminal::TermInfo, String> {
    terms.info(id)
}

/// Branch, ahead/behind and GitHub repo of each space's folder.
#[tauri::command]
async fn space_status(paths: Vec<String>) -> Result<Vec<spaces::SpaceStatus>, String> {
    tokio::task::spawn_blocking(move || paths.iter().map(|p| spaces::status(p)).collect())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn folder_list(path: String) -> Result<Vec<spaces::DirEntry>, String> {
    tokio::task::spawn_blocking(move || spaces::list_dir(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn folder_read_file(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || spaces::read_file(&path))
        .await
        .map_err(|e| e.to_string())?
}

/// Uncommitted changes in a folder's git repo, as unified diff lines.
#[tauri::command]
async fn folder_changes(path: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || spaces::changes(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn term_close(terms: tauri::State<'_, terminal::Terminals>, id: u32) {
    terms.close(id)
}

#[tauri::command]
fn save_workspace_config(
    state: tauri::State<'_, DesktopController>,
    config: WorkspaceConfig,
    plane_token: Option<String>,
    github_token: Option<String>,
    calendar_url: Option<String>,
) -> Result<WorkspaceConfig, String> {
    state
        .save_config(config, plane_token, github_token, calendar_url)
        .map_err(|e| e.to_string())
}

pub fn run() {
    let controller = DesktopController::open_default()
        .or_else(|_| DesktopController::new_in_memory())
        .expect("Failed to initialize Panguyuban DesktopController");

    tauri::Builder::default()
        .manage(controller)
        .manage(Tracker::default())
        .manage(terminal::Terminals::default())
        .invoke_handler(tauri::generate_handler![
            get_dashboard_state,
            sync_providers,
            sync_plane,
            sync_github,
            get_pr_diff,
            start_ticket_branch,
            transition_ticket_state,
            approve_pr,
            merge_pr_and_close_ticket,
            list_plane_projects,
            get_plane_asset_url,
            agent_sessions,
            agent_usage,
            reveal_agent,
            open_agent_folder,
            calendar_events,
            import_calendar,
            open_meeting,
            builder_agents,
            builder_interview_turn,
            builder_plan,
            builder_design,
            builder_save_prd,
            term_open,
            term_read,
            term_write,
            term_resize,
            term_close,
            term_info,
            space_status,
            folder_list,
            folder_read_file,
            folder_changes,
            save_workspace_config
        ])
        .run(tauri::generate_context!())
        .expect("error while running Panguyuban Tauri desktop application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use panguyuban_core::models::{ReviewState, TicketState, WorkspaceConfig};
    use panguyuban_core::traits::{GitProvider, IssueProvider};
    use std::sync::Mutex;

    struct RecordingIssueProvider {
        transitions: Mutex<Vec<(String, TicketState)>>,
    }

    #[async_trait]
    impl IssueProvider for RecordingIssueProvider {
        fn provider_name(&self) -> &'static str {
            "plane.so"
        }
        async fn list_tickets(&self) -> Result<Vec<Ticket>, CoreError> {
            Ok(vec![])
        }
        async fn get_ticket(&self, key: &str) -> Result<Ticket, CoreError> {
            Ok(Ticket {
                id: "149".into(),
                key: key.into(),
                title: "Expose rate-limit headers on public endpoints".into(),
                description: "".into(),
                state: TicketState::Todo,
                assignee: Some("@ansar".into()),
                priority: Some("low".into()),
                updated_at: "".into(),
                url: "".into(),
                assigned_to_me: false,
            })
        }
        async fn create_ticket(&self, title: &str, description: &str) -> Result<Ticket, CoreError> {
            Ok(Ticket {
                id: "200".into(),
                key: "PAN-200".into(),
                title: title.into(),
                description: description.into(),
                state: TicketState::Todo,
                assignee: None,
                priority: None,
                updated_at: "".into(),
                url: "".into(),
                assigned_to_me: false,
            })
        }
        async fn transition_ticket(&self, key: &str, next: TicketState) -> Result<Ticket, CoreError> {
            self.transitions
                .lock()
                .unwrap()
                .push((key.to_string(), next.clone()));
            let mut t = self.get_ticket(key).await?;
            t.state = next;
            Ok(t)
        }
    }

    struct RecordingGitProvider {
        branches: Mutex<Vec<String>>,
        approved: Mutex<Vec<u64>>,
        merged: Mutex<Vec<u64>>,
    }

    #[async_trait]
    impl GitProvider for RecordingGitProvider {
        fn provider_name(&self) -> &'static str {
            "github"
        }
        async fn list_pull_requests(&self) -> Result<Vec<PullRequest>, CoreError> {
            Ok(vec![])
        }
        async fn approve_pull_request(&self, repo: &str, number: u64) -> Result<PullRequest, CoreError> {
            self.approved.lock().unwrap().push(number);
            Ok(PullRequest {
                repo: repo.into(),
                review_requested: true,
                number,
                title: "feat(webhook): bounded retry queue".into(),
                author: "@alex".into(),
                source_branch: "feat/pan-145-webhook".into(),
                target_branch: "main".into(),
                mergeable: true,
                additions: 10,
                deletions: 2,
                review_state: ReviewState::Approved,
                ci_state: CiState::Passing { passed: 3, total: 3 },
                linked_ticket_key: Some("PAN-145".into()),
                diff_preview: vec![],
                url: "".into(),
            })
        }
        async fn merge_pull_request(&self, _repo: &str, number: u64, _method: MergeMethod) -> Result<(), CoreError> {
            self.merged.lock().unwrap().push(number);
            Ok(())
        }
        fn create_and_checkout_branch(&self, branch_name: &str) -> Result<(), CoreError> {
            self.branches.lock().unwrap().push(branch_name.to_string());
            Ok(())
        }
        fn checkout_existing_branch(&self, branch_name: &str) -> Result<(), CoreError> {
            self.branches.lock().unwrap().push(branch_name.to_string());
            Ok(())
        }
    }

    #[tokio::test]
    async fn delegates_workflow_actions_to_injected_providers_and_updates_sqlite() {
        let issue_prov = Arc::new(RecordingIssueProvider {
            transitions: Mutex::new(vec![]),
        });
        let git_prov = Arc::new(RecordingGitProvider {
            branches: Mutex::new(vec![]),
            approved: Mutex::new(vec![]),
            merged: Mutex::new(vec![]),
        });
        let state = DesktopController::new_with_providers(
            issue_prov.clone(),
            git_prov.clone(),
        )
        .unwrap();

        let initial = state.get_dashboard_payload().unwrap();
        assert_eq!(initial.tickets.len(), 3);
        assert_eq!(initial.pull_requests.len(), 3);

        let branch = state.execute_start_ticket_branch("PAN-149").await.unwrap();
        assert_eq!(branch, "feat/pan-149-expose-rate-limit-headers");
        assert_eq!(
            git_prov.branches.lock().unwrap().as_slice(),
            &["feat/pan-149-expose-rate-limit-headers"]
        );

        let approved = state.execute_approve_pr("ansar/panguyuban", 92).await.unwrap();
        assert_eq!(approved.review_state, ReviewState::Approved);
        assert_eq!(git_prov.approved.lock().unwrap().as_slice(), &[92]);

        let after_merge = state
            .execute_merge_pr_and_close_ticket("ansar/panguyuban", 89, Some("PAN-142"))
            .await
            .unwrap();
        assert_eq!(after_merge.pull_requests.len(), 2);
        assert_eq!(git_prov.merged.lock().unwrap().as_slice(), &[89]);
        assert!(issue_prov
            .transitions
            .lock()
            .unwrap()
            .contains(&("PAN-142".to_string(), TicketState::Done)));

        let mut cfg = WorkspaceConfig::default();
        cfg.plane_workspace_slug = "team-panguyuban".into();
        let saved = state.save_config(cfg, None, None, None).unwrap();
        assert_eq!(saved.plane_workspace_slug, "team-panguyuban");
    }
}
