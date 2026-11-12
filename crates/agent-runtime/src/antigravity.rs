//! Google Antigravity, run as `agy -p`.
//!
//! Untested against a real Antigravity install: the options used here (`-p` for a
//! single printed answer, `--model`) come from third-party write-ups. It has no
//! known option to switch tools off or to set a system prompt, so the instructions
//! go in the prompt and the "no tools" rule rests on the instructions alone.

use std::path::Path;
use std::time::Duration;

use crate::process::{self, RunError};
use crate::{AgentRuntime, RuntimeError};

const HARNESS: &str = "antigravity";

pub struct AntigravityRuntime;

impl AgentRuntime for AntigravityRuntime {
    fn harness(&self) -> &'static str {
        HARNESS
    }

    fn is_available(&self) -> bool {
        process::on_path("agy")
    }

    fn complete(
        &self,
        system: &str,
        prompt: &str,
        model: Option<&str>,
        work_dir: &Path,
        timeout: Duration,
    ) -> Result<String, RuntimeError> {
        let combined = format!("{system}\n\n---\n\n{prompt}");
        let mut args = vec!["-p", combined.as_str()];
        if let Some(model) = model.filter(|m| !m.trim().is_empty()) {
            args.extend(["--model", model]);
        }

        let done = process::run("agy", &args, None, work_dir, timeout).map_err(|e| match e {
            RunError::Spawn => RuntimeError::NotInstalled { harness: HARNESS },
            RunError::TimedOut => RuntimeError::TimedOut { harness: HARNESS, seconds: timeout.as_secs() },
        })?;

        let failed = |detail: String| RuntimeError::Failed { harness: HARNESS, detail };
        if !done.success {
            let source = if done.stderr.trim().is_empty() { &done.stdout } else { &done.stderr };
            return Err(failed(process::tail(source)));
        }
        if done.stdout.trim().is_empty() {
            return Err(failed("it returned an empty reply".into()));
        }
        Ok(done.stdout)
    }
}
