use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::CoreError;
use crate::models::{PullRequest, Ticket, WorkspaceConfig};

#[derive(Clone)]
pub struct SqliteStore {
    conn: Arc<Mutex<Connection>>,
}

impl SqliteStore {
    pub fn open_in_memory() -> Result<Self, CoreError> {
        let conn = Connection::open_in_memory().map_err(|e| CoreError::StorageError(e.to_string()))?;
        let store = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        store.init_schema()?;
        Ok(store)
    }

    pub fn open_path(path: &Path) -> Result<Self, CoreError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| CoreError::StorageError(e.to_string()))?;
        }
        let conn = Connection::open(path).map_err(|e| CoreError::StorageError(e.to_string()))?;
        let store = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        store.init_schema()?;
        Ok(store)
    }

    fn init_schema(&self) -> Result<(), CoreError> {
        let guard = self
            .conn
            .lock()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        guard
            .execute_batch(
                "
                CREATE TABLE IF NOT EXISTS tickets (
                    key TEXT PRIMARY KEY,
                    payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS pull_requests_v2 (
                    repo TEXT NOT NULL,
                    number INTEGER NOT NULL,
                    linked_ticket_key TEXT,
                    payload TEXT NOT NULL,
                    PRIMARY KEY (repo, number)
                );
                CREATE TABLE IF NOT EXISTS workspace_config (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS app_data (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                ",
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        let default_json = serde_json::to_string(&WorkspaceConfig::default())
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        guard
            .execute(
                "INSERT OR IGNORE INTO workspace_config (id, payload) VALUES (1, ?1)",
                params![default_json],
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        Ok(())
    }

    /// Small app-owned documents (the UI's saved prototypes and request drafts), one JSON string per key.
    pub fn get_app_data(&self, key: &str) -> Result<Option<String>, CoreError> {
        let guard = self
            .conn
            .lock()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        guard
            .query_row("SELECT value FROM app_data WHERE key = ?1", params![key], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|e| CoreError::StorageError(e.to_string()))
    }

    pub fn set_app_data(&self, key: &str, value: &str) -> Result<(), CoreError> {
        let guard = self
            .conn
            .lock()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        guard
            .execute(
                "INSERT INTO app_data (key, value, updated_at) VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![key, value],
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        Ok(())
    }

    pub fn upsert_tickets(&self, tickets: &[Ticket]) -> Result<(), CoreError> {
        let mut guard = self
            .conn
            .lock()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        let tx = guard
            .transaction()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        for ticket in tickets {
            let payload = serde_json::to_string(ticket)
                .map_err(|e| CoreError::StorageError(e.to_string()))?;
            tx.execute(
                "INSERT OR REPLACE INTO tickets (key, payload) VALUES (?1, ?2)",
                params![ticket.key, payload],
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        }

        tx.commit()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        Ok(())
    }

    pub fn list_cached_tickets(&self) -> Result<Vec<Ticket>, CoreError> {
        let guard = self
            .conn
            .lock()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        let mut stmt = guard
            .prepare("SELECT payload FROM tickets ORDER BY key ASC")
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        let mut items = Vec::new();
        for row in rows {
            let json = row.map_err(|e| CoreError::StorageError(e.to_string()))?;
            let ticket: Ticket =
                serde_json::from_str(&json).map_err(|e| CoreError::StorageError(e.to_string()))?;
            items.push(ticket);
        }
        Ok(items)
    }

    pub fn upsert_pull_requests(&self, prs: &[PullRequest]) -> Result<(), CoreError> {
        let mut guard = self
            .conn
            .lock()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        let tx = guard
            .transaction()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        for pr in prs {
            let payload =
                serde_json::to_string(pr).map_err(|e| CoreError::StorageError(e.to_string()))?;
            tx.execute(
                "INSERT OR REPLACE INTO pull_requests_v2 (repo, number, linked_ticket_key, payload) VALUES (?1, ?2, ?3, ?4)",
                params![pr.repo, pr.number, pr.linked_ticket_key, payload],
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        }

        tx.commit()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        Ok(())
    }

    /// Swaps the ticket cache for a fresh sync, so closed tickets drop out.
    pub fn replace_tickets(&self, tickets: &[Ticket]) -> Result<(), CoreError> {
        self.clear_table("tickets")?;
        self.upsert_tickets(tickets)
    }

    /// Swaps the PR cache for a fresh sync, so merged/closed PRs drop out.
    pub fn replace_pull_requests(&self, prs: &[PullRequest]) -> Result<(), CoreError> {
        self.clear_table("pull_requests_v2")?;
        self.upsert_pull_requests(prs)
    }

    fn clear_table(&self, table: &str) -> Result<(), CoreError> {
        self.conn
            .lock()
            .map_err(|e| CoreError::StorageError(e.to_string()))?
            .execute(&format!("DELETE FROM {table}"), [])
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        Ok(())
    }

    pub fn remove_pull_request(&self, repo: &str, number: u64) -> Result<(), CoreError> {
        let guard = self
            .conn
            .lock()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        guard
            .execute(
                "DELETE FROM pull_requests_v2 WHERE repo = ?1 AND number = ?2",
                params![repo, number],
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        Ok(())
    }

    pub fn list_cached_pull_requests(&self) -> Result<Vec<PullRequest>, CoreError> {
        let guard = self
            .conn
            .lock()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        let mut stmt = guard
            .prepare("SELECT payload FROM pull_requests_v2 ORDER BY repo ASC, number ASC")
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| CoreError::StorageError(e.to_string()))?;

        let mut items = Vec::new();
        for row in rows {
            let json = row.map_err(|e| CoreError::StorageError(e.to_string()))?;
            let pr: PullRequest =
                serde_json::from_str(&json).map_err(|e| CoreError::StorageError(e.to_string()))?;
            items.push(pr);
        }
        Ok(items)
    }

    pub fn get_config(&self) -> Result<WorkspaceConfig, CoreError> {
        let guard = self
            .conn
            .lock()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        let json: String = guard
            .query_row(
                "SELECT payload FROM workspace_config WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        serde_json::from_str(&json).map_err(|e| CoreError::StorageError(e.to_string()))
    }

    pub fn save_config(&self, cfg: &WorkspaceConfig) -> Result<(), CoreError> {
        let guard = self
            .conn
            .lock()
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        let payload =
            serde_json::to_string(cfg).map_err(|e| CoreError::StorageError(e.to_string()))?;
        guard
            .execute(
                "INSERT OR REPLACE INTO workspace_config (id, payload) VALUES (1, ?1)",
                params![payload],
            )
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{CiState, PullRequest, ReviewState, Ticket, TicketState, WorkspaceConfig};

    #[test]
    fn upserts_tickets_and_prs_idempotently_and_preserves_unlinked_prs() {
        let store = SqliteStore::open_in_memory().expect("open in-memory sqlite");

        let mut ticket = Ticket {
            id: "uuid-142".into(),
            key: "PAN-142".into(),
            title: "Fix JWT refresh race".into(),
            description: "Initial".into(),
            state: TicketState::Todo,
            assignee: Some("@ansar".into()),
            priority: Some("high".into()),
            updated_at: "2026-11-11T02:00:00Z".into(),
            url: "https://app.plane.so/panguyuban/issues/142".into(),
            assigned_to_me: false,
        };
        store.upsert_tickets(std::slice::from_ref(&ticket)).unwrap();

        ticket.state = TicketState::InReview;
        store.upsert_tickets(std::slice::from_ref(&ticket)).unwrap();

        let cached_tickets = store.list_cached_tickets().unwrap();
        assert_eq!(cached_tickets.len(), 1);
        assert_eq!(cached_tickets[0].state, TicketState::InReview);

        let pr_linked = PullRequest {
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
            linked_ticket_key: Some("PAN-142".into()),
            diff_preview: vec!["+ let _guard = lock.await;".into()],
            url: "https://github.com/ansar/panguyuban/pull/89".into(),
        };
        let pr_unlinked = PullRequest {
            repo: "ansar/panguyuban".into(),
            review_requested: true,
            number: 94,
            title: "chore(cargo): bump tokio".into(),
            author: "@sarah".into(),
            source_branch: "chore/tokio-bump".into(),
            target_branch: "main".into(),
            mergeable: true,
            additions: 10,
            deletions: 10,
            review_state: ReviewState::ReviewRequired,
            ci_state: CiState::Passing { passed: 3, total: 3 },
            linked_ticket_key: None,
            diff_preview: vec![],
            url: "https://github.com/ansar/panguyuban/pull/94".into(),
        };

        store
            .upsert_pull_requests(&[pr_linked.clone(), pr_unlinked.clone()])
            .unwrap();
        store
            .upsert_pull_requests(&[pr_linked, pr_unlinked])
            .unwrap();

        let cached_prs = store.list_cached_pull_requests().unwrap();
        assert_eq!(cached_prs.len(), 2);
        assert_eq!(cached_prs[0].number, 89);
        assert_eq!(cached_prs[1].number, 94);
        assert_eq!(cached_prs[1].linked_ticket_key, None);

        let mut cfg = WorkspaceConfig::default();
        cfg.plane_workspace_slug = "custom-slug".into();
        store.save_config(&cfg).unwrap();
        assert_eq!(store.get_config().unwrap().plane_workspace_slug, "custom-slug");
    }

    #[test]
    fn app_data_roundtrips_and_overwrites() {
        let store = SqliteStore::open_in_memory().expect("open in-memory sqlite");
        assert_eq!(store.get_app_data("builder").unwrap(), None);
        store.set_app_data("builder", "[1]").unwrap();
        assert_eq!(store.get_app_data("builder").unwrap().as_deref(), Some("[1]"));
        store.set_app_data("builder", "[2]").unwrap();
        assert_eq!(store.get_app_data("builder").unwrap().as_deref(), Some("[2]"));
        assert_eq!(store.get_app_data("requests").unwrap(), None);
    }
}
