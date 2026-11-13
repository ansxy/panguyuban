//! Embedded terminal: the user's login shell on a PTY. The UI long-polls
//! `read` for output instead of listening to events, so no JS event plumbing.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    output: Arc<tokio::sync::Mutex<UnboundedReceiver<Vec<u8>>>>,
}

#[derive(Default)]
pub struct Terminals {
    next_id: AtomicU32,
    sessions: Mutex<HashMap<u32, Session>>,
}

/// What a pane header shows: the foreground program and its folder (`~`-relative).
#[derive(Debug, Serialize)]
pub struct TermInfo {
    pub command: String,
    pub cwd: String,
}

/// `~` and `~/x` are relative to the home folder; other paths pass through.
pub fn expand_home(path: &str) -> PathBuf {
    match (path.strip_prefix('~'), dirs::home_dir()) {
        (Some(rest), Some(home)) if rest.is_empty() || rest.starts_with('/') => {
            home.join(rest.trim_start_matches('/'))
        }
        _ => PathBuf::from(path),
    }
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }
}

impl Terminals {
    /// Starts `$SHELL -l` in `cwd` (`~` allowed; home when it is not an existing dir).
    pub fn open(&self, cols: u16, rows: u16, cwd: &str) -> Result<u32, String> {
        let pair = native_pty_system()
            .openpty(size(cols, rows))
            .map_err(|e| e.to_string())?;
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut cmd = CommandBuilder::new(shell);
        cmd.arg("-l");
        cmd.env("TERM", "xterm-256color");
        let cwd = expand_home(cwd);
        match (cwd.is_absolute() && cwd.is_dir(), dirs::home_dir()) {
            (true, _) => cmd.cwd(&cwd),
            (false, Some(home)) => cmd.cwd(home),
            (false, None) => {}
        }
        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let (tx, rx) = unbounded_channel();
        // Ends when the shell exits; dropping tx makes the next `read` report it closed.
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let session = Session {
            master: pair.master,
            writer,
            child,
            output: Arc::new(tokio::sync::Mutex::new(rx)),
        };
        self.sessions.lock().map_err(|e| e.to_string())?.insert(id, session);
        Ok(id)
    }

    /// Waits for the next output, batching whatever else is already queued.
    /// `None` once the shell has exited.
    pub async fn read(&self, id: u32) -> Result<Option<Vec<u8>>, String> {
        let output = self
            .sessions
            .lock()
            .map_err(|e| e.to_string())?
            .get(&id)
            .map(|s| s.output.clone())
            .ok_or("terminal is closed")?;
        let mut rx = output.lock().await;
        let Some(mut out) = rx.recv().await else { return Ok(None) };
        while let Ok(more) = rx.try_recv() {
            out.extend(more);
        }
        Ok(Some(out))
    }

    pub fn write(&self, id: u32, data: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions.get_mut(&id).ok_or("terminal is closed")?;
        session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions.get(&id).ok_or("terminal is closed")?;
        session.master.resize(size(cols, rows)).map_err(|e| e.to_string())
    }

    pub fn info(&self, id: u32) -> Result<TermInfo, String> {
        let pid = {
            let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            let session = sessions.get(&id).ok_or("terminal is closed")?;
            session.master.process_group_leader().ok_or("no foreground process")?
        };
        let cwd = proc_cwd(pid);
        let cwd = match dirs::home_dir().and_then(|h| cwd.strip_prefix(h.to_str()?).map(str::to_string)) {
            Some(rest) => format!("~{rest}"),
            None => cwd,
        };
        Ok(TermInfo { command: proc_name(pid), cwd })
    }

    pub fn close(&self, id: u32) {
        if let Some(mut session) = self.sessions.lock().ok().and_then(|mut s| s.remove(&id)) {
            let _ = session.child.kill();
        }
    }
}

#[cfg(target_os = "macos")]
fn proc_name(pid: i32) -> String {
    let mut buf = [0u8; 256];
    let n = unsafe { libc::proc_name(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    String::from_utf8_lossy(&buf[..n.max(0) as usize]).into_owned()
}

#[cfg(target_os = "macos")]
fn proc_cwd(pid: i32) -> String {
    let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&info) as i32;
    let n = unsafe {
        libc::proc_pidinfo(pid, libc::PROC_PIDVNODEPATHINFO, 0, (&mut info as *mut libc::proc_vnodepathinfo).cast(), size)
    };
    if n != size {
        return String::new();
    }
    // vip_path is a NUL-terminated MAXPATHLEN buffer, split into rows by libc.
    let path = unsafe { std::ffi::CStr::from_ptr(info.pvi_cdir.vip_path.as_ptr().cast()) };
    path.to_string_lossy().into_owned()
}

// ponytail: pane headers fall back to the space folder off macOS.
#[cfg(not(target_os = "macos"))]
fn proc_name(_pid: i32) -> String {
    String::new()
}

#[cfg(not(target_os = "macos"))]
fn proc_cwd(_pid: i32) -> String {
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn runs_the_shell_and_reports_exit() {
        let terms = Terminals::default();
        let id = terms.open(80, 24, "/").unwrap();
        terms.write(id, "echo pan-$((40+2)); exit\n").unwrap();
        let mut seen = String::new();
        while let Some(chunk) = terms.read(id).await.unwrap() {
            seen.push_str(&String::from_utf8_lossy(&chunk));
        }
        assert!(seen.contains("pan-42"), "output was: {seen}");
    }

    #[test]
    fn expands_only_a_leading_home_tilde() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(expand_home("~"), home);
        assert_eq!(expand_home("~/project"), home.join("project"));
        assert_eq!(expand_home("~bob/x"), PathBuf::from("~bob/x"));
        assert_eq!(expand_home("/tmp"), PathBuf::from("/tmp"));
    }

    #[tokio::test]
    async fn reports_the_foreground_program_and_folder() {
        let terms = Terminals::default();
        let id = terms.open(80, 24, "/tmp").unwrap();
        terms.write(id, "exec sleep 5\n").unwrap();
        let mut info = terms.info(id).unwrap();
        for _ in 0..50 {
            if info.command == "sleep" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            info = terms.info(id).unwrap();
        }
        assert_eq!(info.command, "sleep");
        assert!(info.cwd.ends_with("/tmp"), "cwd was {}", info.cwd);
        terms.close(id);
        terms.close(id);
    }
}
