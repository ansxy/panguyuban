//! Runs a command-line agent with a time limit.

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub struct Finished {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

pub enum RunError {
    /// The program could not be started (usually: not installed).
    Spawn,
    TimedOut,
}

/// The command for `program`. On macOS it goes through a login shell, because
/// an app launched from Finder does not get the user's PATH.
fn command(program: &str, args: &[&str]) -> Command {
    if cfg!(target_os = "macos") {
        let mut cmd = Command::new("/bin/zsh");
        cmd.args(["-lc", "exec \"$0\" \"$@\"", program]).args(args);
        cmd
    } else {
        let mut cmd = Command::new(program);
        cmd.args(args);
        cmd
    }
}

/// Whether `program` can be found the same way `run` will look for it.
pub fn on_path(program: &str) -> bool {
    let mut cmd = if cfg!(target_os = "macos") {
        let mut cmd = Command::new("/bin/zsh");
        cmd.args(["-lc", "command -v \"$0\"", program]);
        cmd
    } else if cfg!(windows) {
        let mut cmd = Command::new("where");
        cmd.arg(program);
        cmd
    } else {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "command -v \"$0\"", program]);
        cmd
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Runs `program`, feeds it `stdin` if given, and kills it after `timeout`.
pub fn run(
    program: &str,
    args: &[&str],
    stdin: Option<&str>,
    work_dir: &Path,
    timeout: Duration,
) -> Result<Finished, RunError> {
    let mut child = command(program, args)
        .current_dir(work_dir)
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| RunError::Spawn)?;

    // Feed and drain on separate threads so a full pipe can never stall the child.
    let writer = child.stdin.take().zip(stdin.map(str::to_owned)).map(|(mut pipe, text)| {
        thread::spawn(move || {
            let _ = pipe.write_all(text.as_bytes());
        })
    });
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let out_reader = thread::spawn(move || {
        let mut buf = String::new();
        if let Some(pipe) = out_pipe.as_mut() {
            let _ = pipe.read_to_string(&mut buf);
        }
        buf
    });
    let err_reader = thread::spawn(move || {
        let mut buf = String::new();
        if let Some(pipe) = err_pipe.as_mut() {
            let _ = pipe.read_to_string(&mut buf);
        }
        buf
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(RunError::TimedOut);
            }
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(_) => return Err(RunError::Spawn),
        }
    };
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    Ok(Finished {
        success: status.success(),
        stdout: out_reader.join().unwrap_or_default(),
        stderr: err_reader.join().unwrap_or_default(),
    })
}

/// The last few lines of a program's error output, for showing to the user.
pub fn tail(text: &str) -> String {
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let from = lines.len().saturating_sub(4);
    lines[from..].join(" | ")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn passes_stdin_and_reads_stdout() {
        let dir = std::env::temp_dir();
        let Ok(done) = run("cat", &[], Some("hello"), &dir, Duration::from_secs(10)) else {
            panic!("cat should run");
        };
        assert!(done.success);
        assert_eq!(done.stdout, "hello");
    }

    #[test]
    fn kills_a_program_that_runs_past_the_limit() {
        let dir = std::env::temp_dir();
        let started = Instant::now();
        let result = run("sleep", &["30"], None, &dir, Duration::from_millis(300));
        assert!(matches!(result, Err(RunError::TimedOut)));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn missing_program_is_reported_as_not_found() {
        assert!(!on_path("panguyuban-no-such-program"));
        assert!(on_path("cat"));
    }
}
