//! `run_command`: run a shell command in the project folder after an approver says yes.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::tools::{definition, str_arg};
use crate::{Tool, ToolResult, Workspace};

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
}

impl RunCommand {
    pub fn new(approver: Box<dyn Approver>, always_allowed: Vec<String>, remember: Box<dyn Fn(&str) + Send + Sync>, timeout: Duration) -> RunCommand {
        RunCommand { approver, allowed: Mutex::new(always_allowed), remember, timeout }
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
                .stdin(Stdio::null()).stdout(writer).stderr(w2).spawn()
        });
        let mut child = match spawned {
            Ok(c) => c,
            Err(e) => return ToolResult::refused(format!("could not run `{cmd}`"), e.to_string()),
        };
        let reading = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = reader.read_to_end(&mut buf);
            String::from_utf8_lossy(&buf).into_owned()
        });
        let start = Instant::now();
        let code = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status.code().unwrap_or(-1)),
                Ok(None) if start.elapsed() >= self.timeout => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(20)),
                Err(_) => break Some(-1),
            }
        };
        // ponytail: a grandchild holding the pipe open would block this join; fine for sh -c one-liners.
        let out = reading.join().unwrap_or_default();
        match code {
            Some(n) => ToolResult { ok: n == 0, summary: format!("ran `{cmd}` (exit {n})"), output: format!("exit code {n}\n{out}") },
            None => {
                let secs = self.timeout.as_secs();
                ToolResult::refused(format!("`{cmd}` timed out"), format!("timed out after {secs} s\n{out}"))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    struct Fixed(Approval, Arc<Mutex<u32>>);
    impl Approver for Fixed {
        fn approve(&self, _c: &str) -> Approval {
            *self.1.lock().unwrap() += 1;
            self.0
        }
    }

    fn tool(a: Approval, allowed: &[&str], secs: u64) -> (RunCommand, Arc<Mutex<u32>>, Arc<Mutex<Vec<String>>>, tempfile::TempDir, Workspace) {
        let asked = Arc::new(Mutex::new(0));
        let kept = Arc::new(Mutex::new(vec![]));
        let k = kept.clone();
        let t = RunCommand::new(Box::new(Fixed(a, asked.clone())), allowed.iter().map(|s| s.to_string()).collect(),
            Box::new(move |c| k.lock().unwrap().push(c.to_string())), Duration::from_secs(secs));
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
    fn failing_and_slow_commands_report() {
        let (t, _, _, _d, ws) = tool(Approval::Once, &[], 1);
        let r = go(&t, &ws, "exit 3");
        assert!(!r.ok && r.output.contains("exit code 3"));
        let r = go(&t, &ws, "sleep 5");
        assert!(!r.ok && r.output.contains("timed out after 1 s"));
    }
}
