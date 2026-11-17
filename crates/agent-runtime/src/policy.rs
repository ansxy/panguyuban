//! The one policy that decides every read, write and command, for our own loop and for guarded agents.

use std::path::Path;

use crate::{Effective, Workspace};

pub enum Action {
    Read(String),
    Write(String),
    Run(String),
    Other(String),
}

#[derive(Debug, PartialEq)]
pub enum Decision {
    Allow,
    Deny(String),
    Ask(String),
}

pub struct PolicyContext {
    pub workspace: Workspace,
    pub effective: Effective,
    pub always_allowed: Vec<String>,
    pub steps_so_far: u32,
}

/// An absolute path inside `root` made relative (forward slashes); a relative path as is;
/// an absolute path outside `root` is `None`.
pub fn relative_to(root: &Path, path: &str) -> Option<String> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Some(path.to_string());
    }
    let rel = p.strip_prefix(root).ok()?;
    Some(rel.to_string_lossy().replace('\\', "/"))
}

pub fn decide(ctx: &PolicyContext, action: &Action) -> Decision {
    let enabled = |names: &[&str]| ctx.effective.tools.iter().any(|t| names.contains(&t.as_str()));
    let deny = |m: &str| Decision::Deny(m.into());
    if ctx.steps_so_far >= ctx.effective.max_steps && matches!(action, Action::Write(_) | Action::Run(_)) {
        return deny("step limit reached; start a new pangu session");
    }
    match action {
        Action::Read(p) => {
            if !enabled(&["read_file", "list_files", "search"]) {
                deny("reading is switched off in Settings")
            } else if relative_to(ctx.workspace.root(), p).is_none() {
                Decision::Ask("reads outside the project".into())
            } else {
                Decision::Allow
            }
        }
        Action::Write(p) => {
            if !enabled(&["write_file", "edit_file"]) {
                return deny("writing is switched off in Settings");
            }
            let Some(rel) = relative_to(ctx.workspace.root(), p) else {
                return deny("writes outside the project are not allowed");
            };
            match ctx.workspace.check_write(&rel) {
                Ok(()) => Decision::Allow,
                Err(reason) => Decision::Deny(reason),
            }
        }
        Action::Run(c) => {
            if !enabled(&["run_command"]) {
                deny("commands are switched off in Settings")
            } else if ctx.always_allowed.iter().any(|a| a == c) {
                Decision::Allow
            } else {
                Decision::Ask(format!("run `{c}`?"))
            }
        }
        Action::Other(_) => Decision::Ask("unknown tool".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{effective, session_type, HarnessSettings};

    fn ctx(saved: Option<&HarnessSettings>, steps: u32) -> (tempfile::TempDir, PolicyContext) {
        let dir = tempfile::tempdir().unwrap();
        let workspace = Workspace::new(dir.path(), &["*".to_string()]).unwrap();
        let effective = effective(&session_type("work-on-project").unwrap(), saved);
        (dir, PolicyContext { workspace, effective, always_allowed: vec!["npm test".into()], steps_so_far: steps })
    }

    fn w(p: &str) -> Action {
        Action::Write(p.into())
    }

    #[test]
    fn writes_inside_are_allowed_and_git_is_not() {
        let (_d, c) = ctx(None, 0);
        assert_eq!(decide(&c, &w("src/a.ts")), Decision::Allow);
        assert_eq!(decide(&c, &w(".git/hooks/pre-commit")), Decision::Deny("the .git folder is off limits".into()));
        assert!(matches!(decide(&c, &w(".GIT/config")), Decision::Deny(_)));
    }

    #[test]
    fn absolute_paths_are_made_relative() {
        let (_d, c) = ctx(None, 0);
        let root = c.workspace.root().to_path_buf();
        let abs = format!("{}/src/a.ts", root.display());
        assert_eq!(relative_to(&root, &abs), Some("src/a.ts".into()));
        assert_eq!(relative_to(&root, "/etc/hosts"), None);
        assert_eq!(decide(&c, &w(&abs)), Decision::Allow);
        assert_eq!(decide(&c, &w("/etc/hosts")), Decision::Deny("writes outside the project are not allowed".into()));
        assert_eq!(decide(&c, &Action::Read("/etc/hosts".into())), Decision::Ask("reads outside the project".into()));
    }

    #[test]
    fn commands_ask_unless_always_allowed() {
        let (_d, c) = ctx(None, 0);
        assert_eq!(decide(&c, &Action::Run("npm test".into())), Decision::Allow);
        assert_eq!(decide(&c, &Action::Run("npm test -- --watch".into())), Decision::Ask("run `npm test -- --watch`?".into()));
    }

    #[test]
    fn switched_off_tools_deny() {
        let saved = HarnessSettings { tools: Some(vec!["read_file".into()]), ..Default::default() };
        let (_d, c) = ctx(Some(&saved), 0);
        assert_eq!(decide(&c, &w("a.ts")), Decision::Deny("writing is switched off in Settings".into()));
        assert_eq!(decide(&c, &Action::Run("npm test".into())), Decision::Deny("commands are switched off in Settings".into()));
    }

    #[test]
    fn the_step_limit_stops_writes_and_commands() {
        let (_d, c) = ctx(None, 200);
        let limit = Decision::Deny("step limit reached; start a new pangu session".into());
        assert_eq!(decide(&c, &w("a.ts")), limit);
        assert_eq!(decide(&c, &Action::Run("npm test".into())), limit);
        assert_eq!(decide(&c, &Action::Read("a.ts".into())), Decision::Allow);
    }

    #[test]
    fn unknown_tools_ask() {
        let (_d, c) = ctx(None, 0);
        assert_eq!(decide(&c, &Action::Other("TodoWrite".into())), Decision::Ask("unknown tool".into()));
    }
}
