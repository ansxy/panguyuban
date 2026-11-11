//! Live tracker for local coding agents, ported from top-bar (Agents.swift,
//! Antigravity.swift, AgentUsage.swift).
//!
//! ponytail: every source here is an undocumented on-disk format (Claude Code's
//! session/transcript files, Antigravity's presence locks). If they change, the
//! Agents section just goes empty; nothing else depends on it.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Local, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Subagents silent this long are treated as finished (crashed or orphaned).
const SUBAGENT_STALE: Duration = Duration::from_secs(30 * 60);
/// Finished subagents stay listed this long.
const SUBAGENT_LINGER: Duration = Duration::from_secs(5 * 60);
/// A "busy" Antigravity session with no step this long is shown idle.
const AGY_STALE_MS: f64 = 10.0 * 60.0 * 1000.0;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SubAgent {
    pub id: String,
    pub description: String,
    pub agent_type: String,
    pub started_ms: f64,
    pub last_active_ms: f64,
    pub finished: bool,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentSession {
    /// "claude" or "antigravity"
    pub harness: &'static str,
    pub session_id: String,
    pub pid: i32,
    pub cwd: String,
    pub name: String,
    /// "busy", "waiting" or "idle"
    pub status: String,
    pub started_ms: f64,
    pub status_since_ms: f64,
    pub model: Option<String>,
    /// Main transcript plus every subagent's.
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub subagents: Vec<SubAgent>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct TokenWindow {
    pub input: u64,
    pub output: u64,
    pub cache_write: u64,
    pub cache_read: u64,
    /// input + cache_write + cache_read/10 + output, top-bar's limit metric.
    pub effective: u64,
    /// Oldest entry in the window, used to estimate when it resets.
    pub oldest_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageReport {
    pub harness: &'static str,
    pub five_hour: TokenWindow,
    pub today: TokenWindow,
    pub week: TokenWindow,
}

/// Per-transcript incremental parse state for live sessions.
#[derive(Default)]
struct Parsed {
    offset: u64,
    /// request id (or step index) -> (input, output); the last line for a key wins.
    usage: HashMap<String, (u64, u64)>,
    /// Claude: subagent ids / tool_use ids whose result has come back.
    finished: HashSet<String>,
    model: Option<String>,
    /// Antigravity: status from the latest step, and that step's time.
    status: Option<String>,
    last_step_ms: Option<f64>,
}

impl Parsed {
    fn totals(&self) -> (u64, u64) {
        self.usage
            .values()
            .fold((0, 0), |(i, o), (di, d_o)| (i + di, o + d_o))
    }
}

/// One usage line for the 5h/today/week windows.
#[derive(Debug, Clone, PartialEq)]
struct UsageEntry {
    key: String,
    ts_ms: f64,
    input: u64,
    output: u64,
    cache_write: u64,
    cache_read: u64,
}

#[derive(Default)]
pub struct AgentTracker {
    live: Mutex<HashMap<PathBuf, Parsed>>,
    /// Antigravity lock path -> (owner pid, cwd), found once via lsof.
    agy_owner: Mutex<HashMap<PathBuf, (i32, String)>>,
    /// Usage file -> (mtime, size, entries); re-parsed only when the file changes.
    usage_files: Mutex<HashMap<PathBuf, (SystemTime, u64, Vec<UsageEntry>)>>,
}

impl AgentTracker {
    pub fn sessions(&self) -> Vec<AgentSession> {
        let Some(home) = dirs::home_dir() else {
            return Vec::new();
        };
        let mut live = self.live.lock().unwrap_or_else(|e| e.into_inner());
        let mut touched = HashSet::new();
        let mut out = claude_sessions(&home, &mut live, &mut touched);
        out.extend(self.antigravity_sessions(&home, &mut live, &mut touched));
        live.retain(|path, _| touched.contains(path));
        out.sort_by(|a, b| b.started_ms.total_cmp(&a.started_ms));
        out
    }

    pub fn usage(&self) -> Vec<UsageReport> {
        let Some(home) = dirs::home_dir() else {
            return Vec::new();
        };
        let now = SystemTime::now();
        let week_ago = now - Duration::from_secs(7 * 24 * 3600);
        let mut cache = self.usage_files.lock().unwrap_or_else(|e| e.into_inner());
        let mut seen_files = HashSet::new();

        let mut report = |harness: &'static str, files: Vec<PathBuf>, parse: fn(&str, &str) -> Option<UsageEntry>| {
            let mut entries = Vec::new();
            for path in files {
                let Ok(meta) = fs::metadata(&path) else { continue };
                let Ok(mtime) = meta.modified() else { continue };
                if mtime < week_ago {
                    continue;
                }
                seen_files.insert(path.clone());
                let fresh = matches!(cache.get(&path), Some((m, s, _)) if *m == mtime && *s == meta.len());
                if !fresh {
                    let conv = path_conversation_id(&path);
                    let parsed = fs::read_to_string(&path)
                        .map(|text| text.lines().filter_map(|l| parse(l, &conv)).collect())
                        .unwrap_or_default();
                    cache.insert(path.clone(), (mtime, meta.len(), parsed));
                }
                entries.extend(cache[&path].2.iter().cloned());
            }
            UsageReport {
                harness,
                ..windows(entries, now_ms(), local_midnight_ms())
            }
        };

        let claude = report("claude", claude_usage_files(&home), parse_claude_usage_line);
        let agy = report("antigravity", agy_usage_files(&home), parse_agy_usage_line);
        cache.retain(|path, _| seen_files.contains(path));
        vec![claude, agy]
    }

    fn antigravity_sessions(
        &self,
        home: &Path,
        live: &mut HashMap<PathBuf, Parsed>,
        touched: &mut HashSet<PathBuf>,
    ) -> Vec<AgentSession> {
        let mut owners = self.agy_owner.lock().unwrap_or_else(|e| e.into_inner());
        let mut out = Vec::new();
        for root in agy_roots(home) {
            let Ok(locks) = fs::read_dir(root.join("presence")) else { continue };
            for lock in locks.flatten().map(|e| e.path()) {
                if lock.extension().and_then(|e| e.to_str()) != Some("lock") || !lock_is_held(&lock) {
                    continue;
                }
                let Some(id) = lock.file_stem().and_then(|s| s.to_str()).map(str::to_string) else {
                    continue;
                };
                let cached = owners.get(&lock).filter(|(pid, _)| pid_alive(*pid)).cloned();
                let Some((pid, cwd)) = cached.or_else(|| lock_owner(&lock, home)) else {
                    continue;
                };
                owners.insert(lock.clone(), (pid, cwd.clone()));

                let transcript = root
                    .join("brain")
                    .join(&id)
                    .join(".system_generated/logs/transcript.jsonl");
                touched.insert(transcript.clone());
                let parsed = live.entry(transcript.clone()).or_default();
                catch_up(&transcript, parsed, apply_agy_line);

                let started_ms = file_created_ms(&lock).unwrap_or_else(now_ms);
                let mut status = parsed.status.clone().unwrap_or_else(|| "idle".into());
                let since = parsed.last_step_ms.unwrap_or(started_ms);
                if status == "busy" && now_ms() - since > AGY_STALE_MS {
                    status = "idle".into();
                }
                let (input_tokens, output_tokens) = parsed.totals();
                out.push(AgentSession {
                    harness: "antigravity",
                    session_id: id,
                    pid,
                    name: folder_name(&cwd),
                    cwd,
                    status,
                    started_ms,
                    status_since_ms: since,
                    model: parsed.model.clone(),
                    input_tokens,
                    output_tokens,
                    subagents: Vec::new(),
                });
            }
        }
        owners.retain(|lock, (pid, _)| lock.exists() && pid_alive(*pid));
        out
    }
}

// ---------- Claude Code ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeSessionFile {
    pid: i32,
    session_id: String,
    cwd: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    status: Option<String>,
    started_at: f64,
    #[serde(default)]
    status_updated_at: Option<f64>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SubAgentMeta {
    #[serde(default)]
    agent_type: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    tool_use_id: Option<String>,
    #[serde(default)]
    stopped_by_user: bool,
}

/// Claude Code's project folder name: every non-alphanumeric char becomes '-'.
pub fn project_slug(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn claude_sessions(
    home: &Path,
    live: &mut HashMap<PathBuf, Parsed>,
    touched: &mut HashSet<PathBuf>,
) -> Vec<AgentSession> {
    let claude = home.join(".claude");
    let Ok(dir) = fs::read_dir(claude.join("sessions")) else {
        return Vec::new();
    };
    // One row per session id, even if a session file is duplicated.
    let mut by_id: HashMap<String, AgentSession> = HashMap::new();
    for path in dir.flatten().map(|e| e.path()) {
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue; // the folder also holds <pid>.<hash>.key files
        }
        let Some(s) = fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str::<ClaudeSessionFile>(&t).ok())
        else {
            continue;
        };
        if !pid_alive(s.pid) {
            continue;
        }
        let project = claude.join("projects").join(project_slug(&s.cwd));

        let transcript = project.join(format!("{}.jsonl", s.session_id));
        touched.insert(transcript.clone());
        let main = live.entry(transcript.clone()).or_default();
        catch_up(&transcript, main, apply_claude_line);
        let (mut input_tokens, mut output_tokens) = main.totals();
        let model = main.model.clone();
        let finished_ids = main.finished.clone();

        let mut subagents = Vec::new();
        if let Ok(subs) = fs::read_dir(project.join(&s.session_id).join("subagents")) {
            for sub in subs.flatten().map(|e| e.path()) {
                if sub.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                let Some(id) = sub
                    .file_stem()
                    .and_then(|n| n.to_str())
                    .map(|n| n.trim_start_matches("agent-").to_string())
                else {
                    continue;
                };
                touched.insert(sub.clone());
                let parsed = live.entry(sub.clone()).or_default();
                catch_up(&sub, parsed, apply_claude_line);
                let (i, o) = parsed.totals();
                input_tokens += i;
                output_tokens += o;

                let meta: SubAgentMeta = fs::read_to_string(sub.with_file_name(format!("agent-{id}.meta.json")))
                    .ok()
                    .and_then(|t| serde_json::from_str(&t).ok())
                    .unwrap_or_default();
                let last_active = fs::metadata(&sub).and_then(|m| m.modified()).ok();
                let silent = last_active
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|d| d > SUBAGENT_STALE);
                let finished = finished_ids.contains(&id)
                    || meta.tool_use_id.as_ref().is_some_and(|t| finished_ids.contains(t))
                    || meta.stopped_by_user
                    || silent;
                let lingering = last_active
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|d| d > SUBAGENT_LINGER);
                if finished && lingering {
                    continue; // done for a while: hidden, but its tokens still count
                }
                subagents.push(SubAgent {
                    description: meta.description.unwrap_or_else(|| id.clone()),
                    agent_type: meta.agent_type.unwrap_or_else(|| "agent".into()),
                    started_ms: file_created_ms(&sub).unwrap_or(0.0),
                    last_active_ms: last_active.map(system_ms).unwrap_or(0.0),
                    finished,
                    input_tokens: i,
                    output_tokens: o,
                    id,
                });
            }
        }
        subagents.sort_by(|a, b| a.started_ms.total_cmp(&b.started_ms));

        let session = AgentSession {
            harness: "claude",
            name: s.name.clone().unwrap_or_else(|| folder_name(&s.cwd)),
            status: s.status.clone().unwrap_or_else(|| "idle".into()),
            status_since_ms: s.status_updated_at.unwrap_or(s.started_at),
            started_ms: s.started_at,
            pid: s.pid,
            cwd: s.cwd,
            model,
            input_tokens,
            output_tokens,
            subagents,
            session_id: s.session_id.clone(),
        };
        match by_id.get(&s.session_id) {
            Some(existing) if existing.started_ms >= session.started_ms => {}
            _ => {
                by_id.insert(s.session_id, session);
            }
        }
    }
    by_id.into_values().collect()
}

