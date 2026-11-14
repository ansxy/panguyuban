//! One "About me" note, written into each coding agent's own instruction file. Everything here is
//! local: the note lives in the app database and is copied into files the agents already read.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

const START: &str = "<!-- panguyuban:memory:start (managed by Panguyuban; edit it in the app) -->";
const START_PREFIX: &str = "<!-- panguyuban:memory:start";
const END: &str = "<!-- panguyuban:memory:end -->";
const HERMES_HEAD: &str = "Panguyuban memory (managed by Panguyuban; edit it in the app):";
const HERMES_SEP: &str = "\n§\n";
const HERMES_DEFAULT_LIMIT: usize = 1375;

#[derive(Serialize, Clone, Debug)]
pub struct TargetStatus {
    pub id: String,
    pub label: String,
    /// Path with the home folder shown as `~`.
    pub path: String,
    /// "in_sync" | "out_of_date" | "not_written" | "not_installed" | "too_long" | "busy" | "error"
    pub state: String,
    pub detail: Option<String>,
    pub length: Option<usize>,
    pub limit: Option<usize>,
    /// Whether the agent's file holds the managed block (so "Remove" makes sense).
    pub written: bool,
}

#[derive(Serialize)]
pub struct AgentCli {
    pub id: String,
    pub available: bool,
}

struct Target {
    id: &'static str,
    label: &'static str,
    /// Folder that must already exist, or the agent is not installed.
    top: &'static str,
    /// File below the home folder.
    file: &'static str,
}

const TARGETS: [Target; 4] = [
    Target { id: "claude", label: "Claude Code", top: ".claude", file: ".claude/CLAUDE.md" },
    Target { id: "codex", label: "Codex", top: ".codex", file: ".codex/AGENTS.md" },
    Target { id: "antigravity", label: "Antigravity", top: ".gemini", file: ".gemini/GEMINI.md" },
    Target { id: "hermes", label: "Hermes", top: ".hermes", file: ".hermes/memories/USER.md" },
];

// ---- pure text functions ----

fn block(text: &str) -> String {
    format!("{START}\n{}\n{END}", text.trim())
}

/// Byte range of the managed block, markers included.
fn block_range(content: &str) -> Option<(usize, usize)> {
    let start = content.find(START_PREFIX)?;
    let end = start + content[start..].find(END)? + END.len();
    Some((start, end))
}

fn md_current(content: &str) -> Option<String> {
    let (start, end) = block_range(content)?;
    let inner = &content[start..end - END.len()];
    let body = inner.split_once('\n').map_or("", |(_, rest)| rest);
    Some(body.trim().to_string())
}

/// Replaces the managed block in place, or appends it after a blank line. Nothing else changes.
fn md_apply(content: &str, text: &str) -> String {
    let b = block(text);
    if let Some((start, end)) = block_range(content) {
        return format!("{}{}{}", &content[..start], b, &content[end..]);
    }
    let rest = content.trim_end_matches('\n');
    if rest.is_empty() {
        format!("{b}\n")
    } else {
        format!("{rest}\n\n{b}\n")
    }
}

/// Deletes the block and the blank line before it.
fn md_remove(content: &str) -> String {
    let Some((start, end)) = block_range(content) else {
        return content.to_string();
    };
    let before = &content[..start];
    let before = before.strip_suffix("\n\n").map_or(before, |b| &content[..b.len() + 1]);
    let after = content[end..].strip_prefix('\n').unwrap_or(&content[end..]);
    format!("{before}{after}")
}

fn hermes_entries(content: &str) -> Vec<&str> {
    if content.trim().is_empty() {
        return Vec::new();
    }
    content.split(HERMES_SEP).collect()
}

fn is_ours(entry: &str) -> bool {
    entry.starts_with(HERMES_HEAD)
}

fn hermes_entry(text: &str) -> String {
    format!("{HERMES_HEAD}\n{}", text.trim())
}

fn hermes_current(content: &str) -> Option<String> {
    let entry = hermes_entries(content).into_iter().find(|e| is_ours(e))?;
    Some(entry[HERMES_HEAD.len()..].trim().to_string())
}

