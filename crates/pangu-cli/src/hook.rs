//! Guard rails for external agents: a hook either denies or prints nothing.

use agent_runtime::{decide, Action, Decision, PolicyContext};
use serde_json::{json, Value};

use crate::session::{append_record, Session};

#[derive(Clone, Copy)]
pub enum Agent {
    Claude,
}

#[derive(Debug, PartialEq)]
pub enum HookOutcome {
    Silent,
    Deny(String),
}

pub fn claude_action(payload: &Value) -> Action {
    let name = payload["tool_name"].as_str().unwrap_or("");
    let input = &payload["tool_input"];
    let field = |k: &str| input[k].as_str().map(String::from);
    match name {
        "Read" => Action::Read(field("file_path").unwrap_or_default()),
        "Glob" | "Grep" => Action::Read(field("path").unwrap_or_else(|| ".".into())),
        "Edit" | "Write" | "MultiEdit" => Action::Write(field("file_path").unwrap_or_default()),
        "NotebookEdit" => Action::Write(field("notebook_path").unwrap_or_default()),
        "Bash" => Action::Run(field("command").unwrap_or_default()),
        other => Action::Other(other.to_string()),
    }
}

pub fn check(
    agent: Agent,
    stdin: &str,
    session: Option<&Session>,
    ctx: impl FnOnce(&Session) -> Result<PolicyContext, String>,
) -> HookOutcome {
    let Some(session) = session else { return HookOutcome::Silent };
    // Inside a session anything unexpected denies.
    let Ok(payload) = serde_json::from_str::<Value>(stdin) else {
        return HookOutcome::Deny("pangu could not read the hook input".into());
    };
    let ctx = match ctx(session) {
        Ok(c) => c,
        Err(e) => return HookOutcome::Deny(format!("pangu could not load its policy: {e}")),
    };
    let Agent::Claude = agent;
    let action = claude_action(&payload);
    let decision = decide(&ctx, &action);
    let (kind, target) = match &action {
        Action::Read(t) => ("read", t.as_str()),
        Action::Write(t) => ("write", t.as_str()),
        Action::Run(t) => ("run", t.as_str()),
        Action::Other(t) => ("other", t.as_str()),
    };
    let (word, reason) = match &decision {
        Decision::Allow => ("allow", None),
        Decision::Ask(r) => ("ask", Some(r.clone())),
        Decision::Deny(r) => ("deny", Some(r.clone())),
    };
    append_record(
        &session.record_path(),
        json!({"type":"decision","tool":payload["tool_name"],"action":kind,"target":target,"decision":word,"reason":reason}),
    );
    match decision {
        Decision::Deny(r) => HookOutcome::Deny(r),
        _ => HookOutcome::Silent,
    }
}

pub fn record(agent: Agent, stdin: &str, session: &Session) {
    let Agent::Claude = agent;
    let Ok(payload) = serde_json::from_str::<Value>(stdin) else { return };
    let mut input = payload["tool_input"].to_string();
    if let Some((i, _)) = input.char_indices().nth(2000) {
        input.truncate(i);
    }
    append_record(&session.record_path(), json!({"type":"call","tool":payload["tool_name"],"input":input}));
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_runtime::{effective, session_type, HarnessSettings, Workspace};
    use std::path::Path;

    fn pctx(root: &Path, settings: Option<&HarnessSettings>) -> PolicyContext {
        let st = session_type("work-on-project").unwrap();
        PolicyContext {
            workspace: Workspace::new(root, &["*".into()]).unwrap(),
            effective: effective(&st, settings),
            always_allowed: vec![],
            steps_so_far: 0,
        }
    }

    fn run(root: &Path, payload: Value, settings: Option<&HarnessSettings>) -> HookOutcome {
        let s = Session { id: "t-1".into(), root: root.to_path_buf() };
        check(Agent::Claude, &payload.to_string(), Some(&s), |_| Ok(pctx(root, settings)))
    }

    #[test]
    fn claude_tools_map_to_actions() {
        let a = |v: Value| claude_action(&v);
        assert!(matches!(a(json!({"tool_name":"Edit","tool_input":{"file_path":"a.ts"}})), Action::Write(p) if p == "a.ts"));
        assert!(matches!(a(json!({"tool_name":"Bash","tool_input":{"command":"npm test"}})), Action::Run(c) if c == "npm test"));
        assert!(matches!(a(json!({"tool_name":"Grep","tool_input":{}})), Action::Read(p) if p == "."));
        assert!(matches!(a(json!({"tool_name":"TodoWrite","tool_input":{}})), Action::Other(n) if n == "TodoWrite"));
    }

    #[test]
    fn claude_writes_are_checked_by_absolute_path() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(repo.join("src")).unwrap();
        let repo = repo.canonicalize().unwrap();
        let w = |p: String| run(&repo, json!({"tool_name":"Write","tool_input":{"file_path":p}}), None);
        assert_eq!(w(format!("{}/src/a.ts", repo.display())), HookOutcome::Silent);
        assert_eq!(w("/etc/hosts".into()), HookOutcome::Deny("writes outside the project are not allowed".into()));
        assert_eq!(w(format!("{}/.git/config", repo.display())), HookOutcome::Deny("the .git folder is off limits".into()));
    }

    #[test]
    fn outside_a_session_check_is_inert() {
        let out = check(Agent::Claude, "garbage", None, |_| panic!("ctx must not be called"));
        assert_eq!(out, HookOutcome::Silent);
    }

    #[test]
    fn bad_input_inside_a_session_denies() {
        let tmp = tempfile::tempdir().unwrap();
        let s = Session { id: "t-2".into(), root: tmp.path().to_path_buf() };
        let root = tmp.path();
        assert!(matches!(check(Agent::Claude, "not json", Some(&s), |_| Ok(pctx(root, None))), HookOutcome::Deny(_)));
        let out = check(Agent::Claude, "{}", Some(&s), |_| Err("db".into()));
        assert!(matches!(out, HookOutcome::Deny(r) if r.contains("db")));
    }

    #[test]
    fn asks_are_silent_for_claude() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let bash = json!({"tool_name":"Bash","tool_input":{"command":"rm -rf build"}});
        assert_eq!(run(&root, bash.clone(), None), HookOutcome::Silent);
        let off = HarnessSettings { tools: Some(vec!["read_file".into()]), ..Default::default() };
        assert_eq!(run(&root, bash, Some(&off)), HookOutcome::Deny("commands are switched off in Settings".into()));
    }
}
