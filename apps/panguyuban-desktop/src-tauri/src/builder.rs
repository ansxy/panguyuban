//! Guided builder commands: which agents are installed, and one interview turn.

use std::path::PathBuf;

use agent_runtime::{
    design_turn, interview_turn, plan_turn, runtime_for, DesignRequest, InterviewRequest, Plan, Turn,
};
use serde::{Deserialize, Serialize};

const HARNESSES: [&str; 2] = ["claude", "antigravity"];

#[derive(Debug, Serialize)]
pub struct HarnessStatus {
    pub harness: &'static str,
    pub available: bool,
}

/// Which agent command-line tools are installed on this machine.
pub fn harness_statuses() -> Vec<HarnessStatus> {
    HARNESSES
        .iter()
        .map(|harness| HarnessStatus {
            harness,
            available: runtime_for(harness).map(|r| r.is_available()).unwrap_or(false),
        })
        .collect()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterviewTurnArgs {
    pub project_id: String,
    pub project_name: String,
    pub client: String,
    pub author: String,
    pub harness: String,
    pub model: Option<String>,
    pub transcript: Vec<Turn>,
}

#[derive(Debug, Serialize)]
pub struct InterviewTurnResult {
    pub message: String,
    pub prd: Option<String>,
    /// Where prd.md was saved, when the agent produced one this turn.
    pub prd_path: Option<String>,
}

/// Runs one interview turn and saves the PRD if the agent wrote one.
pub fn run_interview_turn(args: InterviewTurnArgs) -> Result<InterviewTurnResult, String> {
    let runtime = runtime_for(&args.harness).map_err(|e| e.to_string())?;
    let dir = project_dir(&args.project_name, &args.project_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;

    let request = InterviewRequest {
        project_name: args.project_name,
        client: args.client,
        author: args.author,
        transcript: args.transcript,
        model: args.model,
    };
    let reply = interview_turn(runtime.as_ref(), &request, &dir).map_err(|e| e.to_string())?;

    let prd_path = match &reply.prd {
        Some(prd) => {
            let path = dir.join("prd.md");
            std::fs::write(&path, format!("{prd}\n"))
                .map_err(|e| format!("Could not save {}: {e}", path.display()))?;
            Some(path.display().to_string())
        }
        None => None,
    };
    Ok(InterviewTurnResult { message: reply.message, prd: reply.prd, prd_path })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanArgs {
    pub project_id: String,
    pub project_name: String,
    pub harness: String,
    pub model: Option<String>,
    /// The approved PRD, as shown to the user.
    pub prd: String,
}

/// Has the agent size each step of the approved PRD, and keeps the plan beside prd.md.
pub fn run_plan(args: PlanArgs) -> Result<Plan, String> {
    let runtime = runtime_for(&args.harness).map_err(|e| e.to_string())?;
    let dir = project_dir(&args.project_name, &args.project_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let plan = plan_turn(runtime.as_ref(), &args.prd, args.model.as_deref(), &dir).map_err(|e| e.to_string())?;
    // The plan is part of the record; failing to save it must not lose the plan itself.
    if let Ok(json) = serde_json::to_string_pretty(&plan) {
        let _ = std::fs::write(dir.join("plan.json"), format!("{json}\n"));
    }
    Ok(plan)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignArgs {
    pub project_id: String,
    pub project_name: String,
    pub harness: String,
    pub model: Option<String>,
    pub prd: String,
    /// The mock-up being revised, if any.
    pub current: Option<String>,
    /// What the user asked to change, oldest first.
    pub changes: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct DesignResult {
    pub message: String,
    pub html: String,
    /// Where design.html was saved.
    pub path: Option<String>,
}

/// Has the agent propose or revise the HTML mock-up, and keeps it beside prd.md.
pub fn run_design(args: DesignArgs) -> Result<DesignResult, String> {
    let runtime = runtime_for(&args.harness).map_err(|e| e.to_string())?;
    let dir = project_dir(&args.project_name, &args.project_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let request = DesignRequest {
        prd: args.prd,
        current: args.current,
        changes: args.changes,
        model: args.model,
    };
    let reply = design_turn(runtime.as_ref(), &request, &dir).map_err(|e| e.to_string())?;
    let path = dir.join("design.html");
    let saved = std::fs::write(&path, format!("{}\n", reply.html)).is_ok();
    Ok(DesignResult {
        message: reply.message,
        html: reply.html,
        path: saved.then(|| path.display().to_string()),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePrdArgs {
    pub project_id: String,
    pub project_name: String,
    pub content: String,
    /// Which document to write. Only the names in `SAVABLE` are accepted; defaults to prd.md.
    pub file: Option<String>,
}

/// Documents the app may write into a prototype's folder on the user's behalf.
const SAVABLE: [&str; 2] = ["prd.md", "handover.md"];

/// Writes one of the prototype's documents (the approved PRD, the handover) and returns its path.
pub fn save_prd(args: SavePrdArgs) -> Result<String, String> {
    let dir = project_dir(&args.project_name, &args.project_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let file = args.file.as_deref().unwrap_or("prd.md");
    if !SAVABLE.contains(&file) {
        return Err(format!("{file} is not a document the app saves"));
    }
    let path = dir.join(file);
    std::fs::write(&path, format!("{}\n", args.content.trim_end()))
        .map_err(|e| format!("Could not save {}: {e}", path.display()))?;
    Ok(path.display().to_string())
}

/// `<Documents>/Panguyuban/<name>-<id>`, with only letters, digits and dashes in the folder name.
fn project_dir(name: &str, id: &str) -> PathBuf {
    let base = dirs::document_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Panguyuban").join(folder_name(name, id))
}

fn folder_name(name: &str, id: &str) -> String {
    let clean = |text: &str| {
        text.chars()
            .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
            .collect::<String>()
            .split('-')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("-")
    };
    let (name, id) = (clean(name), clean(id));
    let name: String = name.chars().take(40).collect();
    match (name.is_empty(), id.is_empty()) {
        (false, false) => format!("{name}-{id}"),
        (false, true) => name,
        (true, false) => id,
        (true, true) => "prototype".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_names_cannot_leave_the_projects_folder() {
        assert_eq!(folder_name("Orders Tracking Demo", "p1abc"), "orders-tracking-demo-p1abc");
        assert_eq!(folder_name("../../etc", "../x"), "etc-x");
        assert_eq!(folder_name("///", ""), "prototype");
        assert!(!folder_name("a/b\\c..d", "id").contains(['/', '\\', '.']));
    }

    #[test]
    fn only_known_documents_can_be_saved() {
        let args = |file: &str| SavePrdArgs {
            project_id: "test".into(),
            project_name: "panguyuban unit test".into(),
            content: "x".into(),
            file: Some(file.into()),
        };
        assert!(save_prd(args("../../evil.sh")).is_err());
        assert!(save_prd(args("notes.md")).is_err());
    }

    #[test]
    fn both_harnesses_are_reported() {
        let statuses = harness_statuses();
        assert_eq!(statuses.iter().map(|s| s.harness).collect::<Vec<_>>(), HARNESSES);
    }
}
