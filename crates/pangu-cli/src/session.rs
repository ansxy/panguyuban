//! The pangu session: the folder, the run record and what is remembered between runs.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use agent_runtime::{effective, session_type, HarnessSettings, PolicyContext, Workspace};
use panguyuban_core::storage::SqliteStore;

/// Nearest ancestor (including `start`) with a `.git` entry, else `start`.
pub fn find_root(start: &Path) -> PathBuf {
    start.ancestors().find(|d| d.join(".git").exists()).unwrap_or(start).to_path_buf()
}

pub fn data_dir() -> PathBuf {
    dirs::data_local_dir().unwrap_or_else(std::env::temp_dir).join("panguyuban")
}

pub fn open_store() -> Result<SqliteStore, String> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    SqliteStore::open_path(&dir.join("state.db")).map_err(|e| e.to_string())
}

/// The folder path with every character outside `[A-Za-z0-9]` replaced by `-`.
pub fn folder_slug(root: &Path) -> String {
    root.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

pub struct Session {
    pub id: String,
    pub root: PathBuf,
}

impl Session {
    #[allow(dead_code)] // used by the launcher in Task 5
    pub fn start(root: PathBuf) -> Session {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        Session { id: format!("{secs}-{}", std::process::id()), root }
    }

    /// Both variables are required and non-empty.
    pub fn from_env() -> Option<Session> {
        let get = |k| std::env::var(k).ok().filter(|v| !v.is_empty());
        Some(Session { id: get("PANGU_SESSION")?, root: PathBuf::from(get("PANGU_ROOT")?) })
    }

    #[allow(dead_code)] // used by the launcher in Task 5
    pub fn env(&self) -> [(&'static str, String); 2] {
        [("PANGU_SESSION", self.id.clone()), ("PANGU_ROOT", self.root.to_string_lossy().into_owned())]
    }

    pub fn record_path(&self) -> PathBuf {
        data_dir().join("runs").join(folder_slug(&self.root)).join(format!("{}.jsonl", self.id))
    }
}

/// Appends one line to the record. Failures are ignored: the record never blocks work.
pub fn append_record(path: &Path, line: serde_json::Value) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

pub fn count_calls(path: &Path) -> u32 {
    std::fs::read_to_string(path)
        .map(|s| {
            s.lines()
                .filter(|l| serde_json::from_str::<serde_json::Value>(l).is_ok_and(|v| v["type"] == "call"))
                .count() as u32
        })
        .unwrap_or(0)
}

fn allowed_map(store: &SqliteStore) -> HashMap<String, Vec<String>> {
    store
        .get_app_data("pangu-allowed")
        .ok()
        .flatten()
        .and_then(|j| serde_json::from_str(&j).ok())
        .unwrap_or_default()
}

pub fn allowed_commands(store: &SqliteStore, root: &Path) -> Vec<String> {
    allowed_map(store).remove(&root.to_string_lossy().into_owned()).unwrap_or_default()
}

pub fn remember_command(store: &SqliteStore, root: &Path, command: &str) -> Result<(), String> {
    let mut all = allowed_map(store);
    let list = all.entry(root.to_string_lossy().into_owned()).or_default();
    if !list.iter().any(|c| c == command) {
        list.push(command.to_string());
    }
    let json = serde_json::to_string(&all).map_err(|e| e.to_string())?;
    store.set_app_data("pangu-allowed", &json).map_err(|e| e.to_string())
}

pub fn policy_context(store: &SqliteStore, session: &Session) -> Result<PolicyContext, String> {
    let st = session_type("work-on-project").ok_or("work-on-project session type missing")?;
    // Same read as the app's `load_harness_settings`, but a corrupt value is an error here (deny), not a default.
    let saved: HashMap<String, HarnessSettings> = match store.get_app_data("harness").map_err(|e| e.to_string())? {
        Some(json) => serde_json::from_str(&json).map_err(|e| e.to_string())?,
        None => HashMap::new(),
    };
    Ok(PolicyContext {
        workspace: Workspace::new(&session.root, &st.write_paths).map_err(|e| e.to_string())?,
        effective: effective(&st, saved.get(&st.id)),
        always_allowed: allowed_commands(store, &session.root),
        steps_so_far: count_calls(&session.record_path()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_folder_is_the_git_root() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(repo.join("src")).unwrap();
        assert_eq!(find_root(&repo.join("src")), repo);
        let bare = tmp.path().join("bare");
        std::fs::create_dir_all(&bare).unwrap();
        // tempdir may sit under a repo on some machines; only assert when it does not.
        if !tmp.path().ancestors().any(|d| d.join(".git").exists()) {
            assert_eq!(find_root(&bare), bare);
        }
    }

    #[test]
    fn slugs_are_path_safe() {
        assert_eq!(folder_slug(Path::new("/Users/sam/code/orders-api")), "-Users-sam-code-orders-api");
    }

    #[test]
    fn calls_are_counted_from_the_record() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("runs/x.jsonl");
        assert_eq!(count_calls(&p), 0);
        append_record(&p, serde_json::json!({"type":"call","tool":"Bash"}));
        append_record(&p, serde_json::json!({"type":"decision"}));
        append_record(&p, serde_json::json!({"type":"call","tool":"Edit"}));
        assert_eq!(count_calls(&p), 2);
    }

    #[test]
    fn remembered_commands_are_per_folder() {
        let store = SqliteStore::open_in_memory().unwrap();
        let (a, b) = (Path::new("/work/orders-api"), Path::new("/work/customers"));
        remember_command(&store, a, "npm test").unwrap();
        assert_eq!(allowed_commands(&store, a), ["npm test"]);
        assert!(allowed_commands(&store, b).is_empty());
    }
}
