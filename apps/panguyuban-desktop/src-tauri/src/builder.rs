//! Guided builder commands: which agents are installed, and one interview turn.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use agent_runtime::{
    build_prompt, build_system_prompt, effective, session_type, HarnessSettings, StopReason, Task, TaskEvent,
    design_turn, interview_turn, plan_turn, runtime_for, DesignRequest, InterviewRequest, Plan, ReviewRole, RoleReview, Turn, review_turn,
};
use panguyuban_core::storage::SqliteStore;
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

#[derive(Debug, Clone, Serialize)]
pub struct ModelOption {
    pub id: String,
    pub label: String,
}

/// Claude Code has no list command, so these are the aliases its `--model` documents.
const CLAUDE_MODELS: [(&str, &str); 4] = [
    ("fable", "Fable (latest)"),
    ("opus", "Opus (latest)"),
    ("sonnet", "Sonnet (latest)"),
    ("haiku", "Haiku (latest)"),
];

/// Antigravity's list, fetched once per app run (it takes a few seconds and needs the network).
static AGY_MODELS: OnceLock<Mutex<Option<Vec<ModelOption>>>> = OnceLock::new();

/// Every model the harness's tool offers.
pub fn models_for(harness: &str) -> Result<Vec<ModelOption>, String> {
    match harness {
        "claude" => Ok(CLAUDE_MODELS
            .iter()
            .map(|(id, label)| ModelOption { id: (*id).into(), label: (*label).into() })
            .collect()),
        "antigravity" => {
            let mut cached = AGY_MODELS.get_or_init(Default::default).lock().map_err(|e| e.to_string())?;
            if let Some(models) = cached.as_ref() {
                return Ok(models.clone());
            }
            let out = Command::new("agy")
                .arg("models")
                .output()
                .map_err(|e| format!("Could not run agy: {e}"))?;
            if !out.status.success() {
                return Err(format!("agy models failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
            }
            let models = parse_models(&String::from_utf8_lossy(&out.stdout));
            *cached = Some(models.clone());
            Ok(models)
        }
        other => Err(format!("Unknown agent tool: {other}")),
    }
}

/// `<id>\t<label>` per line; anything without a tab (the "Fetching..." line) is skipped.
fn parse_models(text: &str) -> Vec<ModelOption> {
    text.lines()
        .filter_map(|line| line.split_once('\t'))
        .map(|(id, label)| ModelOption { id: id.trim().into(), label: label.trim().into() })
        .filter(|m| !m.id.is_empty())
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
pub fn run_interview_turn(store: &SqliteStore, args: InterviewTurnArgs) -> Result<InterviewTurnResult, String> {
    let runtime = crate::provider::runtime_for(store, &args.harness)?;
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
pub fn run_plan(store: &SqliteStore, args: PlanArgs) -> Result<Plan, String> {
    let runtime = crate::provider::runtime_for(store, &args.harness)?;
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
pub struct ReviewStepArgs {
    pub project_id: String,
    pub project_name: String,
    pub harness: String,
    pub model: Option<String>,
    pub role: ReviewRole,
    pub prd: String,
    /// Reviews already given this round, in order.
    pub earlier: Vec<RoleReview>,
}

/// Runs one reviewer's turn over the PRD. Saves nothing; the caller keeps the round.
pub fn run_review_step(store: &SqliteStore, args: ReviewStepArgs) -> Result<RoleReview, String> {
    let runtime = crate::provider::runtime_for(store, &args.harness)?;
    let dir = project_dir(&args.project_name, &args.project_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    review_turn(runtime.as_ref(), args.role, &args.prd, &args.earlier, args.model.as_deref(), &dir)
        .map_err(|e| e.to_string())
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
pub fn run_design(store: &SqliteStore, args: DesignArgs) -> Result<DesignResult, String> {
    let runtime = crate::provider::runtime_for(store, &args.harness)?;
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
pub struct BuildStoryArgs {
    pub project_id: String,
    pub project_name: String,
    pub harness: String,
    pub agent_label: String,
    pub model: Option<String>,
    pub prd: String,
    pub story_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildStoryResult {
    pub message: String,
    pub steps: u32,
    pub stopped: Option<StopReason>,
    /// `app/index.html` after the run, whatever the outcome.
    pub html: Option<String>,
}

static BUILDS: Mutex<Option<HashMap<String, Arc<AtomicBool>>>> = Mutex::new(None);

/// Removes the project's entry when the run ends, on any path.
struct RunGuard {
    project_id: String,
    flag: Arc<AtomicBool>,
}

impl std::ops::Deref for RunGuard {
    type Target = AtomicBool;
    fn deref(&self) -> &AtomicBool {
        &self.flag
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        if let Ok(mut builds) = BUILDS.lock() {
            if let Some(map) = builds.as_mut() {
                map.remove(&self.project_id);
            }
        }
    }
}

/// `None` when a build for this project is already running.
fn register(project_id: &str) -> Option<RunGuard> {
    let mut builds = BUILDS.lock().ok()?;
    let map = builds.get_or_insert_with(HashMap::new);
    if map.contains_key(project_id) {
        return None;
    }
    let flag = Arc::new(AtomicBool::new(false));
    map.insert(project_id.to_string(), flag.clone());
    Some(RunGuard { project_id: project_id.to_string(), flag })
}

/// Asks the running build for this project to stop; false when none runs.
pub fn stop_build(project_id: &str) -> bool {
    let builds = BUILDS.lock().ok();
    match builds.as_ref().and_then(|b| b.as_ref()).and_then(|m| m.get(project_id)) {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    }
}

/// Saved Settings per session type id; missing or unreadable = the registry values apply.
pub fn load_harness_settings(store: &SqliteStore) -> HashMap<String, HarnessSettings> {
    store
        .get_app_data("harness")
        .ok()
        .flatten()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

/// Step ids become part of the run-record file name, so only plain characters pass.
fn check_story_id(id: &str) -> Result<(), String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err(format!("{id} is not a step id"));
    }
    Ok(())
}

/// Builds one PRD step into app/index.html with the harness.
pub fn run_build_story(
    store: &SqliteStore,
    args: BuildStoryArgs,
    on_event: &dyn Fn(TaskEvent),
) -> Result<BuildStoryResult, String> {
    check_story_id(&args.story_id)?;
    let dir = project_dir(&args.project_name, &args.project_id);
    std::fs::create_dir_all(dir.join("app")).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let app = dir.join("app").join("index.html");
    if !app.exists() {
        let design = dir.join("design.html");
        if !design.exists() {
            return Err("Approve a prototype before building".into());
        }
        std::fs::copy(&design, &app).map_err(|e| format!("Could not copy the prototype: {e}"))?;
    }

    let session = session_type("build-next-story").ok_or("build-next-story is not in the registry")?;
    let settings = load_harness_settings(store);
    let eff = effective(&session, settings.get(&session.id));
    let runtime = crate::provider::task_runtime_for(store, &args.harness, &args.agent_label, &eff)?;
    let prompt = build_prompt(&args.prd, &args.story_id)?;
    let cancel = register(&args.project_id).ok_or("A step is already being built for this prototype")?;

    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let task = Task {
        system: build_system_prompt(session.write_paths.first().map_or("app/index.html", String::as_str)),
        prompt,
        model: args.model,
        work_dir: dir.clone(),
        write_paths: session.write_paths.clone(),
        max_steps: eff.max_steps,
        timeout: eff.timeout,
        record: Some(dir.join(".panguyuban").join("runs").join(format!("{}-{seconds}.jsonl", args.story_id))),
    };
    let outcome = runtime.run_task(&task, &cancel, on_event).map_err(|e| e.to_string())?;
    Ok(BuildStoryResult {
        message: outcome.message,
        steps: outcome.steps,
        stopped: outcome.stopped,
        html: std::fs::read_to_string(&app).ok(),
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
    fn story_ids_cannot_leave_the_runs_folder() {
        assert!(check_story_id("S1").is_ok() && check_story_id("story_2-a").is_ok());
        for bad in ["../../x", "S1/x", "", "a.b", "a\\b"] {
            assert_eq!(check_story_id(bad).unwrap_err(), format!("{bad} is not a step id"));
        }
    }

    #[test]
    fn one_build_per_project() {
        let first = register("p1").expect("first");
        assert!(register("p1").is_none());
        assert!(stop_build("p1"));
        assert!(!stop_build("p2"));
        assert!(first.load(std::sync::atomic::Ordering::SeqCst));
        drop(first);
        assert!(register("p1").is_some());
    }

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
    fn model_lines_are_parsed_and_noise_skipped() {
        let text = "Fetching available models...\ngemini-4-argon-medium\tGemini 4 Argon (Medium)\nclaude-opus-5-5-high\tClaude Opus 5.5 (High)\n";
        let models = parse_models(text);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "gemini-4-argon-medium");
        assert_eq!(models[1].label, "Claude Opus 5.5 (High)");
    }

    #[test]
    fn both_harnesses_are_reported() {
        let statuses = harness_statuses();
        assert_eq!(statuses.iter().map(|s| s.harness).collect::<Vec<_>>(), HARNESSES);
    }
}