/// Folds one Claude transcript line into the live state.
fn apply_claude_line(p: &mut Parsed, line: &str) {
    // `<task-id>X</task-id>` notifications mark async subagent X as done.
    for part in line.split("<task-id>").skip(1) {
        if let Some(id) = part.split('<').next().filter(|id| !id.is_empty()) {
            p.finished.insert(id.to_string());
        }
    }
    let Ok(obj) = serde_json::from_str::<Value>(line) else { return };
    let message = &obj["message"];
    if let Some(model) = message["model"].as_str().filter(|m| !m.starts_with('<')) {
        p.model = Some(model.to_string());
    }
    if let Some(items) = message["content"].as_array() {
        for item in items {
            if item["type"] != "tool_result" {
                continue;
            }
            let launched_only = item["content"].to_string().contains("Async agent launched");
            if let (Some(id), false) = (item["tool_use_id"].as_str(), launched_only) {
                p.finished.insert(id.to_string());
            }
        }
    }
    let usage = &message["usage"];
    if usage.is_object() {
        // Each content block repeats the usage line, so key by request.
        let key = obj["requestId"]
            .as_str()
            .or(message["id"].as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("line-{}", p.usage.len()));
        let n = |k: &str| usage[k].as_u64().unwrap_or(0);
        let input = n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens") / 10;
        p.usage.insert(key, (input, n("output_tokens")));
    }
}

