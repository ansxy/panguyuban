//! Claude Code, run as `claude -p`.

use std::path::Path;
use std::time::Duration;

use serde::Deserialize;

use crate::process::{self, RunError};
use crate::{AgentRuntime, RuntimeError};

const HARNESS: &str = "claude";

pub struct ClaudeRuntime;

/// The single JSON object `claude -p --output-format json` prints.
#[derive(Deserialize)]
struct PrintResult {
    #[serde(default)]
    is_error: bool,
    #[serde(default)]
    result: String,
}

impl AgentRuntime for ClaudeRuntime {
    fn harness(&self) -> &'static str {
        HARNESS
    }

    fn is_available(&self) -> bool {
        process::on_path("claude")
    }

    fn complete(
        &self,
        system: &str,
        prompt: &str,
        model: Option<&str>,
        work_dir: &Path,
        timeout: Duration,
    ) -> Result<String, RuntimeError> {
        // No built-in tools, no MCP servers, no skills or commands: the agent can only talk.
        // The prompt goes in on stdin so its length and content never touch the command line.
        let mut args = vec![
            "-p",
            "--output-format",
            "json",
            "--tools",
            "",
            "--strict-mcp-config",
            "--disable-slash-commands",
            "--system-prompt",
            system,
        ];
        if let Some(model) = model.filter(|m| !m.trim().is_empty()) {
            args.extend(["--model", model]);
        }

        let done = process::run("claude", &args, Some(prompt), work_dir, timeout).map_err(|e| match e {
            RunError::Spawn => RuntimeError::NotInstalled { harness: HARNESS },
            RunError::TimedOut => RuntimeError::TimedOut { harness: HARNESS, seconds: timeout.as_secs() },
        })?;

        parse_print_result(done.success, &done.stdout, &done.stderr)
    }
}

fn parse_print_result(success: bool, stdout: &str, stderr: &str) -> Result<String, RuntimeError> {
    let failed = |detail: String| RuntimeError::Failed { harness: HARNESS, detail };
    match serde_json::from_str::<PrintResult>(stdout.trim()) {
        Ok(parsed) if parsed.is_error => Err(failed(parsed.result)),
        Ok(parsed) if parsed.result.trim().is_empty() => Err(failed("it returned an empty reply".into())),
        Ok(parsed) => Ok(parsed.result),
        Err(_) if !success => Err(failed(process::tail(if stderr.trim().is_empty() { stdout } else { stderr }))),
        Err(e) => Err(failed(format!("could not read its reply ({e})"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_result_text() {
        let out = r#"{"type":"result","is_error":false,"result":"When is the demo?","session_id":"x"}"#;
        assert_eq!(parse_print_result(true, out, "").unwrap(), "When is the demo?");
    }

    #[test]
    fn an_error_result_becomes_a_failure_with_its_message() {
        let out = r#"{"type":"result","is_error":true,"result":"Invalid model name"}"#;
        let err = parse_print_result(false, out, "").unwrap_err();
        assert_eq!(err.to_string(), "claude failed: Invalid model name");
    }

    #[test]
    fn a_crash_reports_the_end_of_stderr() {
        let err = parse_print_result(false, "", "warming up\n\nError: not logged in\n").unwrap_err();
        assert_eq!(err.to_string(), "claude failed: warming up | Error: not logged in");
    }

    #[test]
    fn an_empty_reply_is_a_failure() {
        let err = parse_print_result(true, r#"{"is_error":false,"result":"  "}"#, "").unwrap_err();
        assert!(err.to_string().contains("empty reply"));
    }
}
