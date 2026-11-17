//! `pangu claude`: Claude Code with Panguyuban's skills and guard rails, passed per launch.

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
    let skills = std::iter::once(("work-on-project", WORK_ON_PROJECT)).chain(ENGINEERING.iter().copied());
    for (name, text) in skills {
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

fn on_path(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?).map(|d| d.join(name)).find(|p| p.is_file())
}

pub fn run(args: &[String]) -> i32 {
    let Some(claude) = on_path("claude") else {
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
    let plugin = session.data.join("claude-plugin");
    if let Err(e) = write_plugin(&plugin) {
        eprintln!("pangu claude: cannot write the plugin: {e}");
        return 1;
    }
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
}