fn parse_claude_usage_line(line: &str, _conv: &str) -> Option<UsageEntry> {
    if line.len() <= 20 {
        return None;
    }
    let obj: Value = serde_json::from_str(line).ok()?;
    let message = &obj["message"];
    let usage = message["usage"].as_object()?;
    let ts = obj["timestamp"].as_str().or(obj["created_at"].as_str()).and_then(parse_iso_ms)?;
    let key = obj["requestId"].as_str().or(message["id"].as_str())?.to_string();
    let n = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
    Some(UsageEntry {
        key,
        ts_ms: ts,
        input: n("input_tokens"),
        output: n("output_tokens"),
        cache_write: n("cache_creation_input_tokens"),
        cache_read: n("cache_read_input_tokens"),
    })
}

fn claude_usage_files(home: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let Ok(projects) = fs::read_dir(home.join(".claude/projects")) else {
        return files;
    };
    for project in projects.flatten().map(|e| e.path()) {
        let Ok(entries) = fs::read_dir(&project) else { continue };
        for entry in entries.flatten().map(|e| e.path()) {
            if entry.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                files.push(entry);
            } else if let Ok(subs) = fs::read_dir(entry.join("subagents")) {
                files.extend(
                    subs.flatten()
                        .map(|e| e.path())
                        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("jsonl")),
                );
            }
        }
    }
    files
}

