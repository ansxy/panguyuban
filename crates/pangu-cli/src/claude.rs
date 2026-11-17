//! `pangu claude`: Claude Code with Panguyuban's skills and guard rails, passed per launch.

use std::ffi::OsStr;
use std::hash::{Hash, Hasher};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};

use crate::repl::{ENGINEERING, WORK_ON_PROJECT};
use crate::session::{self, Session};

/// Rewrites `dir` as a Claude Code plugin holding the compiled-in skills.
pub fn write_plugin(dir: &Path) -> std::io::Result<()> {
    if dir.exists() {
        std::fs::remove_dir_all(dir)?;
    }
    std::fs::create_dir_all(dir.join(".claude-plugin"))?;
    let manifest = json!({
        "name": "panguyuban",
        "description": "Panguyuban skills and rules",
        "version": env!("CARGO_PKG_VERSION"),
    });
    std::fs::write(dir.join(".claude-plugin/plugin.json"), manifest.to_string())?;
    for (name, text) in plugin_skills() {
        let d = dir.join("skills").join(name);
        std::fs::create_dir_all(&d)?;
        std::fs::write(d.join("SKILL.md"), text)?;
    }
    Ok(())
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

pub fn hook_settings(pangu: &Path) -> Value {
    let bin = shell_quote(&pangu.to_string_lossy());
    let entry = |verb: &str| {
        json!([{"matcher": ".*", "hooks": [{"type": "command", "command": format!("{bin} {verb} --agent claude"), "timeout": 10}]}])
    };
    json!({"hooks": {"PreToolUse": entry("check"), "PostToolUse": entry("record")}})
}

fn find_on_path(name: &str, path_var: &OsStr) -> Option<PathBuf> {
    std::env::split_paths(path_var)
        .filter(|d| d.is_absolute())
        .map(|d| d.join(name))
        .find(|p| p.metadata().map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false))
}

fn plugin_skills() -> impl Iterator<Item = (&'static str, &'static str)> {
    std::iter::once(("work-on-project", WORK_ON_PROJECT)).chain(ENGINEERING.iter().copied())
}

/// A plugin folder named by its contents, so concurrent launches never rewrite one another's.
pub fn ensure_plugin(data: &Path) -> std::io::Result<PathBuf> {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    env!("CARGO_PKG_VERSION").hash(&mut h);
    for skill in plugin_skills() {
        skill.hash(&mut h);
    }
    let final_dir = data.join(format!("claude-plugin-{:016x}", h.finish()));
    if final_dir.exists() {
        return Ok(final_dir);
    }
    std::fs::create_dir_all(data)?;
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let tmp = data.join(format!(".claude-plugin-tmp-{}-{nanos}", std::process::id()));
    write_plugin(&tmp)?;
    if let Err(e) = std::fs::rename(&tmp, &final_dir) {
        let _ = std::fs::remove_dir_all(&tmp);
        if !final_dir.exists() {
            return Err(e);
        }
    }
    Ok(final_dir)
}

pub fn run(args: &[String]) -> i32 {
    let Some(claude) = std::env::var_os("PATH").and_then(|p| find_on_path("claude", &p)) else {
        eprintln!("Claude Code (claude) is not installed or not on PATH");
        return 1;
    };
    let pangu = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("pangu claude: cannot find this binary: {e}");
            return 1;
        }
    };
    let root = session::find_root(&std::env::current_dir().unwrap_or_default());
    let session = Session::start(root);
    session::append_record(
        &session.record_path(),
        json!({"type": "start", "agent": "claude", "root": session.root.to_string_lossy()}),
    );
    let plugin = match ensure_plugin(&session.data) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("pangu claude: cannot write the plugin: {e}");
            return 1;
        }
    };
    let mut cmd = Command::new(claude);
    cmd.arg("--settings").arg(hook_settings(&pangu).to_string()).arg("--plugin-dir").arg(&plugin).args(args);
    cmd.envs(session.env());
    let err = cmd.exec(); // only returns on failure
    eprintln!("pangu claude: cannot start claude: {err}");
    1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_plugin_has_the_skills() {
        let tmp = tempfile::tempdir().unwrap();
        write_plugin(tmp.path()).unwrap();
        let m: Value =
            serde_json::from_str(&std::fs::read_to_string(tmp.path().join(".claude-plugin/plugin.json")).unwrap()).unwrap();
        assert_eq!(m["name"], "panguyuban");
        let s = std::fs::read_to_string(tmp.path().join("skills/work-on-project/SKILL.md")).unwrap();
        assert!(s.starts_with("---"));
    }

    #[test]
    fn hooks_call_this_binary() {
        let v = hook_settings(Path::new("/Applications/Panguyuban.app/Contents/MacOS/pangu"));
        assert_eq!(
            v["hooks"]["PreToolUse"][0]["hooks"][0]["command"],
            "'/Applications/Panguyuban.app/Contents/MacOS/pangu' check --agent claude"
        );
        assert!(v["hooks"]["PostToolUse"][0]["hooks"][0]["command"].as_str().unwrap().ends_with("' record --agent claude"));
    }

    #[test]
    fn quotes_in_the_path_are_escaped() {
        assert_eq!(shell_quote("/a b/it's"), "'/a b/it'\\''s'");
    }

    #[test]
    fn rewriting_the_plugin_drops_old_skills() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("skills/old")).unwrap();
        std::fs::write(tmp.path().join("skills/old/SKILL.md"), "x").unwrap();
        write_plugin(tmp.path()).unwrap();
        assert!(!tmp.path().join("skills/old").exists());
    }

    #[test]
    fn the_same_plugin_is_reused_and_old_ones_stay() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("claude-plugin-other");
        std::fs::create_dir_all(&old).unwrap();
        let a = ensure_plugin(tmp.path()).unwrap();
        std::fs::write(a.join("marker"), "x").unwrap();
        let b = ensure_plugin(tmp.path()).unwrap();
        assert_eq!(a, b);
        assert!(b.join("marker").exists());
        assert!(old.exists());
        assert!(a.join("skills/work-on-project/SKILL.md").exists());
    }

    fn script(dir: &Path, mode: u32) {
        let f = dir.join("claude");
        std::fs::write(&f, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[test]
    fn path_lookup_ignores_empty_entries_and_non_executables() {
        let (a, b, cwd) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        script(cwd.path(), 0o755);
        script(a.path(), 0o644);
        script(b.path(), 0o755);
        let prev = std::env::current_dir().unwrap();
        std::env::set_current_dir(cwd.path()).unwrap();
        let only_empty = find_on_path("claude", OsStr::new(""));
        let joined = std::env::join_paths([a.path(), b.path()]).unwrap();
        let found = find_on_path("claude", &joined);
        std::env::set_current_dir(prev).unwrap();
        assert_eq!(only_empty, None);
        assert_eq!(found, Some(b.path().join("claude")));
    }
}
