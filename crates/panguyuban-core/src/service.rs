use std::sync::Arc;

use crate::error::CoreError;
use crate::linker::{extract_ticket_key, format_branch_name};
use crate::models::{MergeMethod, PullRequest, Ticket, TicketState};
use crate::storage::SqliteStore;
use crate::traits::{GitProvider, IssueProvider};

#[derive(Clone)]
pub struct WorkflowService {
    store: SqliteStore,
    issue_provider: Arc<dyn IssueProvider>,
    git_provider: Arc<dyn GitProvider>,
}

impl WorkflowService {
    pub fn new(
        store: SqliteStore,
        issue_provider: Arc<dyn IssueProvider>,
        git_provider: Arc<dyn GitProvider>,
    ) -> Self {
        Self {
            store,
            issue_provider,
            git_provider,
        }
    }

    pub fn store(&self) -> &SqliteStore {
        &self.store
    }

    pub fn issue_provider(&self) -> &Arc<dyn IssueProvider> {
        &self.issue_provider
    }

    pub fn git_provider(&self) -> &Arc<dyn GitProvider> {
        &self.git_provider
    }

    /// Refreshes the ticket cache from Plane, replacing what was there.
    pub async fn sync_tickets(&self) -> Result<Vec<Ticket>, CoreError> {
        let tickets = self.issue_provider.list_tickets().await?;
        self.store.replace_tickets(&tickets)?;
        Ok(tickets)
    }

    /// Refreshes the PR cache from GitHub, replacing what was there.
    pub async fn sync_pull_requests(&self) -> Result<Vec<PullRequest>, CoreError> {
        let mut prs = self.git_provider.list_pull_requests().await?;
        for pr in &mut prs {
            if pr.linked_ticket_key.is_none() {
                pr.linked_ticket_key = extract_ticket_key(&pr.source_branch, &pr.title);
            }
        }
        self.store.replace_pull_requests(&prs)?;
        Ok(prs)
    }

    /// Plane and GitHub sync independently (as in top-bar): one failing never
    /// blocks the other's cache from refreshing. The first error is still returned.
    pub async fn sync_all(&self) -> Result<(Vec<Ticket>, Vec<PullRequest>), CoreError> {
        let tickets = self.sync_tickets().await;
        let prs = self.sync_pull_requests().await;
        Ok((tickets?, prs?))
    }

    pub async fn start_ticket_branch(&self, ticket_key: &str) -> Result<String, CoreError> {
        let ticket = self.issue_provider.get_ticket(ticket_key).await?;
        let branch = format_branch_name(&ticket.key, &ticket.title);
        self.git_provider.create_and_checkout_branch(&branch)?;
        let updated = self
            .issue_provider
            .transition_ticket(ticket_key, TicketState::InProgress)
            .await?;
        self.store.upsert_tickets(std::slice::from_ref(&updated))?;
        Ok(branch)
    }