// ---------- Antigravity ----------

fn agy_roots(home: &Path) -> Vec<PathBuf> {
    ["antigravity-cli", "antigravity"]
        .iter()
        .map(|d| home.join(".gemini").join(d))
        .filter(|p| p.is_dir())
        .collect()
}

/// Folds one Antigravity transcript step into the live state; the latest step decides status.
fn apply_agy_line(p: &mut Parsed, line: &str) {
    let Ok(obj) = serde_json::from_str::<Value>(line) else { return };
    let status = obj["status"].as_str().unwrap_or("").to_ascii_uppercase();
    let kind = obj["type"].as_str().unwrap_or("");
    p.status = Some(
        if status.contains("WAIT") {
            "waiting"
        } else if status.contains("ERROR") || status.contains("CANCEL") {
            "idle"
        } else if kind == "PLANNER_RESPONSE" {
            let calls = obj["tool_calls"].as_array().is_some_and(|c| !c.is_empty());
            if calls { "busy" } else { "idle" }
        } else {
            "busy" // user input or a tool result: the agent is about to act
        }
        .to_string(),
    );
    if let Some(ts) = obj["created_at"].as_str().and_then(parse_iso_ms) {
        p.last_step_ms = Some(ts);
    }
    if let Some(model) = obj["model"].as_str() {
        p.model = Some(model.to_string());
    }
    if kind == "PLANNER_RESPONSE" {
        let n = |k: &str| obj[k].as_u64().unwrap_or(0);
        let key = obj["step_index"]
            .as_u64()
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("line-{}", p.usage.len()));
        let input = n("input_tokens") + n("cache_creation_tokens") + n("cache_write_tokens") + n("cache_read_tokens") / 10;
        p.usage.insert(key, (input, n("output_tokens")));
    }
}