fn hermes_apply(content: &str, text: &str) -> String {
    let new = hermes_entry(text);
    let mut entries = hermes_entries(content);
    match entries.iter().position(|e| is_ours(e)) {
        Some(i) => entries[i] = &new,
        None => entries.push(&new),
    }
    entries.join(HERMES_SEP)
}

fn hermes_remove(content: &str) -> String {
    let mut entries = hermes_entries(content);
    entries.retain(|e| !is_ours(e));
    entries.join(HERMES_SEP)
}

/// `Some((length, limit))` when `content` is longer than `limit` characters.
fn over_limit(content: &str, limit: usize) -> Option<(usize, usize)> {
    let length = content.chars().count();
    (length > limit).then_some((length, limit))
}

/// `user_char_limit` under `memory:` in Hermes' config.yaml; a line scan, not a YAML parser.
fn parse_user_limit(config: &str) -> usize {
    let mut in_memory = false;
    for line in config.lines() {
        if !line.starts_with(char::is_whitespace) && !line.trim().is_empty() {
            in_memory = line.trim_end() == "memory:";
            continue;
        }
        if in_memory {
            if let Some(v) = line.trim().strip_prefix("user_char_limit:") {
                let v = v.split('#').next().unwrap_or("").trim();
                if let Ok(n) = v.parse() {
                    return n;
                }
            }
        }
    }
    HERMES_DEFAULT_LIMIT
}

// ---- files ----

fn home() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "no home folder".to_string())
}

fn target(id: &str) -> Result<&'static Target, String> {
    TARGETS.iter().find(|t| t.id == id).ok_or_else(|| format!("unknown agent: {id}"))
}

fn tilde(home: &Path, path: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => path.display().to_string(),
    }
}

fn read(path: &Path) -> Result<String, String> {
    match fs::read_to_string(path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("could not read {}: {e}", path.display())),
    }
}

/// Backs up the original once, then swaps in the new content through a temp file in the same
/// folder (same permissions as the original), so a crash never leaves half a file.
fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    let path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()); // write through a symlink
    let name = path.file_name().and_then(|n| n.to_str()).ok_or("bad file name")?;
    let err = |e: std::io::Error| format!("could not write {}: {e}", path.display());
    let existing = fs::metadata(&path).ok();
    if existing.is_some() {
        let backup = path.with_file_name(format!("{name}.panguyuban-backup"));
        if !backup.exists() {
            fs::copy(&path, &backup).map_err(err)?;
        }
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(err)?;
    }
    let tmp = path.with_file_name(format!(".{name}.panguyuban-tmp"));
    fs::write(&tmp, content).map_err(err)?;
    if let Some(meta) = existing {
        fs::set_permissions(&tmp, meta.permissions()).map_err(err)?;
    }
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        err(e)
    })
}

/// Exclusive, non-blocking lock on `USER.md.lock` for as long as the returned file lives.
enum Lock {
    Held(fs::File),
    Busy,
}

fn lock(path: &Path) -> Result<Lock, String> {
    let file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(path)
        .map_err(|e| format!("could not open {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            let e = std::io::Error::last_os_error();
            return if e.kind() == std::io::ErrorKind::WouldBlock { Ok(Lock::Busy) } else { Err(e.to_string()) };
        }
    }
    Ok(Lock::Held(file))
}

fn hermes_limit(home: &Path) -> usize {
    fs::read_to_string(home.join(".hermes/config.yaml")).map_or(HERMES_DEFAULT_LIMIT, |c| parse_user_limit(&c))
}

fn status_of(home: &Path, t: &Target, state: &str) -> TargetStatus {
    TargetStatus {
        id: t.id.into(),
        label: t.label.into(),
        path: tilde(home, &home.join(t.file)),
        state: state.into(),
        detail: None,
        length: None,
        limit: None,
        written: false,
    }
}

