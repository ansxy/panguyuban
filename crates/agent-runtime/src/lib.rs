//! Drives a coding agent's command-line tool for one turn at a time.
//!
//! Every turn is stateless: the full instructions and the conversation so far go
//! in, the agent's next message comes out. Nothing depends on a harness keeping a
//! session, so the same conversation can move between agents.
//!
//! Only the PRD interview is connected. In it the agent gets no tools; it returns
//! the PRD as text and the app saves the file.

mod antigravity;
mod claude;
mod process;

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

pub use antigravity::AntigravityRuntime;
pub use claude::ClaudeRuntime;

/// The interview skill and its template ship inside the binary.
const INTERVIEW_SKILL: &str = include_str!("../../../skills/product/prd-interview/SKILL.md");
const PRD_TEMPLATE: &str = include_str!("../../../skills/product/prd-interview/templates/prd.md");

const DESIGN_SKILL: &str = include_str!("../../../skills/product/html-prototype/SKILL.md");
const PLAN_SKILL: &str = include_str!("../../../skills/product/prd-to-stories/SKILL.md");
const REGISTRY: &str = include_str!("../../../skills/registry.toml");

const PRD_OPEN: &str = "<prd>";
const PRD_CLOSE: &str = "</prd>";
const DESIGN_OPEN: &str = "<design>";
const DESIGN_CLOSE: &str = "</design>";
const PLAN_OPEN: &str = "<plan>";
const PLAN_CLOSE: &str = "</plan>";

