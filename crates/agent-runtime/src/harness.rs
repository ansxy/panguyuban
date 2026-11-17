//! The agent loop: ask a chat model for its next step, run its tool calls through
//! the attached tools and hooks, send the results back, repeat.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::{cap_output, Hook, RuntimeError, StopReason, Task, TaskEvent, TaskOutcome, TaskRuntime, Tool, ToolResult, Workspace};

const NAME: &str = "provider";

#[derive(Debug)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug)]
pub struct ChatReply {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
}

/// Any model that speaks OpenAI-style chat with tools.
pub trait ChatModel: Send + Sync {
    /// `messages` are OpenAI chat messages; `tools` is the array of attached tool definitions.
    fn chat(&self, messages: &[Value], tools: &Value, model: Option<&str>, timeout: Duration) -> Result<ChatReply, RuntimeError>;
}

pub struct Harness {
    pub chat: Box<dyn ChatModel>,
    pub tools: Vec<Box<dyn Tool>>,
    pub hooks: Vec<Box<dyn Hook>>,
}

/// The JSON-lines run record. A failed write is ignored: it never fails the task.
struct Record(Option<fs::File>);

impl Record {
    fn open(path: Option<&std::path::Path>) -> Record {
        Record(path.and_then(|p| {
            if let Some(dir) = p.parent() {
                fs::create_dir_all(dir).ok()?;
            }
            OpenOptions::new().create(true).append(true).open(p).ok()
        }))
    }
    fn line(&mut self, value: Value) {
        if let Some(f) = &mut self.0 {
            let _ = writeln!(f, "{value}");
        }
    }
}

impl Harness {
    fn call(&self, ws: &Workspace, call: &ToolCall) -> ToolResult {
        let args: Value = match serde_json::from_str(&call.arguments) {
            Ok(v) => v,
            Err(_) => return ToolResult::refused("refused: bad arguments", "arguments are not valid JSON"),
        };
        let Some(tool) = self.tools.iter().find(|t| t.name() == call.name) else {
            let names: Vec<_> = self.tools.iter().map(|t| t.name()).collect();
            return ToolResult::refused(
                format!("refused: unknown tool {}", call.name),
                format!("unknown tool {}; you can use: {}", call.name, names.join(", ")),
            );
        };
        for hook in &self.hooks {
            if let Err(reason) = hook.before(call, &args) {
                return ToolResult::refused(format!("refused by {}", hook.name()), reason);
            }
        }
        let mut result = tool.run(ws, &args);
        for hook in &self.hooks {
            hook.after(call, ws, &mut result);
        }
        result
    }
}

/// The messages of a chat that spans several turns.
#[derive(Default)]
pub struct Conversation {
    messages: Vec<Value>,
}

impl Conversation {
    pub fn new() -> Conversation {
        Conversation::default()
    }
    pub fn is_empty(&self) -> bool {
        self.messages.is_empty()
    }
}

/// Removes a trailing user prompt the model never answered, so the next turn does not send two in a row.
fn drop_unanswered(messages: &mut Vec<Value>) {
    if messages.last().is_some_and(|m| m["role"] == "user") {
        messages.pop();
    }
}

impl TaskRuntime for Harness {
    fn harness(&self) -> &'static str {
        NAME
    }

    fn run_task(&self, task: &Task, cancel: &AtomicBool, on_event: &dyn Fn(TaskEvent)) -> Result<TaskOutcome, RuntimeError> {
        self.run_turn(task, &mut Conversation::new(), cancel, on_event)
    }
}

