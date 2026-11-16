use async_trait::async_trait;

use crate::error::CoreError;
use crate::models::{MergeMethod, PullRequest, Ticket, TicketState, TicketStatus};

#[async_trait]
pub trait IssueProvider: Send + Sync {
    fn provider_name(&self) -> &'static str;
    async fn list_tickets(&self) -> Result<Vec<Ticket>, CoreError>;
    async fn get_ticket(&self, key: &str) -> Result<Ticket, CoreError>;
    async fn create_ticket(&self, title: &str, description: &str) -> Result<Ticket, CoreError>;
    async fn transition_ticket(&self, key: &str, next: TicketState) -> Result<Ticket, CoreError>;

    /// The statuses this ticket can move to, as its tracker defines them: a project's
    /// states in Plane, an issue's allowed transitions in Jira.
    async fn ticket_statuses(&self, key: &str) -> Result<Vec<TicketStatus>, CoreError> {
        let _ = key;
        Err(CoreError::NotFound(format!("{} cannot list statuses", self.provider_name())))
    }

    /// Moves the ticket to one of the statuses from `ticket_statuses`.
    async fn move_ticket(&self, key: &str, status_id: &str) -> Result<Ticket, CoreError> {
        let _ = (key, status_id);
        Err(CoreError::NotFound(format!("{} cannot move tickets", self.provider_name())))
    }
}

#[async_trait]
pub trait GitProvider: Send + Sync {
    fn provider_name(&self) -> &'static str;
    async fn list_pull_requests(&self) -> Result<Vec<PullRequest>, CoreError>;
    async fn approve_pull_request(&self, repo: &str, number: u64) -> Result<PullRequest, CoreError>;
    async fn merge_pull_request(
        &self,
        repo: &str,
        number: u64,
        method: MergeMethod,
    ) -> Result<(), CoreError>;
    /// Unified diff lines for one PR, fetched on demand when it is opened.
    async fn pull_request_diff(&self, _repo: &str, _number: u64) -> Result<Vec<String>, CoreError> {
        Ok(Vec::new())
    }
    fn create_and_checkout_branch(&self, branch_name: &str) -> Result<(), CoreError>;
    fn checkout_existing_branch(&self, branch_name: &str) -> Result<(), CoreError>;
}

pub trait SecretStore: Send + Sync {
    fn get_secret(&self, key: &str) -> Result<Option<String>, CoreError>;
    fn set_secret(&self, key: &str, value: &str) -> Result<(), CoreError>;
}