#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    #[error("{harness} is not installed or not on the PATH")]
    NotInstalled { harness: &'static str },
    #[error("{harness} did not answer within {seconds} seconds")]
    TimedOut { harness: &'static str, seconds: u64 },
    #[error("{harness} failed: {detail}")]
    Failed { harness: &'static str, detail: String },
    #[error("unknown agent harness: {0}")]
    UnknownHarness(String),
}

/// One coding agent that can be run from the command line.
pub trait AgentRuntime: Send + Sync {
    fn harness(&self) -> &'static str;

    /// Whether the agent's command-line tool can be found on this machine.
    fn is_available(&self) -> bool;

    /// Runs one turn with no tools and returns the agent's text.
    fn complete(
        &self,
        system: &str,
        prompt: &str,
        model: Option<&str>,
        work_dir: &Path,
        timeout: Duration,
    ) -> Result<String, RuntimeError>;
}

pub fn runtime_for(harness: &str) -> Result<Box<dyn AgentRuntime>, RuntimeError> {
    match harness {
        "claude" => Ok(Box::new(ClaudeRuntime)),
        "antigravity" => Ok(Box::new(AntigravityRuntime)),
        other => Err(RuntimeError::UnknownHarness(other.to_string())),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Speaker {
    Agent,
    User,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Turn {
    pub from: Speaker,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct InterviewRequest {
    pub project_name: String,
    pub client: String,
    pub author: String,
    /// Everything said so far, oldest first. Empty when the user wrote nothing yet.
    pub transcript: Vec<Turn>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InterviewReply {
    /// What the agent says to the user, without the PRD.
    pub message: String,
    /// The full PRD when the agent produced or revised one this turn.
    pub prd: Option<String>,
}

const INTERVIEW_TIMEOUT: Duration = Duration::from_secs(240);

/// Asks the agent for its next interview message.
pub fn interview_turn(
    runtime: &dyn AgentRuntime,
    request: &InterviewRequest,
    work_dir: &Path,
) -> Result<InterviewReply, RuntimeError> {
    let raw = runtime.complete(
        &interview_system_prompt(),
        &interview_prompt(request),
        request.model.as_deref(),
        work_dir,
        INTERVIEW_TIMEOUT,
    )?;
    Ok(split_reply(&raw))
}

/// The interview skill, the PRD template, and how this runtime differs from the
/// skill's own wording (no tools, PRD returned as text).
pub fn interview_system_prompt() -> String {
    format!(
        "{skill}\n\n---\n\n\
## How this session runs\n\n\
These rules replace anything above that says otherwise.\n\n\
- You have no tools. You cannot read, write or run anything. Never say you saved or wrote a file.\n\
- Each message you receive holds the whole conversation so far. Reply with only your next message to the user: no preamble, no role label.\n\
- When you have everything you need, put the complete PRD between a line containing only `{open}` and a line containing only `{close}`. The app saves it as `prd.md`. Follow the template below exactly, keep its headings in English, and number stories `### S1. <name>`, `### S2. <name>`.\n\
- Outside those tags, give the short summary from section 5 and ask whether it is right. Do not repeat the PRD outside the tags.\n\
- If the user corrects something afterwards, send the whole updated PRD again inside the tags.\n\
- Leave `Status: Draft`. Approval is a button in the app. Never mark the PRD approved yourself.\n\n\
## PRD template\n\n{template}",
        skill = strip_frontmatter(INTERVIEW_SKILL).trim(),
        open = PRD_OPEN,
        close = PRD_CLOSE,
        template = PRD_TEMPLATE.trim(),
    )
}

/// `library_version` from the skill registry, recorded in every PRD.
pub fn library_version() -> &'static str {
    REGISTRY
        .lines()
        .find_map(|line| line.trim().strip_prefix("library_version"))
        .and_then(|rest| rest.split('"').nth(1))
        .unwrap_or("unknown")
}

/// The conversation so far, as the single message the agent receives.
pub fn interview_prompt(request: &InterviewRequest) -> String {
    let mut out = format!(
        "Prototype: {}\nClient: {}\nUser: {}\nSkill library version: {}\n\n",
        request.project_name.trim(),
        request.client.trim(),
        request.author.trim(),
        library_version()
    );
    if request.transcript.is_empty() {
        out.push_str(
            "The user has just opened the prototype and has written nothing yet. Start the interview.",
        );
        return out;
    }
    out.push_str("Conversation so far:\n\n");
    for turn in &request.transcript {
        let who = match turn.from {
            Speaker::Agent => "You",
            Speaker::User => "User",
        };
        out.push_str(&format!("[{who}]\n{}\n\n", turn.text.trim()));
    }
    out.push_str("Write your next message to the user.");
    out
}

/// Separates the PRD (between the tags) from what is said to the user.
pub fn split_reply(raw: &str) -> InterviewReply {
    let (message, prd) = split_tagged(raw, PRD_OPEN, PRD_CLOSE);
    InterviewReply { message, prd }
}

/// Splits a reply into what is said to the user and the document between `open` and `close`.
fn split_tagged(raw: &str, open: &str, close: &str) -> (String, Option<String>) {
    let text = raw.trim();
    let Some(start) = text.find(open) else {
        return (text.to_string(), None);
    };
    let after_open = start + open.len();
    // The last closing tag, so a document that mentions the tag in its own text stays whole.
    let (body, rest) = match text[after_open..].rfind(close) {
        Some(end) => (
            &text[after_open..after_open + end],
            &text[after_open + end + close.len()..],
        ),
        // No closing tag: the reply was cut off. Keep what arrived.
        None => (&text[after_open..], ""),
    };
    let message = [text[..start].trim(), rest.trim()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let body = strip_code_fence(body.trim());
    (message, (!body.is_empty()).then(|| body.to_string()))
}

/// Drops a Markdown code fence wrapped around a whole document.
fn strip_code_fence(body: &str) -> &str {
    let Some(rest) = body.strip_prefix("```") else {
        return body;
    };
    let Some(inner) = rest.strip_suffix("```") else {
        return body;
    };
    match inner.find('\n') {
        Some(newline) => inner[newline + 1..].trim(),
        None => body,
    }
}

#[derive(Debug, Clone)]
pub struct DesignRequest {
    /// The approved PRD.
    pub prd: String,
    /// The prototype being revised, if there is one.
    pub current: Option<String>,
    /// What the user asked to change, oldest first. Empty for the first proposal.
    pub changes: Vec<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DesignReply {
    pub message: String,
    /// The whole prototype as one HTML document.
    pub html: String,
}

const DESIGN_TIMEOUT: Duration = Duration::from_secs(420);

/// Asks the agent for the working HTML prototype of an approved PRD, or for a revision of the current one.
pub fn design_turn(
    runtime: &dyn AgentRuntime,
    request: &DesignRequest,
    work_dir: &Path,
) -> Result<DesignReply, RuntimeError> {
    let system = format!(
        "{}\n\n---\n\nYou have no tools. You cannot read, write or run anything. Everything you need is in the message, and the app saves the file you send back.",
        strip_frontmatter(DESIGN_SKILL).trim()
    );
    let raw = runtime.complete(&system, &design_prompt(request), request.model.as_deref(), work_dir, DESIGN_TIMEOUT)?;
    let (message, html) = split_tagged(&raw, DESIGN_OPEN, DESIGN_CLOSE);
    match html {
        Some(html) if html.to_lowercase().contains("<html") || html.to_lowercase().contains("<body") => {
            Ok(DesignReply { message, html })
        }
        _ => Err(RuntimeError::Failed {
            harness: runtime.harness(),
            detail: "it did not send a prototype".into(),
        }),
    }
}

pub fn design_prompt(request: &DesignRequest) -> String {
    let mut out = format!("Approved PRD:\n\n{}\n\n", request.prd.trim());
    match request.current.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        Some(current) => {
            out.push_str(&format!("Current prototype:\n\n{DESIGN_OPEN}\n{current}\n{DESIGN_CLOSE}\n\n"));
            out.push_str("The user asked for these changes, oldest first. Earlier ones are already in the prototype; apply the last one:\n\n");
            for change in &request.changes {
                out.push_str(&format!("- {}\n", change.trim()));
            }
            out.push_str("\nSend the whole updated prototype.");
        }
        None => out.push_str("Build the prototype."),
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StepSize {
    Small,
    Hard,
}

/// The plan for one step of the PRD.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StepPlan {
    pub id: String,
    pub size: StepSize,
    #[serde(default)]
    pub needs_engineer: bool,
    #[serde(default)]
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Plan {
    #[serde(default)]
    pub summary: String,
    pub steps: Vec<StepPlan>,
}

const PLAN_TIMEOUT: Duration = Duration::from_secs(180);

/// Asks the agent to size each step of an approved PRD and flag the ones an engineer must clear.
pub fn plan_turn(
    runtime: &dyn AgentRuntime,
    prd: &str,
    model: Option<&str>,
    work_dir: &Path,
) -> Result<Plan, RuntimeError> {
    let system = format!(
        "{}\n\n---\n\nYou have no tools. You cannot read, write or run anything. The approved PRD is in the message.",
        strip_frontmatter(PLAN_SKILL).trim()
    );
    let prompt = format!("Approved PRD:\n\n{}\n\nSend the plan.", prd.trim());
    let raw = runtime.complete(&system, &prompt, model, work_dir, PLAN_TIMEOUT)?;
    parse_plan(&raw).map_err(|detail| RuntimeError::Failed {
        harness: runtime.harness(),
        detail: format!("its plan could not be read ({detail})"),
    })
}

/// Reads the plan from between the tags, or from the whole reply if the tags are missing.
pub fn parse_plan(raw: &str) -> Result<Plan, String> {
    let text = raw.trim();
    let body = match text.find(PLAN_OPEN) {
        Some(start) => {
            let after = &text[start + PLAN_OPEN.len()..];
            after.find(PLAN_CLOSE).map_or(after, |end| &after[..end])
        }
        None => text,
    };
    // Tolerate a code fence around the JSON.
    let json = match (body.find('{'), body.rfind('}')) {
        (Some(start), Some(end)) if start < end => &body[start..=end],
        _ => return Err("no plan in the reply".into()),
    };
    let mut plan: Plan = serde_json::from_str(json).map_err(|e| e.to_string())?;
    for step in &mut plan.steps {
        step.id = step.id.trim().to_uppercase();
        step.reason = step.reason.trim().to_string();
    }
    plan.steps.retain(|step| !step.id.is_empty());
    if plan.steps.is_empty() {
        return Err("the plan lists no steps".into());
    }
    plan.summary = plan.summary.trim().to_string();
    Ok(plan)
}

fn strip_frontmatter(skill: &str) -> &str {
    let Some(rest) = skill.strip_prefix("---") else {
        return skill;
    };
    match rest.find("\n---") {
        Some(end) => rest[end + 4..].trim_start_matches(['\r', '\n']),
        None => skill,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(transcript: Vec<Turn>) -> InterviewRequest {
        InterviewRequest {
            project_name: "Claims demo".into(),
            client: "Acme".into(),
            author: "Dewi".into(),
            transcript,
            model: None,
        }
    }

    #[test]
    fn system_prompt_carries_the_skill_without_frontmatter_and_the_template() {
        let prompt = interview_system_prompt();
        assert!(prompt.starts_with("# PRD Interview"));
        assert!(!prompt.contains("name: prd-interview"));
        assert!(prompt.contains("One question per message"));
        assert!(prompt.contains("## 11. Decisions and scope changes"));
        assert!(prompt.contains("You have no tools"));
    }

    #[test]
    fn prompt_for_an_empty_conversation_asks_the_agent_to_start() {
        let prompt = interview_prompt(&request(vec![]));
        assert!(prompt.contains("Client: Acme"));
        assert!(prompt.contains(&format!("Skill library version: {}", library_version())));
        assert_ne!(library_version(), "unknown");
        assert!(prompt.ends_with("Start the interview."));
    }

    #[test]
    fn prompt_lists_the_conversation_in_order() {
        let prompt = interview_prompt(&request(vec![
            Turn { from: Speaker::User, text: "A claims dashboard".into() },
            Turn { from: Speaker::Agent, text: "When is the demo?".into() },
            Turn { from: Speaker::User, text: " Friday ".into() },
        ]));
        let first = prompt.find("[User]\nA claims dashboard").unwrap();
        let second = prompt.find("[You]\nWhen is the demo?").unwrap();
        let third = prompt.find("[User]\nFriday").unwrap();
        assert!(first < second && second < third);
    }

    #[test]
    fn reply_without_a_prd_is_passed_through() {
        let reply = split_reply("  When is the demo?\n");
        assert_eq!(reply, InterviewReply { message: "When is the demo?".into(), prd: None });
    }

    #[test]
    fn reply_with_a_prd_is_split_from_the_message() {
        let reply = split_reply("Here is the summary.\n<prd>\n# PRD: Claims\n\nStatus: Draft\n</prd>\nIs this right?");
        assert_eq!(reply.message, "Here is the summary.\n\nIs this right?");
        assert_eq!(reply.prd.as_deref(), Some("# PRD: Claims\n\nStatus: Draft"));
    }

    #[test]
    fn cut_off_prd_is_kept_and_empty_prd_is_ignored() {
        let cut = split_reply("Summary\n<prd>\n# PRD: Claims");
        assert_eq!(cut.prd.as_deref(), Some("# PRD: Claims"));
        let empty = split_reply("Summary <prd>  </prd>");
        assert_eq!(empty, InterviewReply { message: "Summary".into(), prd: None });
    }

    #[test]
    fn unknown_harness_is_rejected() {
        assert!(matches!(runtime_for("hermes"), Err(RuntimeError::UnknownHarness(_))));
        assert_eq!(runtime_for("claude").unwrap().harness(), "claude");
        assert_eq!(runtime_for("antigravity").unwrap().harness(), "antigravity");
    }

    #[test]
    fn design_reply_keeps_the_whole_document_and_drops_a_code_fence() {
        let (message, html) = split_tagged(
            "Four screens.\n<design>\n```html\n<!doctype html><html><body><p>use </design> here</p></body></html>\n```\n</design>",
            DESIGN_OPEN,
            DESIGN_CLOSE,
        );
        assert_eq!(message, "Four screens.");
        assert_eq!(html.as_deref(), Some("<!doctype html><html><body><p>use </design> here</p></body></html>"));
    }

    #[test]
    fn design_prompt_asks_for_a_proposal_first_and_a_revision_after() {
        let first = design_prompt(&DesignRequest { prd: "# PRD".into(), current: None, changes: vec![], model: None });
        assert!(first.ends_with("Build the prototype."));
        let revision = design_prompt(&DesignRequest {
            prd: "# PRD".into(),
            current: Some("<html></html>".into()),
            changes: vec!["Bigger title".into(), "Blue button".into()],
            model: None,
        });
        assert!(revision.contains("<design>\n<html></html>\n</design>"));
        assert!(revision.find("- Bigger title").unwrap() < revision.find("- Blue button").unwrap());
        assert!(revision.ends_with("Send the whole updated prototype."));
    }

    /// Talks to the real Claude Code. Run with `cargo test -p agent-runtime -- --ignored`.
    #[test]
    #[ignore]
    fn live_claude_prototype_is_one_working_file_with_no_way_out() {
        let dir = std::env::temp_dir().join("panguyuban-live-test");
        std::fs::create_dir_all(&dir).unwrap();
        let prd = std::fs::read_to_string(std::env::var("PANGUYUBAN_TEST_PRD").expect("PANGUYUBAN_TEST_PRD")).unwrap();
        let reply = design_turn(&ClaudeRuntime, &DesignRequest { prd, current: None, changes: vec![], model: None }, &dir).unwrap();
        println!("--- message ---\n{}\n--- {} bytes of html ---", reply.message, reply.html.len());
        if let Ok(out) = std::env::var("PANGUYUBAN_TEST_OUT") {
            std::fs::write(out, &reply.html).unwrap();
        }
        let lower = reply.html.to_lowercase();
        assert!(lower.contains("<html"));
        assert!(lower.contains("<script"));
        assert!(!lower.contains("http://") && !lower.contains("https://"));
        for banned in ["fetch(", "xmlhttprequest", "localstorage", "sessionstorage", "indexeddb", "websocket", "window.open"] {
            assert!(!lower.contains(banned), "uses {banned}");
        }
        for step in ["S1", "S2", "S3", "S4"] {
            assert!(reply.html.contains(step), "missing {step}");
        }
        assert!(!reply.message.to_lowercase().contains("html"));
    }

    #[test]
    fn plan_is_read_from_the_tags_with_ids_normalised() {
        let plan = parse_plan(
            "<plan>\n{\"summary\": \" Two steps. \", \"steps\": [\n {\"id\": \"s1\", \"size\": \"small\", \"needs_engineer\": false, \"reason\": \"One screen.\"},\n {\"id\": \"S2\", \"size\": \"hard\", \"needs_engineer\": true, \"reason\": \" Real sign-in. \"}\n]}\n</plan>",
        )
        .unwrap();
        assert_eq!(plan.summary, "Two steps.");
        assert_eq!(plan.steps[0], StepPlan { id: "S1".into(), size: StepSize::Small, needs_engineer: false, reason: "One screen.".into() });
        assert_eq!(plan.steps[1].size, StepSize::Hard);
        assert!(plan.steps[1].needs_engineer);
        assert_eq!(plan.steps[1].reason, "Real sign-in.");
    }

    #[test]
    fn plan_without_tags_or_inside_a_code_fence_is_still_read() {
        let plan = parse_plan("```json\n{\"steps\": [{\"id\": \"S1\", \"size\": \"small\"}]}\n```").unwrap();
        assert_eq!(plan.steps.len(), 1);
        assert!(!plan.steps[0].needs_engineer);
        assert_eq!(plan.summary, "");
    }

    #[test]
    fn unreadable_or_empty_plans_are_errors() {
        assert!(parse_plan("I think S1 is small.").is_err());
        assert!(parse_plan("<plan>{\"steps\": []}</plan>").is_err());
        assert!(parse_plan("<plan>{\"steps\": [{\"id\": \"S1\", \"size\": \"medium\"}]}</plan>").is_err());
    }

    /// Talks to the real Claude Code. Run with `cargo test -p agent-runtime -- --ignored`.
    #[test]
    #[ignore]
    fn live_claude_plan_sizes_steps_and_flags_real_systems() {
        let dir = std::env::temp_dir().join("panguyuban-live-test");
        std::fs::create_dir_all(&dir).unwrap();
        let prd = "# PRD: Claims demo\n\nStatus: Approved\n\n## 4. Stories\n\n### S1. Open the claims list\n\nAcceptance criteria:\n- [ ] The list shows 20 sample claims with number, member, status and days open.\n\n### S2. Approve or reject a claim\n\nAcceptance criteria:\n- [ ] A manager can approve or reject a submitted claim, and an officer cannot.\n- [ ] The claim's status and history update on every screen that shows it.\n\n### S3. Sign in with the client's company account\n\nAcceptance criteria:\n- [ ] The user signs in through the client's real single sign-on.\n\n## 5. Scope\n\n### Later\n- Export\n\n## 6. Real or pretend\n\n| Information or action | Real in the demo | Pretend | Note |\n|---|---|---|---|\n| Claims list | x | | sample data |\n| Approve or reject | x | | sample data |\n| Sign in | x | | uses the client's real accounts |\n";
        let plan = plan_turn(&ClaudeRuntime, prd, None, &dir).unwrap();
        println!("{plan:#?}");
        assert_eq!(plan.steps.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["S1", "S2", "S3"]);
        assert_eq!(plan.steps[0].size, StepSize::Small);
        assert!(!plan.steps[0].needs_engineer);
        assert_eq!(plan.steps[1].size, StepSize::Hard);
        assert!(!plan.steps[1].needs_engineer);
        assert!(plan.steps[2].needs_engineer);
        assert!(plan.steps.iter().all(|s| !s.reason.is_empty()));
    }

    /// Talks to the real Claude Code. Run with `cargo test -p agent-runtime -- --ignored`.
    #[test]
    #[ignore]
    fn live_claude_interview_asks_a_question_then_writes_a_prd() {
        let dir = std::env::temp_dir().join("panguyuban-live-test");
        std::fs::create_dir_all(&dir).unwrap();
        let runtime = ClaudeRuntime;
        assert!(runtime.is_available());

        let opening = interview_turn(&runtime, &request(vec![]), &dir).unwrap();
        println!("--- opening ---\n{}", opening.message);
        assert!(opening.prd.is_none());
        assert!(opening.message.contains('?'));

        let full = "Demo: quarterly review with Acme ops on 20 Nov.\nProblem: they cannot see where a claim is stuck.\nUsers: claims officer finds stuck claims; manager sees totals.\nSteps:\n1. Open the claims list\n2. Filter by status\n3. Open one claim and see its history\nData: claim number, member name, status, amount, days open.\nReal or pretend: list and filter must work; history can be pretend.\nLater: export to Excel.\nPromises: none.\nLanguage: English only, no branding.\nThat is everything, please write the PRD now.";
        let reply = interview_turn(
            &runtime,
            &request(vec![Turn { from: Speaker::User, text: full.into() }]),
            &dir,
        )
        .unwrap();
        println!("--- message ---\n{}\n--- prd ---\n{}", reply.message, reply.prd.clone().unwrap_or_default());
        let prd = reply.prd.expect("a PRD for a complete description");
        assert!(prd.contains("### S1."));
        assert!(prd.contains("Status: Draft"));
        assert!(prd.contains("## 5. Scope"));
    }
}