fn parse_agy_usage_line(line: &str, conv: &str) -> Option<UsageEntry> {
    let obj: Value = serde_json::from_str(line).ok()?;
    if obj["type"] != "PLANNER_RESPONSE" {
        return None;
    }
    let ts = obj["created_at"].as_str().and_then(parse_iso_ms)?;
    let n = |k: &str| obj[k].as_u64().unwrap_or(0);
    Some(UsageEntry {
        key: format!("{conv}:{}", obj["step_index"].as_u64()?),
        ts_ms: ts,
        input: n("input_tokens"),
        output: n("output_tokens"),
        cache_write: n("cache_creation_tokens") + n("cache_write_tokens"),
        cache_read: n("cache_read_tokens"),
    })
}

fn agy_usage_files(home: &Path) -> Vec<PathBuf> {
    agy_roots(home)
        .into_iter()
        .filter_map(|root| fs::read_dir(root.join("brain")).ok())
        .flat_map(|dirs| dirs.flatten().map(|e| e.path().join(".system_generated/logs/transcript.jsonl")))
        .filter(|p| p.is_file())
        .collect()
}

/// Antigravity transcripts live at brain/<conversation id>/...; Claude doesn't need one.
fn path_conversation_id(path: &Path) -> String {
    path.ancestors()
        .find(|a| a.parent().and_then(|p| p.file_name()) == Some("brain".as_ref()))
        .and_then(|a| a.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string()
}

/// A presence lock is live while its owner holds an exclusive flock on it.
#[cfg(unix)]
fn lock_is_held(path: &Path) -> bool {
    use std::os::unix::io::AsRawFd;
    let Ok(file) = fs::File::open(path) else { return false };
    let fd = file.as_raw_fd();
    // SAFETY: fd is valid for the lifetime of `file`.
    let got_shared = unsafe { libc::flock(fd, libc::LOCK_SH | libc::LOCK_NB) } == 0;
    if got_shared {
        unsafe { libc::flock(fd, libc::LOCK_UN) };
    }
    !got_shared
}

#[cfg(not(unix))]
fn lock_is_held(_path: &Path) -> bool {
    false // ponytail: Windows needs LockFileEx; Antigravity tracking is macOS/Linux only for now
}

/// The pid holding a lock file and that process's cwd, via lsof.
fn lock_owner(lock: &Path, home: &Path) -> Option<(i32, String)> {
    let out = std::process::Command::new("lsof").arg("-t").arg(lock).output().ok()?;
    let pid: i32 = String::from_utf8_lossy(&out.stdout).lines().next()?.trim().parse().ok()?;
    let cwd = std::process::Command::new("lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output()
        .ok()
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .find_map(|l| l.strip_prefix('n').map(str::to_string))
        })
        .unwrap_or_else(|| home.display().to_string());
    Some((pid, cwd))
}

// ---------- actions ----------

/// Brings the session's terminal to the front: the matching iTerm2 tab when
/// iTerm is running (matched by tty), otherwise the folder in VS Code / Finder.
pub fn reveal(pid: i32, cwd: &str) -> Result<(), String> {
    use std::process::Command;
    let tty = Command::new("ps")
        .args(["-o", "tty=", "-p", &pid.to_string()])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    // tty goes into AppleScript source, so only allow plain device names.
    let tty_ok = !tty.is_empty() && tty != "??" && tty.chars().all(|c| c.is_ascii_alphanumeric());
    let iterm_running = Command::new("pgrep")
        .args(["-x", "iTerm2"])
        .output()
        .is_ok_and(|o| o.status.success());
    if tty_ok && iterm_running {
        let script = format!(
            r#"tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is "/dev/{tty}" then
          select w
          select t
          select s
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
end tell
return "missing""#
        );
        let found = Command::new("osascript")
            .args(["-e", &script])
            .output()
            .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).trim() == "ok");
        if found {
            return Ok(());
        }
    }
    open_folder(cwd, true)
}

