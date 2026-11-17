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

/// The path inside `root`, as a canonical relative path with forward slashes.
/// Relative input is taken from `root`; `..` and symlinks are resolved on the way, so the
/// result is where a write would really land. `None` when it lands outside `root` or is `root`.
pub fn relative_to(root: &Path, path: &str) -> Option<String> {
    use std::path::Component;
    let root = root.canonicalize().ok()?;
    let p = Path::new(path);
    let mut cur = if p.is_absolute() { std::path::PathBuf::new() } else { root.clone() };
    for c in p.components() {
        match c {
            Component::Prefix(_) => return None,
            Component::RootDir => cur.push("/"),
            Component::CurDir => {}
            Component::ParentDir => {
                cur.pop();
            }
            Component::Normal(n) => {
                cur.push(n);
                // Once a part does not exist nothing below it can be a link. A dangling link fails here.
                if std::fs::symlink_metadata(&cur).is_ok() {
                    cur = cur.canonicalize().ok()?;
                }
            }
        }
    }
    let rel = cur.strip_prefix(&root).ok()?.to_string_lossy().replace('\\', "/");
    (!rel.is_empty()).then_some(rel)
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

    #[test]
    fn dot_dot_cannot_hide_git_or_leave_the_folder() {
        let (_d, c) = ctx(None, 0);
        let root = c.workspace.root().display().to_string();
        std::fs::create_dir(c.workspace.root().join("src")).unwrap();
        assert_eq!(decide(&c, &w("src/../.git/config")), Decision::Deny("the .git folder is off limits".into()));
        assert_eq!(decide(&c, &w(&format!("{root}/src/../.git/config"))), Decision::Deny("the .git folder is off limits".into()));
        let outside = Decision::Deny("writes outside the project are not allowed".into());
        assert_eq!(decide(&c, &w("../x")), outside);
        assert_eq!(decide(&c, &w(&format!("{root}/../x"))), outside);
        let ask = Decision::Ask("reads outside the project".into());
        assert_eq!(decide(&c, &Action::Read("../../etc/passwd".into())), ask);
        assert_eq!(decide(&c, &Action::Read(format!("{root}/../x"))), ask);
    }

    #[test]
    fn a_non_canonical_absolute_path_inside_the_root_is_allowed() {
        let dir = tempfile::tempdir().unwrap(); // on macOS under /var, a link to /private/var
        let workspace = Workspace::new(dir.path(), &["*".to_string()]).unwrap();
        let effective = effective(&session_type("work-on-project").unwrap(), None);
        let c = PolicyContext { workspace, effective, always_allowed: vec![], steps_so_far: 0 };
        let abs = format!("{}/src/a.ts", dir.path().display());
        assert_eq!(decide(&c, &w(&abs)), Decision::Allow);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_folders_are_followed() {
        let (_d, c) = ctx(None, 0);
        let root = c.workspace.root().to_path_buf();
        std::fs::create_dir(root.join(".git")).unwrap();
        std::os::unix::fs::symlink(root.join(".git"), root.join("g")).unwrap();
        assert_eq!(decide(&c, &w("g/config")), Decision::Deny("the .git folder is off limits".into()));
        assert!(c.workspace.write("g/config", "x").unwrap_err().contains("off limits"));
        assert!(!root.join(".git/config").exists());
        let other = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(other.path(), root.join("link")).unwrap();
        assert_eq!(decide(&c, &w("link/x")), Decision::Deny("writes outside the project are not allowed".into()));
        assert_eq!(decide(&c, &w(&format!("{}/link/x", root.display()))), Decision::Deny("writes outside the project are not allowed".into()));
    }
}