impl Harness {
    /// One turn: `task.prompt` joins `conversation` (which starts with `task.system` when empty)
    /// and the loop runs until the model answers or a limit stops it. Steps count per turn.
    pub fn run_turn(&self, task: &Task, conversation: &mut Conversation, cancel: &AtomicBool, on_event: &dyn Fn(TaskEvent)) -> Result<TaskOutcome, RuntimeError> {
        let ws = Workspace::new(&task.work_dir, &task.write_paths)
            .map_err(|e| RuntimeError::Failed { harness: NAME, detail: e.to_string() })?;
        let mut record = Record::open(task.record.as_deref());
        record.line(json!({"type": "task", "prompt": task.prompt, "model": task.model,
            "maxSteps": task.max_steps, "writePaths": task.write_paths}));

        let tools: Value = self.tools.iter().map(|t| t.definition()).collect();
        let messages = &mut conversation.messages;
        if messages.is_empty() {
            messages.push(json!({"role": "system", "content": task.system}));
        }
        messages.push(json!({"role": "user", "content": task.prompt}));
        let deadline = Instant::now() + task.timeout;
        let (mut steps, mut last_text) = (0u32, String::new());

        let stopped = 'run: loop {
            if cancel.load(Ordering::Relaxed) {
                break Some(StopReason::Cancelled);
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break Some(StopReason::TimedOut);
            }
            let reply = match self.chat.chat(messages, &tools, task.model.as_deref(), left) {
                Ok(r) => r,
                Err(RuntimeError::TimedOut { .. }) => break Some(StopReason::TimedOut),
                Err(_) if Instant::now() >= deadline => break Some(StopReason::TimedOut),
                Err(e) => {
                    record.line(json!({"type": "error", "detail": e.to_string()}));
                    drop_unanswered(messages);
                    return Err(e);
                }
            };
            record.line(json!({"type": "reply", "text": reply.text,
                "toolCalls": reply.tool_calls.iter().map(|c| json!({"id": c.id, "name": c.name, "arguments": c.arguments})).collect::<Vec<_>>()}));
            if !reply.text.is_empty() {
                last_text = reply.text.clone();
            }
            if reply.tool_calls.is_empty() {
                messages.push(json!({"role": "assistant", "content": reply.text}));
                break None;
            }
            if !reply.text.is_empty() {
                on_event(TaskEvent::Message { text: reply.text.clone() });
            }
            messages.push(json!({"role": "assistant", "content": reply.text,
                "tool_calls": reply.tool_calls.iter().map(|c| json!({"id": c.id, "type": "function",
                    "function": {"name": c.name, "arguments": c.arguments}})).collect::<Vec<_>>()}));

            for (i, call) in reply.tool_calls.iter().enumerate() {
                let stop = if cancel.load(Ordering::Relaxed) {
                    Some(StopReason::Cancelled)
                } else if steps >= task.max_steps {
                    Some(StopReason::MaxSteps)
                } else {
                    None
                };
                if stop.is_some() {
                    // Every tool call needs an answer, or the next turn's request is invalid.
                    for c in &reply.tool_calls[i..] {
                        messages.push(json!({"role": "tool", "tool_call_id": c.id, "content": "not run: the turn was stopped"}));
                    }
                    break 'run stop;
                }
                steps += 1;
                let result = self.call(&ws, call);
                record.line(json!({"type": "tool", "name": call.name, "arguments": call.arguments,
                    "ok": result.ok, "output": result.output}));
                on_event(TaskEvent::Step { tool: call.name.clone(), summary: result.summary, ok: result.ok });
                messages.push(json!({"role": "tool", "tool_call_id": call.id, "content": cap_output(&result.output)}));
            }
        };