/// Opens a session folder, in VS Code when asked and installed, else in Finder.
pub fn open_folder(cwd: &str, prefer_editor: bool) -> Result<(), String> {
    use std::process::Command;
    if !Path::new(cwd).is_dir() {
        return Err(format!("{cwd} is not a folder"));
    }
    if prefer_editor
        && Command::new("open")
            .args(["-a", "Visual Studio Code", cwd])
            .status()
            .is_ok_and(|s| s.success())
    {
        return Ok(());
    }
    Command::new("open")
        .arg(cwd)
        .status()
        .map_err(|e| e.to_string())
        .and_then(|s| if s.success() { Ok(()) } else { Err(format!("could not open {cwd}")) })
}

// ---------- shared helpers ----------

/// Applies every complete line appended to `path` since the last call.
fn catch_up(path: &Path, parsed: &mut Parsed, apply: fn(&mut Parsed, &str)) {
    let mut offset = parsed.offset;
    read_new_lines(path, &mut offset, |line| apply(parsed, line));
    parsed.offset = offset;
}

/// Reads complete lines appended since `offset`; a half-written last line waits for the next poll.
fn read_new_lines(path: &Path, offset: &mut u64, mut f: impl FnMut(&str)) {
    let Ok(mut file) = fs::File::open(path) else { return };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if len < *offset {
        *offset = 0; // file was truncated or replaced
    }
    if file.seek(SeekFrom::Start(*offset)).is_err() {
        return;
    }
    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).is_err() {
        return;
    }
    let Some(end) = buf.iter().rposition(|&b| b == b'\n') else { return };
    for line in String::from_utf8_lossy(&buf[..end]).lines() {
        f(line);
    }
    *offset += end as u64 + 1;
}

/// Sums entries into rolling 5h, since-local-midnight and rolling 7d windows,
/// counting each request once (first seen wins).
fn windows(mut entries: Vec<UsageEntry>, now: f64, midnight: f64) -> UsageReport {
    entries.sort_by(|a, b| a.ts_ms.total_cmp(&b.ts_ms));
    let mut seen = HashSet::new();
    let (mut five_hour, mut today, mut week) = Default::default();
    for e in entries.into_iter().filter(|e| seen.insert(e.key.clone())) {
        for (window, since) in [
            (&mut five_hour, now - 5.0 * 3600.0 * 1000.0),
            (&mut today, midnight),
            (&mut week, now - 7.0 * 24.0 * 3600.0 * 1000.0),
        ] {
            let w: &mut TokenWindow = window;
            if e.ts_ms < since {
                continue;
            }
            w.input += e.input;
            w.output += e.output;
            w.cache_write += e.cache_write;
            w.cache_read += e.cache_read;
            w.oldest_ms.get_or_insert(e.ts_ms);
        }
    }
    for w in [&mut five_hour, &mut today, &mut week] {
        let w: &mut TokenWindow = w;
        w.effective = w.input + w.cache_write + w.cache_read / 10 + w.output;
    }
    UsageReport {
        harness: "",
        five_hour,
        today,
        week,
    }
}

#[cfg(unix)]
fn pid_alive(pid: i32) -> bool {
    // EPERM still means the process exists (it just isn't ours).
    pid > 0
        && (unsafe { libc::kill(pid, 0) } == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM))
}

#[cfg(not(unix))]
fn pid_alive(_pid: i32) -> bool {
    false // ponytail: Windows needs OpenProcess; agent tracking is macOS/Linux only for now
}

fn parse_iso_ms(s: &str) -> Option<f64> {
    DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis() as f64)
}

fn local_midnight_ms() -> f64 {
    let today = Local::now().date_naive().and_hms_opt(0, 0, 0).unwrap_or_default();
    Local
        .from_local_datetime(&today)
        .earliest()
        .map(|d| d.timestamp_millis() as f64)
        .unwrap_or(0.0)
}

fn system_ms(t: SystemTime) -> f64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

fn now_ms() -> f64 {
    system_ms(SystemTime::now())
}

fn file_created_ms(path: &Path) -> Option<f64> {
    let meta = fs::metadata(path).ok()?;
    meta.created().or_else(|_| meta.modified()).ok().map(system_ms)
}