/// What `text` would do to the target's current file: the new file content, or the status to report.
fn plan(home: &Path, t: &Target, text: &str) -> Result<Result<String, TargetStatus>, String> {
    let path = home.join(t.file);
    let content = read(&path)?;
    let hermes = t.id == "hermes";
    let current = if hermes { hermes_current(&content) } else { md_current(&content) };
    let mut s = status_of(home, t, "");
    s.written = current.is_some();
    if current.as_deref() == Some(text.trim()) {
        s.state = "in_sync".into();
        return Ok(Err(s));
    }
    let next = if hermes { hermes_apply(&content, text) } else { md_apply(&content, text) };
    if hermes {
        let limit = hermes_limit(home);
        if let Some((length, limit)) = over_limit(&next, limit) {
            s.state = "too_long".into();
            s.length = Some(length);
            s.limit = Some(limit);
            return Ok(Err(s));
        }
    }
    s.state = if s.written { "out_of_date" } else { "not_written" }.into();
    Ok(Ok(next))
}

fn status_one(home: &Path, t: &Target, text: &str) -> TargetStatus {
    if !home.join(t.top).is_dir() {
        return status_of(home, t, "not_installed");
    }
    match plan(home, t, text) {
        Ok(Ok(_)) => {
            let hermes = t.id == "hermes";
            let content = read(&home.join(t.file)).unwrap_or_default();
            let present = if hermes { hermes_current(&content).is_some() } else { md_current(&content).is_some() };
            let mut s = status_of(home, t, if present { "out_of_date" } else { "not_written" });
            s.written = present;
            s
        }
        Ok(Err(s)) => s,
        Err(e) => error(home, t, e),
    }
}

fn error(home: &Path, t: &Target, detail: String) -> TargetStatus {
    let mut s = status_of(home, t, "error");
    s.detail = Some(detail);
    s
}

fn sync_one(home: &Path, t: &Target, text: &str) -> TargetStatus {
    if text.trim().is_empty() {
        return error(home, t, "Write something first.".into());
    }
    if !home.join(t.top).is_dir() {
        return status_of(home, t, "not_installed");
    }
    let run = || -> Result<TargetStatus, String> {
        let _lock; // held until the write is done
        if t.id == "hermes" {
            match lock(&home.join(".hermes/memories/USER.md.lock"))? {
                Lock::Held(f) => _lock = f,
                Lock::Busy => return Ok(status_of(home, t, "busy")),
            }
        }
        match plan(home, t, text)? {
            Err(s) => Ok(s),
            Ok(next) => {
                write_atomic(&home.join(t.file), &next)?;
                let mut s = status_of(home, t, "in_sync");
                s.written = true;
                Ok(s)
            }
        }
    };
    run().unwrap_or_else(|e| error(home, t, e))
}

fn remove_one(home: &Path, t: &Target) -> TargetStatus {
    if !home.join(t.top).is_dir() {
        return status_of(home, t, "not_installed");
    }
    let run = || -> Result<TargetStatus, String> {
        let _lock;
        if t.id == "hermes" {
            match lock(&home.join(".hermes/memories/USER.md.lock"))? {
                Lock::Held(f) => _lock = f,
                Lock::Busy => return Ok(status_of(home, t, "busy")),
            }
        }
        let path = home.join(t.file);
        let content = read(&path)?;
        let next = if t.id == "hermes" { hermes_remove(&content) } else { md_remove(&content) };
        if next != content {
            write_atomic(&path, &next)?;
        }
        Ok(status_of(home, t, "not_written"))
    };
    run().unwrap_or_else(|e| error(home, t, e))
}

