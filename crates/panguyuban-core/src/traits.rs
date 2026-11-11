use async_trait::async_trait;

use crate::error::CoreError;
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
