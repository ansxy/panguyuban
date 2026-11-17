//! `run_command`: run a shell command in the project folder after an approver says yes.

use std::io::Read;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::tools::{definition, str_arg};
use crate::{Tool, ToolResult, Workspace};

const GRACE: Duration = Duration::from_millis(1500);
/// The most output kept per command; the rest is read and dropped.
const OUTPUT_KEEP: usize = 1 << 20;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Approval {
    Once,
    AlwaysHere,
    Deny,
}

pub trait Approver: Send + Sync {
    fn approve(&self, command: &str) -> Approval;
}

pub struct RunCommand {
    approver: Box<dyn Approver>,
    allowed: Mutex<Vec<String>>,
    remember: Box<dyn Fn(&str) + Send + Sync>,
    timeout: Duration,
    /// Set (e.g. by Ctrl-C) to stop the running command and its whole process group.
    cancel: &'static AtomicBool,
}

impl RunCommand {
    pub fn new(
        approver: Box<dyn Approver>,
        always_allowed: Vec<String>,
        remember: Box<dyn Fn(&str) + Send + Sync>,
        timeout: Duration,
        cancel: &'static AtomicBool,
    ) -> RunCommand {
        RunCommand { approver, allowed: Mutex::new(always_allowed), remember, timeout, cancel }
    }
}

