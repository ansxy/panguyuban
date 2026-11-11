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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Ticket {
    pub id: String,
    pub key: String,
    pub title: String,
    pub description: String,
    pub state: TicketState,
    pub assignee: Option<String>,
    pub priority: Option<String>,
    pub updated_at: String,
    pub url: String,
    /// True when the Plane `users/me` id is among the assignees.
    #[serde(default)]
    pub assigned_to_me: bool,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PullRequest {
    /// `owner/name`. PR numbers are only unique within a repository.
    #[serde(default)]
    pub repo: String,
    pub number: u64,
    pub title: String,
    pub author: String,
    pub source_branch: String,
    pub target_branch: String,
    pub mergeable: bool,
    pub additions: u32,
    pub deletions: u32,
    pub review_state: ReviewState,
    pub ci_state: CiState,
    pub linked_ticket_key: Option<String>,
    pub diff_preview: Vec<String>,
    pub url: String,
    /// True when the current user is a requested reviewer (vs. author).
    #[serde(default)]
    pub review_requested: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Copy, PartialEq, Eq)]
pub enum MergeMethod {
    Squash,
    MergeCommit,
    Rebase,
}

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

impl Default for WorkspaceConfig {
    fn default() -> Self {
        Self {
            issue_provider: "plane.so".to_string(),
            plane_base_url: "https://api.plane.so".to_string(),
            plane_workspace_slug: "panguyuban".to_string(),
            plane_project_id: "panguyuban-core".to_string(),
            git_provider: "github".to_string(),
            github_api_url: "https://api.github.com".to_string(),
            github_repo: String::new(),
            local_repo_path: ".".to_string(),
        }
    }
}