fn on_path(program: &str) -> bool {
    // A login shell, so a Finder-launched app sees the same PATH as a terminal.
    let shell = if cfg!(target_os = "macos") { "/bin/zsh" } else { "sh" };
    std::process::Command::new(shell)
        .args(["-lc", "command -v \"$0\"", program])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

// ---- commands ----

pub fn status(text: &str) -> Result<Vec<TargetStatus>, String> {
    let home = home()?;
    Ok(TARGETS.iter().map(|t| status_one(&home, t, text)).collect())
}

pub fn sync(text: &str, targets: &[String]) -> Result<Vec<TargetStatus>, String> {
    let home = home()?;
    for id in targets {
        target(id)?;
    }
    Ok(TARGETS
        .iter()
        .map(|t| if targets.iter().any(|id| id == t.id) { sync_one(&home, t, text) } else { status_one(&home, t, text) })
        .collect())
}

pub fn remove(id: &str) -> Result<TargetStatus, String> {
    Ok(remove_one(&home()?, target(id)?))
}

pub fn agent_clis() -> Vec<AgentCli> {
    ["claude", "codex", "agy", "hermes"]
        .into_iter()
        .map(|id| AgentCli { id: id.into(), available: on_path(id) })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn block_into_empty_and_existing() {
        assert_eq!(md_apply("", "hi"), format!("{START}\nhi\n{END}\n"));
        assert_eq!(md_apply("# Mine\n", "hi"), format!("# Mine\n\n{START}\nhi\n{END}\n"));
    }

    #[test]
    fn block_replace_leaves_the_rest() {
        let c = md_apply("# Mine\n", "one");
        let c = format!("{c}\n## After\n");
        let next = md_apply(&c, "two");
        assert!(next.starts_with("# Mine\n\n") && next.ends_with("\n## After\n"));
        assert_eq!(md_current(&next).as_deref(), Some("two"));
        assert_eq!(next.matches(START_PREFIX).count(), 1);
    }

    #[test]
    fn block_remove_restores_the_file() {
        assert_eq!(md_remove(&md_apply("# Mine\n", "hi")), "# Mine\n");
        assert_eq!(md_remove(&md_apply("", "hi")), "");
        assert_eq!(md_remove("untouched\n"), "untouched\n");
    }

    #[test]
    fn hermes_insert_replace_remove() {
        let base = "likes tea\n§\nuses vim";
        let added = hermes_apply(base, "me");
        assert_eq!(added, format!("{base}\n§\n{HERMES_HEAD}\nme"));
        let replaced = hermes_apply(&added, "you");
        assert_eq!(replaced, format!("{base}\n§\n{HERMES_HEAD}\nyou"));
        assert_eq!(hermes_current(&replaced).as_deref(), Some("you"));
        assert_eq!(hermes_remove(&replaced), base);
        assert_eq!(hermes_apply("", "me"), format!("{HERMES_HEAD}\nme"));
        assert_eq!(hermes_remove(&hermes_apply("", "me")), "");
    }

    #[test]
    fn limit_counts_characters_not_bytes() {
        assert_eq!(over_limit("§§§", 3), None);
        assert_eq!(over_limit("§§§§", 3), Some((4, 3)));
    }

    #[test]
    fn limit_from_config() {
        let c = "model: x\nmemory:\n  memory_char_limit: 2200\n  user_char_limit: 1500 # chars\nother:\n  user_char_limit: 9\n";
        assert_eq!(parse_user_limit(c), 1500);
        assert_eq!(parse_user_limit("other:\n  user_char_limit: 9\n"), HERMES_DEFAULT_LIMIT);
        assert_eq!(parse_user_limit(""), HERMES_DEFAULT_LIMIT);
    }

    #[test]
    fn writes_in_a_temp_home() {
        let home = std::env::temp_dir().join(format!("panguyuban-memory-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::write(home.join(".claude/CLAUDE.md"), "# Mine\n").unwrap();
        let t = target("claude").unwrap();
        assert_eq!(sync_one(&home, t, "hi").state, "in_sync");
        assert_eq!(status_one(&home, t, "hi").state, "in_sync");
        assert_eq!(status_one(&home, t, "other").state, "out_of_date");
        assert_eq!(fs::read_to_string(home.join(".claude/CLAUDE.md.panguyuban-backup")).unwrap(), "# Mine\n");
        assert_eq!(remove_one(&home, t).state, "not_written");
        assert_eq!(fs::read_to_string(home.join(".claude/CLAUDE.md")).unwrap(), "# Mine\n");
        assert_eq!(status_one(&home, target("codex").unwrap(), "hi").state, "not_installed");
        let _ = fs::remove_dir_all(&home);
    }
}