    pub async fn merge_and_complete(
        &self,
        repo: &str,
        pr_number: u64,
        method: MergeMethod,
        ticket_key: Option<&str>,
    ) -> Result<(), CoreError> {
        self.git_provider
            .merge_pull_request(repo, pr_number, method)
            .await?;
        self.store.remove_pull_request(repo, pr_number)?;

        if let Some(key) = ticket_key {
            match self
                .issue_provider
                .transition_ticket(key, TicketState::Done)
                .await
            {
                Ok(updated) => {
                    self.store.upsert_tickets(std::slice::from_ref(&updated))?;
                }
                Err(err) => {
                    return Err(CoreError::TicketTransitionAfterMerge {
                        pr_number,
                        ticket_key: key.to_string(),
                        reason: err.to_string(),
                    });
                }
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::CoreError;
    use crate::models::{CiState, MergeMethod, PullRequest, ReviewState, Ticket, TicketState};
    use crate::storage::SqliteStore;
    use crate::traits::{GitProvider, IssueProvider};
    use async_trait::async_trait;
    use std::sync::{Arc, Mutex};

    struct FakeIssueProvider {
        fail_transition: bool,
        tickets: Mutex<Vec<Ticket>>,
    }

    #[async_trait]
    impl IssueProvider for FakeIssueProvider {
        fn provider_name(&self) -> &'static str {
            "plane.so"
        }

        async fn list_tickets(&self) -> Result<Vec<Ticket>, CoreError> {
            Ok(self.tickets.lock().unwrap().clone())
        }

        async fn get_ticket(&self, key: &str) -> Result<Ticket, CoreError> {
            self.tickets
                .lock()
                .unwrap()
                .iter()
                .find(|t| t.key == key)
                .cloned()
                .ok_or_else(|| CoreError::NotFound(key.to_string()))
        }

        async fn create_ticket(&self, title: &str, description: &str) -> Result<Ticket, CoreError> {
            Ok(Ticket {
                id: "new".into(),
                key: "PAN-200".into(),
                title: title.into(),
                description: description.into(),
                state: TicketState::Todo,
                assignee: None,
                priority: None,
                updated_at: "now".into(),
                url: "".into(),
                assigned_to_me: false,
            })
        }

        async fn transition_ticket(&self, key: &str, next: TicketState) -> Result<Ticket, CoreError> {
            if self.fail_transition {
                return Err(CoreError::ProviderHttp {
                    provider: "plane.so".into(),
                    status: 502,
                    message: "Bad Gateway".into(),
                });
            }
            let mut guard = self.tickets.lock().unwrap();
            let ticket = guard
                .iter_mut()
                .find(|t| t.key == key)
                .ok_or_else(|| CoreError::NotFound(key.to_string()))?;
            ticket.state = next;
            Ok(ticket.clone())
        }
    }

    struct FakeGitProvider {
        merged: Mutex<Vec<u64>>,
        checked_out: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl GitProvider for FakeGitProvider {
        fn provider_name(&self) -> &'static str {
            "github"
        }

        async fn list_pull_requests(&self) -> Result<Vec<PullRequest>, CoreError> {
            Ok(vec![PullRequest {
                repo: "ansar/panguyuban".into(),
                review_requested: false,
                number: 89,
                title: "fix(auth): serialize token refresh".into(),
                author: "@ansar".into(),
                source_branch: "fix/pan-142-jwt".into(),
                target_branch: "main".into(),
                mergeable: true,
                additions: 84,
                deletions: 19,
                review_state: ReviewState::Approved,
                ci_state: CiState::Passing { passed: 3, total: 3 },
                linked_ticket_key: None,
                diff_preview: vec![],
                url: "".into(),
            }])
        }

        async fn approve_pull_request(&self, _repo: &str, number: u64) -> Result<PullRequest, CoreError> {
            let mut prs = self.list_pull_requests().await?;
            prs[0].number = number;
            prs[0].review_state = ReviewState::Approved;
            Ok(prs.remove(0))
        }

        async fn merge_pull_request(&self, _repo: &str, number: u64, _method: MergeMethod) -> Result<(), CoreError> {
            self.merged.lock().unwrap().push(number);
            Ok(())
        }

        fn create_and_checkout_branch(&self, branch_name: &str) -> Result<(), CoreError> {
            self.checked_out.lock().unwrap().push(branch_name.to_string());
            Ok(())
        }

        fn checkout_existing_branch(&self, branch_name: &str) -> Result<(), CoreError> {
            self.checked_out.lock().unwrap().push(branch_name.to_string());
            Ok(())
        }
    }

    #[tokio::test]
    async fn sync_populates_linked_ticket_key_and_merge_reports_partial_transition_failure() {
        let store = SqliteStore::open_in_memory().unwrap();
        let issue_provider = Arc::new(FakeIssueProvider {
            fail_transition: true,
            tickets: Mutex::new(vec![Ticket {
                id: "142".into(),
                key: "PAN-142".into(),
                title: "Fix JWT refresh race".into(),
                description: "".into(),
                state: TicketState::InReview,
                assignee: Some("@ansar".into()),
                priority: Some("high".into()),
                updated_at: "".into(),
                url: "".into(),
                assigned_to_me: false,
            }]),
        });
        let git_provider = Arc::new(FakeGitProvider {
            merged: Mutex::new(vec![]),
            checked_out: Mutex::new(vec![]),
        });

        let svc = WorkflowService::new(store, issue_provider, git_provider);
        let (_tickets, prs) = svc.sync_all().await.unwrap();
        assert_eq!(prs[0].linked_ticket_key, Some("PAN-142".to_string()));

        let err = svc
            .merge_and_complete("ansar/panguyuban", 89, MergeMethod::Squash, Some("PAN-142"))
            .await
            .unwrap_err();

        assert!(matches!(
            err,
            CoreError::TicketTransitionAfterMerge {
                pr_number: 89,
                ref ticket_key,
                ..
            } if ticket_key == "PAN-142"
        ));
        assert!(svc.store().list_cached_pull_requests().unwrap().is_empty());
    }
}