impl Tool for RunCommand {
    fn name(&self) -> &'static str {
        "run_command"
    }
    fn definition(&self) -> Value {
        definition("run_command", "Run a shell command in the project folder. The user is asked first.", json!({"command": {"type": "string"}}), &["command"])
    }
    fn run(&self, ws: &Workspace, args: &Value) -> ToolResult {
        let cmd = match str_arg(args, "command") {
            Ok(c) => c,
            Err(r) => return r,
        };
        let known = self.allowed.lock().unwrap().iter().any(|a| a == cmd);
        if !known {
            match self.approver.approve(cmd) {
                Approval::Deny => return ToolResult::refused(format!("denied `{cmd}`"), "the user denied this command"),
                Approval::AlwaysHere => {
                    self.allowed.lock().unwrap().push(cmd.to_string());
                    (self.remember)(cmd);
                }
                Approval::Once => {}
            }
        }
        // One pipe for both streams, read on its own thread so a chatty command cannot block.
        let (mut reader, writer) = match std::io::pipe() {
            Ok(p) => p,
            Err(e) => return ToolResult::refused(format!("could not run `{cmd}`"), e.to_string()),
        };
        let spawned = writer.try_clone().and_then(|w2| {
            Command::new("sh").arg("-c").arg(cmd).current_dir(ws.root())
                .process_group(0).stdin(Stdio::null()).stdout(writer).stderr(w2).spawn()
        });
        let mut child = match spawned {
            Ok(c) => c,
            Err(e) => return ToolResult::refused(format!("could not run `{cmd}`"), e.to_string()),
        };
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            let (mut chunk, mut kept, mut cut) = ([0u8; 4096], 0, false);
            while let Ok(n) = reader.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                // Keep the first OUTPUT_KEEP bytes but keep draining, so the command never blocks on a full pipe.
                let take = n.min(OUTPUT_KEEP - kept);
                kept += take;
                let mut keep = chunk[..take].to_vec();
                if take < n && !cut {
                    cut = true;
                    keep.extend_from_slice(b"\n[output cut]\n");
                }
                if !keep.is_empty() && tx.send(keep).is_err() {
                    break;
                }
            }
        });
        let start = Instant::now();
        let code = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status.code().unwrap_or(-1)),
                Ok(None) if self.cancel.load(Ordering::SeqCst) => break Err("cancelled".to_string()),
                Ok(None) if start.elapsed() >= self.timeout => {
                    break Err(format!("timed out after {} s", self.timeout.as_secs()))
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(20)),
                Err(_) => break Ok(-1),
            }
        };
        if code.is_err() {
            // Only a stopped command kills the whole group; a background child left by a normal exit is kept.
            unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
            let _ = child.wait();
        }
        // Collect output until EOF, but give up after a grace period: a background child may hold the pipe open.
        let grace = Instant::now() + GRACE;
        let mut buf = Vec::new();
        loop {
            match rx.recv_timeout(grace.saturating_duration_since(Instant::now())) {
                Ok(c) => buf.extend(c),
                Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        let out = String::from_utf8_lossy(&buf).into_owned();
        match code {
            Ok(n) => ToolResult { ok: n == 0, summary: format!("ran `{cmd}` (exit {n})"), output: format!("exit code {n}\n{out}") },
            Err(why) => ToolResult::refused(format!("stopped `{cmd}`: {why}"), format!("{why}\n{out}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    struct Fixed(Approval, Arc<Mutex<u32>>);
    impl Approver for Fixed {
        fn approve(&self, _c: &str) -> Approval {
            *self.1.lock().unwrap() += 1;
            self.0
        }
    }

    fn tool(a: Approval, allowed: &[&str], secs: u64) -> (RunCommand, Arc<Mutex<u32>>, Arc<Mutex<Vec<String>>>, tempfile::TempDir, Workspace) {
        tool_with(a, allowed, secs, Box::leak(Box::new(AtomicBool::new(false))))
    }
    fn tool_with(a: Approval, allowed: &[&str], secs: u64, cancel: &'static AtomicBool) -> (RunCommand, Arc<Mutex<u32>>, Arc<Mutex<Vec<String>>>, tempfile::TempDir, Workspace) {
        let asked = Arc::new(Mutex::new(0));
        let kept = Arc::new(Mutex::new(vec![]));
        let k = kept.clone();
        let t = RunCommand::new(Box::new(Fixed(a, asked.clone())), allowed.iter().map(|s| s.to_string()).collect(),
            Box::new(move |c| k.lock().unwrap().push(c.to_string())), Duration::from_secs(secs), cancel);
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::new(dir.path(), &["*".to_string()]).unwrap();
        (t, asked, kept, dir, ws)
    }
    fn go(t: &RunCommand, ws: &Workspace, c: &str) -> ToolResult {
        t.run(ws, &json!({"command": c}))
    }

    #[test]
    fn denied_commands_do_not_run() {
        let (t, _, _, dir, ws) = tool(Approval::Deny, &[], 5);
        let r = go(&t, &ws, "touch made.txt");
        assert!(!r.ok);
        assert!(r.output.contains("the user denied this command"));
        assert!(!dir.path().join("made.txt").exists());
    }

    #[test]
    fn once_runs_and_asks_again() {
        let (t, asked, _, _d, ws) = tool(Approval::Once, &[], 5);
        for _ in 0..2 {
            let r = go(&t, &ws, "echo ORD-2041");
            assert!(r.ok);
            assert!(r.output.contains("exit code 0") && r.output.contains("ORD-2041"));
        }
        assert_eq!(*asked.lock().unwrap(), 2);
    }

    #[test]
    fn always_here_is_remembered() {
        let (t, asked, kept, _d, ws) = tool(Approval::AlwaysHere, &[], 5);
        go(&t, &ws, "echo hi");
        go(&t, &ws, "echo hi");
        assert_eq!(*asked.lock().unwrap(), 1);
        assert_eq!(*kept.lock().unwrap(), vec!["echo hi".to_string()]);
    }

    #[test]
    fn always_allowed_skips_the_prompt() {
        let (t, asked, _, _d, ws) = tool(Approval::Deny, &["echo hi"], 5);
        assert!(go(&t, &ws, "echo hi").ok);
        assert_eq!(*asked.lock().unwrap(), 0);
    }

    #[test]
    fn a_background_child_does_not_hang_the_call() {
        let (t, _, _, _d, ws) = tool(Approval::Once, &[], 10);
        let start = Instant::now();
        let r = go(&t, &ws, "(sleep 5) & echo hi");
        assert!(start.elapsed() < Duration::from_secs(4));
        assert!(r.ok && r.output.contains("hi"));
    }

    #[test]
    fn a_timeout_kills_background_children_too() {
        let (t, _, _, _d, ws) = tool(Approval::Once, &[], 1);
        let start = Instant::now();
        let r = go(&t, &ws, "echo started; (sleep 5; echo late) & sleep 5");
        assert!(start.elapsed() < Duration::from_secs(4));
        assert!(!r.ok && r.output.contains("timed out after 1 s") && r.output.contains("started"));
        assert!(!r.output.contains("late"));
    }

    #[test]
    fn failing_and_slow_commands_report() {
        let (t, _, _, _d, ws) = tool(Approval::Once, &[], 1);
        let r = go(&t, &ws, "exit 3");
        assert!(!r.ok && r.output.contains("exit code 3"));
        let r = go(&t, &ws, "sleep 5");
        assert!(!r.ok && r.output.contains("timed out after 1 s"));
    }

    #[test]
    fn cancel_kills_a_running_command() {
        let cancel: &'static AtomicBool = Box::leak(Box::new(AtomicBool::new(false)));
        let (t, _, _, _d, ws) = tool_with(Approval::Once, &[], 60, cancel);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        let start = Instant::now();
        let r = go(&t, &ws, "echo started; sleep 30");
        assert!(start.elapsed() < Duration::from_secs(4));
        assert!(!r.ok && r.output.contains("cancelled") && r.output.contains("started"), "{r:?}");
    }

    #[test]
    fn huge_output_is_cut_but_drained() {
        let (t, _, _, _d, ws) = tool(Approval::Once, &[], 30);
        let r = go(&t, &ws, "head -c 3000000 /dev/zero | tr '\\0' a; echo after");
        assert!(r.ok, "{}", r.summary);
        assert!(r.output.contains("[output cut]"));
        assert!(r.output.len() < (1 << 20) + 100);
    }
}