        drop_unanswered(messages);
        let outcome = TaskOutcome { message: last_text, steps, stopped };
        record.line(json!({"type": "outcome", "message": outcome.message, "steps": outcome.steps, "stopped": outcome.stopped}));
        Ok(outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{tools_named, NoExternalUrls};
    use std::collections::VecDeque;
    use std::sync::Mutex;

    struct Scripted(Mutex<VecDeque<ChatReply>>, Mutex<Vec<Vec<Value>>>, Mutex<Vec<Value>>);

    impl ChatModel for Scripted {
        fn chat(&self, messages: &[Value], tools: &Value, _m: Option<&str>, _t: Duration) -> Result<ChatReply, RuntimeError> {
            self.1.lock().unwrap().push(messages.to_vec());
            self.2.lock().unwrap().push(tools.clone());
            self.0.lock().unwrap().pop_front().ok_or(RuntimeError::Failed { harness: NAME, detail: "script ran out".into() })
        }
    }

    // The harness owns the model, so share the script through a reference wrapper.
    struct Shared(std::sync::Arc<Scripted>);
    impl ChatModel for Shared {
        fn chat(&self, m: &[Value], t: &Value, model: Option<&str>, d: Duration) -> Result<ChatReply, RuntimeError> {
            self.0.chat(m, t, model, d)
        }
    }

    fn call(id: &str, name: &str, args: Value) -> ToolCall {
        ToolCall { id: id.into(), name: name.into(), arguments: args.to_string() }
    }
    fn calls(cs: Vec<ToolCall>) -> ChatReply {
        ChatReply { text: String::new(), tool_calls: cs }
    }
    fn say(t: &str) -> ChatReply {
        ChatReply { text: t.into(), tool_calls: vec![] }
    }

    const ALL: [&str; 5] = ["read_file", "list_files", "search", "write_file", "edit_file"];

    struct Run {
        _dir: tempfile::TempDir,
        outcome: Result<TaskOutcome, RuntimeError>,
        events: Vec<TaskEvent>,
        sent: Vec<Vec<Value>>,
        tools_seen: Vec<Value>,
        root: std::path::PathBuf,
    }

    fn run_with(replies: Vec<ChatReply>, tools: &[&str], hooks: Vec<Box<dyn Hook>>, max_steps: u32, cancel: bool, record: bool) -> Run {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        fs::write(root.join("prd.md"), "# Orders\n").unwrap();
        fs::create_dir(root.join("app")).unwrap();
        fs::write(root.join("app/index.html"), "<p>total</p>").unwrap();
        fs::write(root.join("big.txt"), "x".repeat(30_000)).unwrap();
        let script = std::sync::Arc::new(Scripted(Mutex::new(replies.into()), Mutex::new(vec![]), Mutex::new(vec![])));
        let h = Harness {
            chat: Box::new(Shared(script.clone())),
            tools: tools_named(&tools.iter().map(|s| s.to_string()).collect::<Vec<_>>()),
            hooks,
        };
        let task = Task {
            system: "SYSTEM".into(),
            prompt: "build".into(),
            model: None,
            work_dir: root.clone(),
            write_paths: vec!["app/index.html".into()],
            max_steps,
            timeout: Duration::from_secs(60),
            record: record.then(|| root.join("runs/run.jsonl")),
        };
        let events = Mutex::new(vec![]);
        let outcome = h.run_task(&task, &AtomicBool::new(cancel), &|e| events.lock().unwrap().push(e));
        let sent = script.1.lock().unwrap().clone();
        let tools_seen = script.2.lock().unwrap().clone();
        Run { _dir: dir, outcome, events: events.into_inner().unwrap(), sent, tools_seen, root }
    }

    fn run(replies: Vec<ChatReply>) -> Run {
        run_with(replies, &ALL, vec![], 40, false, false)
    }

    fn last_tool_content(r: &Run) -> String {
        r.sent.last().unwrap().last().unwrap()["content"].as_str().unwrap().to_string()
    }

    #[test]
    fn finishes_when_the_model_stops_calling_tools() {
        let r = run(vec![
            calls(vec![call("1", "write_file", json!({"path": "app/index.html", "content": "<p>orders</p>"}))]),
            say("Built S1"),
        ]);
        let o = r.outcome.unwrap();
        assert_eq!((o.message.as_str(), o.steps, o.stopped), ("Built S1", 1, None));
        assert_eq!(fs::read_to_string(r.root.join("app/index.html")).unwrap(), "<p>orders</p>");
        assert!(matches!(r.events.as_slice(), [TaskEvent::Step { tool, ok: true, .. }] if tool == "write_file"));
    }

    #[test]
    fn refusals_go_back_to_the_model() {
        let r = run(vec![calls(vec![call("1", "write_file", json!({"path": "prd.md", "content": "x"}))]), say("ok")]);
        let last = r.sent.last().unwrap().last().unwrap();
        assert_eq!(last["role"], "tool");
        assert!(last["content"].as_str().unwrap().contains("app/index.html"));
        assert_eq!(r.outcome.unwrap().stopped, None);
    }

    #[test]
    fn several_calls_in_one_reply_each_get_a_result() {
        let r = run(vec![
            calls(vec![call("a", "read_file", json!({"path": "prd.md"})), call("b", "list_files", json!({"pattern": "*"}))]),
            say("done"),
        ]);
        let msgs = r.sent.last().unwrap();
        let ids: Vec<_> = msgs.iter().filter(|m| m["role"] == "tool").map(|m| m["tool_call_id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["a", "b"]);
    }

    #[test]
    fn stops_at_max_steps() {
        let replies = (0..5).map(|i| calls(vec![call(&i.to_string(), "read_file", json!({"path": "prd.md"}))])).collect();
        let o = run_with(replies, &ALL, vec![], 2, false, false).outcome.unwrap();
        assert_eq!((o.stopped, o.steps), (Some(StopReason::MaxSteps), 2));
    }

    #[test]
    fn cancel_stops_before_the_next_call() {
        let r = run_with(vec![say("hi")], &ALL, vec![], 40, true, false);
        assert!(r.sent.is_empty());
        let o = r.outcome.unwrap();
        assert_eq!((o.stopped, o.steps), (Some(StopReason::Cancelled), 0));
    }

    struct Broken(fn() -> RuntimeError, std::sync::atomic::AtomicU32);
    impl ChatModel for Broken {
        fn chat(&self, _m: &[Value], _t: &Value, _model: Option<&str>, _d: Duration) -> Result<ChatReply, RuntimeError> {
            self.1.fetch_add(1, Ordering::Relaxed);
            Err((self.0)())
        }
    }

    fn run_broken(err: fn() -> RuntimeError, timeout: Duration) -> (Result<TaskOutcome, RuntimeError>, Vec<Value>, u32) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let model = std::sync::Arc::new(Broken(err, 0.into()));
        struct W(std::sync::Arc<Broken>);
        impl ChatModel for W {
            fn chat(&self, m: &[Value], t: &Value, model: Option<&str>, d: Duration) -> Result<ChatReply, RuntimeError> {
                self.0.chat(m, t, model, d)
            }
        }
        let h = Harness { chat: Box::new(W(model.clone())), tools: vec![], hooks: vec![] };
        let task = Task {
            system: "S".into(), prompt: "p".into(), model: None, work_dir: root.clone(),
            write_paths: vec![], max_steps: 5, timeout, record: Some(root.join("runs/run.jsonl")),
        };
        let out = h.run_task(&task, &AtomicBool::new(false), &|_| {});
        let text = fs::read_to_string(root.join("runs/run.jsonl")).unwrap();
        let lines = text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        (out, lines, model.1.load(Ordering::Relaxed))
    }

    #[test]
    fn a_timeout_inside_the_model_call_stops_the_run() {
        let (out, lines, _) = run_broken(|| RuntimeError::TimedOut { harness: NAME, seconds: 1 }, Duration::from_secs(60));
        assert_eq!(out.unwrap().stopped, Some(StopReason::TimedOut));
        assert_eq!(lines.last().unwrap()["type"], "outcome");
    }

    #[test]
    fn other_model_errors_are_recorded_and_fail() {
        let (out, lines, _) = run_broken(|| RuntimeError::Failed { harness: NAME, detail: "boom".into() }, Duration::from_secs(60));
        assert!(out.is_err());
        let last = lines.last().unwrap();
        assert_eq!(last["type"], "error");
        assert!(last["detail"].as_str().unwrap().contains("boom"));
    }

    #[test]
    fn zero_timeout_never_calls_the_model() {
        let (out, _, calls) = run_broken(|| RuntimeError::Failed { harness: NAME, detail: "x".into() }, Duration::ZERO);
        assert_eq!(out.unwrap().stopped, Some(StopReason::TimedOut));
        assert_eq!(calls, 0);
    }

    #[test]
    fn model_errors_fail_the_task() {
        assert!(run(vec![]).outcome.is_err());
    }

    #[test]
    fn the_record_has_every_tool_result_in_full() {
        let r = run_with(
            vec![calls(vec![call("1", "read_file", json!({"path": "big.txt"}))]), say("done")],
            &ALL, vec![], 40, false, true,
        );
        assert!(last_tool_content(&r).ends_with("[output cut: 10000 more characters]"));
        let text = fs::read_to_string(r.root.join("runs/run.jsonl")).unwrap();
        let lines: Vec<Value> = text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        let types: Vec<_> = lines.iter().map(|l| l["type"].as_str().unwrap()).collect();
        assert_eq!(types, ["task", "reply", "tool", "reply", "outcome"]);
        assert!(lines[0].get("system").is_none() && !text.contains("SYSTEM"));
        let tool = lines.iter().find(|l| l["type"] == "tool").unwrap();
        assert_eq!(tool["output"].as_str().unwrap().chars().count(), 30_000);
    }

    #[test]
    fn only_attached_tools_are_offered() {
        let r = run_with(vec![say("hi")], &["read_file"], vec![], 40, false, false);
        let offered = r.tools_seen[0].as_array().unwrap();
        assert_eq!(offered.len(), 1);
        assert_eq!(offered[0]["function"]["name"], "read_file");
    }

    #[test]
    fn detached_tools_are_refused() {
        let r = run_with(
            vec![calls(vec![call("1", "write_file", json!({"path": "app/index.html", "content": "x"}))]), say("ok")],
            &["read_file"], vec![], 40, false, false,
        );
        let content = last_tool_content(&r);
        assert!(content.contains("unknown tool write_file") && content.contains("read_file"));
        assert!(matches!(r.events.as_slice(), [TaskEvent::Step { ok: false, .. }]));
        assert_eq!(r.outcome.unwrap().stopped, None);
    }

    #[test]
    fn bad_json_arguments_are_refused() {
        let bad = ToolCall { id: "1".into(), name: "read_file".into(), arguments: "not json".into() };
        let r = run(vec![calls(vec![bad]), say("ok")]);
        assert!(last_tool_content(&r).contains("not valid JSON"));
        assert!(matches!(r.events.as_slice(), [TaskEvent::Step { ok: false, .. }]));
    }

    struct NoEdits;
    impl Hook for NoEdits {
        fn name(&self) -> &'static str {
            "no_edits"
        }
        fn before(&self, call: &ToolCall, _args: &Value) -> Result<(), String> {
            if call.name == "edit_file" { Err("no edits today".into()) } else { Ok(()) }
        }
    }

    #[test]
    fn hooks_can_refuse_and_annotate() {
        let edit = call("1", "edit_file", json!({"path": "app/index.html", "old": "total", "new": "sum"}));
        let r = run_with(vec![calls(vec![edit]), say("ok")], &ALL, vec![Box::new(NoEdits)], 40, false, false);
        assert!(last_tool_content(&r).contains("no edits today"));
        assert_eq!(fs::read_to_string(r.root.join("app/index.html")).unwrap(), "<p>total</p>");

        let write = |c: &str| {
            let w = call("1", "write_file", json!({"path": "app/index.html", "content": c}));
            last_tool_content(&run_with(vec![calls(vec![w]), say("ok")], &ALL, vec![Box::new(NoExternalUrls)], 40, false, false))
        };
        assert!(write("<img src=\"https://x\">").contains("The preview blocks them"));
        assert!(!write("<p>plain</p>").contains("The preview blocks them"));
    }

    #[test]
    fn a_conversation_carries_over_between_turns() {
        let dir = tempfile::tempdir().unwrap();
        let script = std::sync::Arc::new(Scripted(Mutex::new(vec![say("Hi"), say("Again")].into()), Mutex::new(vec![]), Mutex::new(vec![])));
        let h = Harness { chat: Box::new(Shared(script.clone())), tools: vec![], hooks: vec![] };
        let mut task = Task {
            system: "SYSTEM".into(),
            prompt: "one".into(),
            model: None,
            work_dir: dir.path().to_path_buf(),
            write_paths: vec![],
            max_steps: 5,
            timeout: Duration::from_secs(60),
            record: None,
        };
        let mut conv = Conversation::new();
        assert!(conv.is_empty());
        h.run_turn(&task, &mut conv, &AtomicBool::new(false), &|_| {}).unwrap();
        task.prompt = "two".into();
        h.run_turn(&task, &mut conv, &AtomicBool::new(false), &|_| {}).unwrap();
        let sent = script.1.lock().unwrap().clone();
        let roles: Vec<_> = sent[1].iter().map(|m| (m["role"].as_str().unwrap(), m["content"].as_str().unwrap())).collect();
        assert_eq!(roles, vec![("system", "SYSTEM"), ("user", "one"), ("assistant", "Hi"), ("user", "two")]);
    }

    #[test]
    fn a_failed_chat_drops_the_unanswered_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let script = std::sync::Arc::new(Scripted(Mutex::new(VecDeque::new()), Mutex::new(vec![]), Mutex::new(vec![])));
        let h = Harness { chat: Box::new(Shared(script.clone())), tools: vec![], hooks: vec![] };
        let mut task = Task {
            system: "SYSTEM".into(),
            prompt: "one".into(),
            model: None,
            work_dir: dir.path().to_path_buf(),
            write_paths: vec![],
            max_steps: 5,
            timeout: Duration::from_secs(60),
            record: None,
        };
        let mut conv = Conversation::new();
        assert!(h.run_turn(&task, &mut conv, &AtomicBool::new(false), &|_| {}).is_err());
        script.0.lock().unwrap().push_back(say("Hi"));
        task.prompt = "two".into();
        h.run_turn(&task, &mut conv, &AtomicBool::new(false), &|_| {}).unwrap();
        let sent = script.1.lock().unwrap().clone();
        let roles: Vec<_> = sent[1].iter().map(|m| (m["role"].as_str().unwrap(), m["content"].as_str().unwrap())).collect();
        assert_eq!(roles, vec![("system", "SYSTEM"), ("user", "two")]);
    }
}
