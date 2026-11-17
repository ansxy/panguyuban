//! The contract for a tool-using task: what goes in, what streams out, how it ends.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use serde::Serialize;

use crate::RuntimeError;

/// One unit of work for an agent that can use tools inside a project folder.
pub struct Task {
    pub system: String,
    pub prompt: String,
    pub model: Option<String>,
    pub work_dir: PathBuf,
    /// Relative paths the agent may write; `"*"` allows any path inside the folder.
    pub write_paths: Vec<String>,
    pub max_steps: u32,
    pub timeout: Duration,
    /// Where to keep the full run record, when wanted.
    pub record: Option<PathBuf>,
}

/// Progress shown to the user while a task runs.
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TaskEvent {
    Step { tool: String, summary: String, ok: bool },
    Message { text: String },
}

/// Why a task ended before the agent finished on its own.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    MaxSteps,
    TimedOut,
    Cancelled,
}

#[derive(Serialize, Debug)]
pub struct TaskOutcome {
    pub message: String,
    pub steps: u32,
    pub stopped: Option<StopReason>,
}

/// An agent that can run a [`Task`] with tools.
pub trait TaskRuntime: Send + Sync {
    fn harness(&self) -> &'static str;

    fn run_task(
        &self,
        task: &Task,
        cancel: &AtomicBool,
        on_event: &dyn Fn(TaskEvent),
    ) -> Result<TaskOutcome, RuntimeError>;
}