fn folder_name(cwd: &str) -> String {
    Path::new(cwd)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(cwd)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_matches_claude_code_project_folders() {
        assert_eq!(project_slug("/Users/ansar/project/panguyuban"), "-Users-ansar-project-panguyuban");
        assert_eq!(project_slug("/tmp/my app_1"), "-tmp-my-app-1");
    }

    #[test]
    fn claude_lines_dedupe_by_request_and_track_finished_subagents() {
        let mut p = Parsed::default();
        let usage = r#"{"requestId":"r1","message":{"model":"claude-opus-5-5","usage":{"input_tokens":10,"cache_creation_input_tokens":5,"cache_read_input_tokens":100,"output_tokens":7}}}"#;
        apply_claude_line(&mut p, usage);
        apply_claude_line(&mut p, usage); // repeated per content block
        apply_claude_line(&mut p, r#"{"message":{"content":[{"type":"tool_result","tool_use_id":"tu-1","content":"done"},{"type":"tool_result","tool_use_id":"tu-2","content":"Async agent launched successfully"}]}}"#);
        apply_claude_line(&mut p, r#"{"message":{"content":"<task-notification><task-id>abc123</task-id></task-notification>"}}"#);

        assert_eq!(p.totals(), (10 + 5 + 10, 7));
        assert_eq!(p.model.as_deref(), Some("claude-opus-5-5"));
        assert!(p.finished.contains("tu-1") && p.finished.contains("abc123"));
        assert!(!p.finished.contains("tu-2"), "a launch ack is not a finish");
    }

    #[test]
    fn agy_status_follows_latest_step() {
        let mut p = Parsed::default();
        apply_agy_line(&mut p, r#"{"type":"PLANNER_RESPONSE","step_index":1,"tool_calls":[{}],"input_tokens":100,"cache_read_tokens":50,"output_tokens":9,"created_at":"2026-11-11T07:00:00Z"}"#);
        assert_eq!(p.status.as_deref(), Some("busy"));
        apply_agy_line(&mut p, r#"{"type":"GENERIC","status":"WAITING_FOR_USER","created_at":"2026-11-11T07:01:00Z"}"#);
        assert_eq!(p.status.as_deref(), Some("waiting"));
        apply_agy_line(&mut p, r#"{"type":"PLANNER_RESPONSE","step_index":2,"tool_calls":[],"output_tokens":1}"#);
        assert_eq!(p.status.as_deref(), Some("idle"));
        assert_eq!(p.totals(), (105, 10));
        assert_eq!(p.last_step_ms, parse_iso_ms("2026-11-11T07:01:00Z"));
    }

    #[test]
    fn windows_split_by_time_and_count_each_request_once() {
        let h = 3600.0 * 1000.0;
        let now = 100.0 * h;
        let e = |key: &str, hours_ago: f64, input: u64| UsageEntry {
            key: key.into(),
            ts_ms: now - hours_ago * h,
            input,
            output: 1,
            cache_write: 0,
            cache_read: 100,
        };
        let r = windows(
            vec![e("a", 1.0, 10), e("a", 1.0, 10), e("b", 6.0, 20), e("c", 200.0, 99)],
            now,
            now - 8.0 * h,
        );
        assert_eq!(r.five_hour.input, 10);
        assert_eq!(r.today.input, 30);
        assert_eq!(r.week.input, 30);
        assert_eq!(r.five_hour.effective, 10 + 10 + 1);
        assert_eq!(r.week.oldest_ms, Some(now - 6.0 * h));
    }

    #[test]
    fn incremental_reader_waits_for_complete_lines() {
        let dir = std::env::temp_dir().join(format!("pgy-agents-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        fs::write(&path, "one\ntwo\npart").unwrap();
        let (mut offset, mut seen) = (0, Vec::new());
        read_new_lines(&path, &mut offset, |l| seen.push(l.to_string()));
        assert_eq!(seen, ["one", "two"]);
        fs::write(&path, "one\ntwo\npartial\n").unwrap();
        read_new_lines(&path, &mut offset, |l| seen.push(l.to_string()));
        assert_eq!(seen, ["one", "two", "partial"]);
        fs::remove_dir_all(&dir).ok();
    }
}
