# Agent Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Panguyuban's own tool-using agent loop over any saved provider, used by the guided builder's Build stage to build one story at a time into `app/index.html`.

**Architecture:** `crates/agent-runtime` gets a `TaskRuntime` contract, a fixed `Workspace` (folder boundary + write paths), plug-in `Tool`s and `Hook`s looked up by name, and a `Harness` loop that drives any `ChatModel` with whichever tools and hooks it is given. Which ones a session gets = the registry's ceiling narrowed by the user's Agent harness settings. The desktop app implements `ChatModel` over the existing OpenAI-compatible provider, exposes a `builder_build_story` Tauri command that streams `TaskEvent`s over a `tauri::ipc::Channel`, and the React Build stage shows live steps, a Stop button and the built app in the existing locked preview.

**Tech Stack:** Rust (agent-runtime crate, Tauri 2.12), serde_json, toml 0.8, glob 0.3, walkdir 2, tempfile 3 (tests); React 18 + TypeScript, `@tauri-apps/api` 2 (Channel only); node `*.check.mjs` checks.

**Spec:** `docs/superpowers/specs/2026-11-17-agent-harness-design.md`

## Global Constraints

- Agent writes only `app/index.html` in v1 (`write_paths = ["app/index.html"]` in `skills/registry.toml`); `shell = false`; no command tool exists.
- Every tool path: relative to the project folder, no `..` component, not absolute, and its nearest existing ancestor canonicalizes inside the canonical project folder (symlinks cannot escape).
- Tool output sent to the model is capped at 20 000 characters with a trailing note `\n[output cut: N more characters]`; the run record keeps the full output.
- Registry ceiling for `build-next-story`: `tools = ["read_file", "list_files", "search", "write_file", "edit_file"]`, `hooks = ["no_external_urls"]`, `max_steps = 40`, `timeout_minutes = 15`.
- Settings narrow only, enforced in Rust: tools/hooks = registry ∩ saved; limits clamped to `1..=registry value`; unknown names ignored; nothing saved = registry values. `Workspace` checks and the run record are never switchable.
- Provider keys never leave Rust (as today).
- Refused tool calls are tool results, not errors; the loop continues.
- Exact user-facing copy: `This model or provider does not support tools; pick another model` and `Building with {label} is not supported yet; pick a provider agent`.
- Repo rule: no employer names or healthcare/insurance sample data; test data uses neutral names (orders, customers). Commits use `ansxy@users.noreply.github.com`.
- `cargo test -p agent-runtime` and `cargo test -p panguyuban-desktop` must pass after every Rust task; `npm run build` (from `apps/panguyuban-desktop`) after every frontend task.

## Review Focus

1. A model that sends malformed tool arguments (not JSON, missing field) → a refused tool result naming the problem, never a panic. Test in Task 2 (`bad_arguments_are_refused_not_fatal`).
2. A model that asks for several tool calls in one reply → each runs in order, each gets its own `tool` message with the matching `tool_call_id`. Test in Task 3 (`several_calls_in_one_reply_each_get_a_result`).
3. A provider reply with `content: null` and tool calls, or text and no tool calls → parsed without error. Test in Task 4 (`tool_replies_are_parsed`).
4. The user reloads the window or leaves the project mid-run → the Rust run keeps going until it ends, and Stop (by project id) still stops it; a second build for the same project while one runs is refused. Test in Task 5 (`one_build_per_project`).
5. `edit_file` where `old` appears twice or not at all → refused with which case it was; file unchanged. Test in Task 2 (`edit_needs_one_exact_match`).
6. Saved settings that try to widen (a tool the registry does not list, `maxSteps: 500`, `0`) → ignored or clamped, never wider than the registry. Test in Task 1 (`settings_only_narrow`).
7. The model calls a tool that is switched off → refused with the list of tools it does have; the run goes on. Test in Task 3 (`detached_tools_are_refused`).

---

## File Structure

| File | Responsibility |
|---|---|
| `crates/agent-runtime/src/registry.rs` (new) | Parse `skills/registry.toml` session types; narrow them with saved settings |
| `crates/agent-runtime/src/task.rs` (new) | `Task`, `TaskEvent`, `TaskOutcome`, `StopReason`, `TaskRuntime` |
| `crates/agent-runtime/src/tools.rs` (new) | `Workspace` (fixed checks), `Tool` trait, the five built-in tools, lookup by name |
| `crates/agent-runtime/src/hooks.rs` (new) | `Hook` trait, `no_external_urls`, lookup by name |
| `crates/agent-runtime/src/harness.rs` (new) | `ChatModel`, `ChatReply`, `ToolCall`, `Harness` loop, run record |
| `apps/panguyuban-desktop/src/HarnessSettings.tsx` (new) | Settings → Agent harness section |
| `crates/agent-runtime/src/build.rs` (new) | Build-story system prompt, story extraction, prompt |
| `skills/product/build-story/SKILL.md` (new) | Instructions for building one story |
| `apps/panguyuban-desktop/src-tauri/src/provider.rs` | `ChatModel` impl, `task_runtime_for` |
| `apps/panguyuban-desktop/src-tauri/src/builder.rs` | `run_build_story`, `stop_build`, run registry |
| `apps/panguyuban-desktop/src-tauri/src/lib.rs` | Tauri commands `builder_build_story`, `builder_stop_build` |
| `apps/panguyuban-desktop/src/api.ts` | `builderBuildStory`, `builderStopBuild` |
| `apps/panguyuban-desktop/src/builder_flow.ts` | Build-run state on `Project` and its transitions |
| `apps/panguyuban-desktop/src/build_run.check.mjs` (new) | Node check for those transitions |
| `apps/panguyuban-desktop/src/Builder.tsx` | Start the run, step list, Stop, preview of `appHtml` |

---

### Task 1: Registry session types and narrowing

**Files:**
- Create: `crates/agent-runtime/src/registry.rs`
- Modify: `crates/agent-runtime/src/lib.rs` (add `mod registry; pub use registry::*;`), `crates/agent-runtime/Cargo.toml` (add `toml = "0.8"`), `skills/registry.toml` (`build-next-story`)

**Interfaces:**
- Produces:
  - `pub struct SessionType { pub id: String, pub label_en: String, pub skill: String, pub engineering_skills: Vec<String>, pub phase: String, pub write_paths: Vec<String>, pub shell: bool, pub status: String, #[serde(default)] pub tools: Vec<String>, #[serde(default)] pub hooks: Vec<String>, #[serde(default)] pub max_steps: u32, #[serde(default)] pub timeout_minutes: u32 }` (Deserialize, Serialize, Debug, Clone) with `#[serde(rename_all(serialize = "camelCase"))]` — the TOML keys stay snake_case on read
  - `pub fn session_type(id: &str) -> Option<SessionType>`; `pub fn harness_sessions() -> Vec<SessionType>` (those with non-empty `tools`)
  - `#[derive(Deserialize, Serialize, Default, Clone, Debug)] #[serde(rename_all = "camelCase")] pub struct HarnessSettings { pub tools: Option<Vec<String>>, pub hooks: Option<Vec<String>>, pub max_steps: Option<u32>, pub timeout_minutes: Option<u32> }` — `None` = registry value
  - `pub struct Effective { pub tools: Vec<String>, pub hooks: Vec<String>, pub max_steps: u32, pub timeout: Duration }`; `pub fn effective(session: &SessionType, saved: Option<&HarnessSettings>) -> Effective` — order follows the registry list

- [ ] **Step 1: Change `build-next-story` in `skills/registry.toml`** to `engineering_skills = []`, `write_paths = ["app/index.html"]`, `shell = false` (keep `status = "pending"` until Task 5), and add the ceiling lines from Global Constraints (`tools`, `hooks`, `max_steps`, `timeout_minutes`). Document the four new keys in the header comment ("the most the agent may use; Settings can only switch off or lower"). Add a comment line above it: `# v1 builds one static file, no commands: docs/superpowers/specs/2026-11-17-agent-harness-design.md`. (`engineering_skills = []` because the only engineering skill today, `endpoint-requests`, is about HTTP endpoints a static file does not have.)

- [ ] **Step 2: Write failing tests in `registry.rs`**

```rust
#[test]
fn build_session_is_one_file_and_no_shell() {
    let s = session_type("build-next-story").unwrap();
    assert_eq!(s.write_paths, ["app/index.html"]);
    assert!(!s.shell);
    assert!(s.engineering_skills.is_empty());
}

#[test]
fn interview_session_writes_only_the_prd() {
    assert_eq!(session_type("start-new-app").unwrap().write_paths, ["prd.md"]);
}

#[test]
fn unknown_sessions_are_none() {
    assert!(session_type("nope").is_none());
}

#[test]
fn nothing_saved_means_the_registry_ceiling() {
    let e = effective(&session_type("build-next-story").unwrap(), None);
    assert_eq!(e.tools, ["read_file", "list_files", "search", "write_file", "edit_file"]);
    assert_eq!(e.hooks, ["no_external_urls"]);
    assert_eq!((e.max_steps, e.timeout), (40, Duration::from_secs(15 * 60)));
}

#[test]
fn settings_only_narrow() {
    let s = session_type("build-next-story").unwrap();
    let saved = HarnessSettings {
        tools: Some(vec!["edit_file".into(), "read_file".into(), "run_command".into()]),
        hooks: Some(vec![]),
        max_steps: Some(500),
        timeout_minutes: Some(0),
    };
    let e = effective(&s, Some(&saved));
    assert_eq!(e.tools, ["read_file", "edit_file"]); // registry order, run_command dropped
    assert!(e.hooks.is_empty());
    assert_eq!((e.max_steps, e.timeout), (40, Duration::from_secs(60))); // clamped to 1..=ceiling
}

#[test]
fn only_sessions_with_tools_use_the_harness() {
    assert_eq!(harness_sessions().iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["build-next-story"]);
}
```

- [ ] **Step 3: Run** `cargo test -p agent-runtime registry` → FAIL (`session_type` not found).

- [ ] **Step 4: Implement** with `#[derive(Deserialize)] struct Registry { session_type: Vec<SessionType> }` parsed by `toml::from_str(REGISTRY)`; other tables are ignored by serde. Parse once in a `OnceLock`; a parse failure panics with the message `skills/registry.toml is invalid: {e}` (the file is compiled in, so the test catches it).

- [ ] **Step 5: Run** `cargo test -p agent-runtime` → all PASS.

- [ ] **Step 6: Commit** `git commit -m "Parse session types from the skill registry"`

---

### Task 2: Task contract and file tools

**Files:**
- Create: `crates/agent-runtime/src/task.rs`, `crates/agent-runtime/src/tools.rs`
- Modify: `crates/agent-runtime/src/lib.rs` (mods + `pub use`), `crates/agent-runtime/Cargo.toml` (`glob = "0.3"`, `walkdir = "2"`; `[dev-dependencies] tempfile = "3"`)

**Interfaces:**
- Produces (task.rs), all `Serialize` where noted:
  - `pub struct Task { pub system: String, pub prompt: String, pub model: Option<String>, pub work_dir: PathBuf, pub write_paths: Vec<String>, pub max_steps: u32, pub timeout: Duration, pub record: Option<PathBuf> }`
  - `#[derive(Serialize, Clone)] #[serde(tag = "kind", rename_all = "camelCase")] pub enum TaskEvent { Step { tool: String, summary: String, ok: bool }, Message { text: String } }`
  - `#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)] #[serde(rename_all = "camelCase")] pub enum StopReason { MaxSteps, TimedOut, Cancelled }`
  - `#[derive(Serialize, Debug)] pub struct TaskOutcome { pub message: String, pub steps: u32, pub stopped: Option<StopReason> }`
  - `pub trait TaskRuntime: Send + Sync { fn harness(&self) -> &'static str; fn run_task(&self, task: &Task, cancel: &AtomicBool, on_event: &dyn Fn(TaskEvent)) -> Result<TaskOutcome, RuntimeError>; }`
- Produces (tools.rs):
  - `pub struct Workspace { root: PathBuf, write_paths: Vec<String> }`; `pub fn Workspace::new(root: &Path, write_paths: &[String]) -> std::io::Result<Workspace>` (canonicalizes `root`); `pub fn root(&self) -> &Path`; `pub fn resolve(&self, rel: &str) -> Result<PathBuf, String>` (folder check); `pub fn read(&self, rel: &str) -> Result<String, String>`; `pub fn write(&self, rel: &str, content: &str) -> Result<(), String>` (folder + `write_paths` check, then creates parent dirs). Tools reach files only through these.
  - `pub struct ToolResult { pub ok: bool, pub summary: String, pub output: String }` — `summary` is the one UI line, `output` the full text for the model and record; `ToolResult::refused(summary, output)` helper
  - `pub trait Tool: Send + Sync { fn name(&self) -> &'static str; fn definition(&self) -> serde_json::Value; fn run(&self, ws: &Workspace, args: &serde_json::Value) -> ToolResult; }` — `definition` is one OpenAI `{"type":"function","function":{name, description, parameters}}` entry
  - Built-ins (unit structs): `ReadFile` `read_file{path}`, `ListFiles` `list_files{pattern}`, `Search` `search{text, path?}`, `WriteFile` `write_file{path, content}`, `EditFile` `edit_file{path, old, new}`
  - `pub fn builtin_tool(name: &str) -> Option<Box<dyn Tool>>`; `pub fn tools_named(names: &[String]) -> Vec<Box<dyn Tool>>` (unknown names skipped)
  - `pub fn cap_output(text: &str) -> String` — the 20 000-character cap from Global Constraints

Summaries: `read prd.md`, `listed **/*.html (3 files)`, `searched "total" (5 matches)`, `wrote app/index.html`, `edited app/index.html`; refusals: `refused write to prd.md` etc. with `ok: false`.

`write_paths` matching: `"*"` allows any path inside the root; otherwise the normalized relative path (forward slashes) must equal an entry. `list_files` and `search` skip `node_modules`, `.git` and `.panguyuban`. `search` is a plain substring match over UTF-8 files, output `path:line: text`, at most 200 matches.

- [ ] **Step 1: Write failing tests in `tools.rs`** (each builds a `tempfile::tempdir()` with `prd.md` and `app/index.html`, `Workspace::new(dir, &["app/index.html".into()])`; `run("read_file", json!({"path":"prd.md"}))` below is shorthand for `builtin_tool("read_file").unwrap().run(&ws, &json!(…))`):

```rust
#[test] fn reads_inside_the_folder() // run("read_file", {"path":"prd.md"}).ok, output == file text
#[test] fn paths_cannot_leave_the_folder() // "../x", "/etc/hosts", "app/../../x" → !ok, file outside untouched
#[cfg(unix)] #[test] fn symlinks_cannot_leave_the_folder() // symlink "out" -> another tempdir; read_file "out/a.txt" and write_file with write_paths ["*"] to "out/b.txt" → !ok, b.txt not created
#[test] fn writes_only_the_allowed_paths() // write_file prd.md → !ok, prd.md unchanged; write_file app/index.html → ok, content written
#[test] fn star_allows_any_path_inside() // write_paths ["*"]: write_file "a/b/c.txt" → ok, dirs created
#[test] fn edit_needs_one_exact_match() // old missing → !ok, output contains "not found"; old twice → !ok, contains "2 times"; once → ok and replaced
#[test] fn bad_arguments_are_refused_not_fatal() // run("write_file", {"path":"app/index.html"}) (no content) and run("read_file", {"path": 5}) → !ok, output names the missing/bad field
#[test] fn list_and_search_skip_tool_folders() // node_modules/x.js containing "total" is not listed or found; app/index.html containing "total" is
#[test] fn long_output_is_cut_with_a_note() // cap_output of 20 005 chars → 20 000 chars + "\n[output cut: 5 more characters]"
#[test] fn tools_are_found_by_name() // tools_named(&["edit_file","nope","read_file"]) names == ["edit_file","read_file"]; every built-in's definition()["function"]["name"] == its name()
```

- [ ] **Step 2: Run** `cargo test -p agent-runtime tools` → FAIL (module empty).

- [ ] **Step 3: Implement `task.rs`** (types only, as above) **and `tools.rs`.** Path check (in `Workspace::resolve`): reject empty, absolute, or any `Component::ParentDir`; join to `root`; walk up to the nearest existing ancestor, `canonicalize` it, require `starts_with(root)`. For `list_files`, reject patterns that are absolute or contain `..`, glob `root.join(pattern)`, and re-check every hit with the same path check. Writes create parent dirs only after the check passes.

- [ ] **Step 4: Run** `cargo test -p agent-runtime` → all PASS.

- [ ] **Step 5: Commit** `git commit -m "Add the task contract and checked file tools"`

---

### Task 3: Hooks and the harness loop

**Files:**
- Create: `crates/agent-runtime/src/hooks.rs`, `crates/agent-runtime/src/harness.rs`
- Modify: `crates/agent-runtime/src/lib.rs` (mods + `pub use`)

**Interfaces:**
- Consumes: Task 2's `Task`, `TaskEvent`, `TaskOutcome`, `StopReason`, `TaskRuntime`, `Workspace`, `Tool`, `ToolResult`, `cap_output`; `RuntimeError` from lib.rs.
- Produces (harness.rs):
  - `pub struct ToolCall { pub id: String, pub name: String, pub arguments: String }`
  - `pub struct ChatReply { pub text: String, pub tool_calls: Vec<ToolCall> }`
  - `pub trait ChatModel: Send + Sync { fn chat(&self, messages: &[serde_json::Value], tools: &serde_json::Value, model: Option<&str>, timeout: Duration) -> Result<ChatReply, RuntimeError>; }` — messages are OpenAI chat messages; `tools` is the array of attached tools' `definition()`s
  - `pub struct Harness { pub chat: Box<dyn ChatModel>, pub tools: Vec<Box<dyn Tool>>, pub hooks: Vec<Box<dyn Hook>> }` implementing `TaskRuntime` with `harness() == "provider"`
- Produces (hooks.rs):
  - `pub trait Hook: Send + Sync { fn name(&self) -> &'static str; fn before(&self, _call: &ToolCall, _args: &serde_json::Value) -> Result<(), String> { Ok(()) } fn after(&self, _call: &ToolCall, _ws: &Workspace, _result: &mut ToolResult) {} }`
  - `pub struct NoExternalUrls;` name `no_external_urls`: in `after`, when the call is `write_file` or `edit_file`, `result.ok`, and the written file (path from the call's arguments, read through `ws.read`) contains `http://` or `https://`, append to `result.output`: `\nNote: this file links to http(s) URLs. The preview blocks them; inline the content or remove the links.`
  - `pub fn builtin_hook(name: &str) -> Option<Box<dyn Hook>>`; `pub fn hooks_named(names: &[String]) -> Vec<Box<dyn Hook>>`

Loop, per spec "The loop": messages start `[{"role":"system",…},{"role":"user",…}]`. After each reply with tool calls, push `{"role":"assistant","content":text,"tool_calls":[{"id","type":"function","function":{"name","arguments"}}]}`, then for each call (in order): parse `arguments` as JSON (failure → refused `arguments are not valid JSON`); find the attached tool by name (missing → refused `unknown tool {name}; you can use: {names}`); run every hook's `before` (first `Err(reason)` → refused with that reason); run the tool; run every hook's `after`; emit `TaskEvent::Step`; push `{"role":"tool","tool_call_id":id,"content":cap_output(output)}`. Non-empty text alongside tool calls is emitted as `TaskEvent::Message`. Steps count tool calls. Check `cancel` (`Ordering::Relaxed`) before every model call and every tool call; check `max_steps` before each tool call; each model call gets the remaining time, and no time left → `TimedOut`. When stopped, `message` is the last text the model said (may be empty).

Run record (when `task.record` is `Some`): create parent dirs, append one JSON object per line: `{"type":"task","prompt",…,"model","maxSteps","writePaths"}`, `{"type":"reply","text","toolCalls"}`, `{"type":"tool","name","arguments","ok","output"}` (full, uncapped), `{"type":"outcome",…}`. A record write failure never fails the task.

- [ ] **Step 1: Write failing tests in `harness.rs`** with `struct Scripted(Mutex<VecDeque<ChatReply>>, Mutex<Vec<Vec<Value>>>)` implementing `ChatModel` (pops the next reply, keeps the messages it was sent). Unless a test says otherwise the harness gets all five built-in tools and no hooks:

```rust
#[test] fn finishes_when_the_model_stops_calling_tools() // replies: [write_file app/index.html "<p>orders</p>"], ["Built S1"] → outcome.message == "Built S1", steps == 1, stopped == None, file written, events == [Step{tool:"write_file", ok:true, ..}]
#[test] fn refusals_go_back_to_the_model() // [write_file prd.md], ["ok"] → second request's last message is role "tool" whose content contains "app/index.html", outcome.stopped == None
#[test] fn several_calls_in_one_reply_each_get_a_result() // one reply with calls id "a" (read_file prd.md) and "b" (list_files "*") → next request has two tool messages with tool_call_id "a" then "b"
#[test] fn stops_at_max_steps() // max_steps 2, model always asks read_file → stopped == Some(MaxSteps), steps == 2
#[test] fn cancel_stops_before_the_next_call() // cancel already true → stopped == Some(Cancelled), steps == 0, model never called
#[test] fn model_errors_fail_the_task() // chat returns Err(RuntimeError::Failed{..}) → run_task is Err
#[test] fn the_record_has_every_tool_result_in_full() // record Some(path); a read_file of a 30 000-char file → record line with "type":"tool" whose output length is 30 000, while the tool message sent to the model ends with "[output cut: 10000 more characters]"
#[test] fn only_attached_tools_are_offered() // tools = [ReadFile]: the `tools` value the model received has exactly one entry, named "read_file"
#[test] fn detached_tools_are_refused() // tools = [ReadFile]; model asks write_file → Step ok:false, tool message contains "unknown tool write_file" and "read_file"; run finishes normally
#[test] fn bad_json_arguments_are_refused() // call arguments "not json" → Step ok:false, tool message contains "not valid JSON"
#[test] fn hooks_can_refuse_and_annotate() // a test hook whose before() returns Err("no edits today") for edit_file → edit refused with that text, file unchanged; NoExternalUrls + write_file with "<img src=\"https://x\">" → tool message contains "The preview blocks them"; same write with no URL → no note
```

- [ ] **Step 2: Run** `cargo test -p agent-runtime harness hooks` → FAIL.

- [ ] **Step 3: Implement** `hooks.rs` and `Harness::run_task` as described.

- [ ] **Step 4: Run** `cargo test -p agent-runtime` → all PASS.

- [ ] **Step 5: Commit** `git commit -m "Add the harness loop over any chat model"`

---

### Task 4: Provider tool calling

**Files:**
- Modify: `apps/panguyuban-desktop/src-tauri/src/provider.rs`

**Interfaces:**
- Consumes: Task 3's `ChatModel`, `ChatReply`, `ToolCall`, `Harness`; Task 2's `TaskRuntime`.
- Produces:
  - `impl ChatModel for OpenAiCompatRuntime` — POST `{base}/chat/completions` with `{"model", "messages", "tools"}`; same key, client, `block_on` and error mapping as `complete`; model required (same "Pick a model for this provider" error)
  - `fn parse_tool_reply(body: &str) -> Result<ChatReply, String>`
  - `fn unsupported(label: &str) -> String` — the "not supported yet" copy, used by `task_runtime_for`
  - `pub fn task_runtime_for(store: &SqliteStore, harness: &str, label: &str, effective: &Effective) -> Result<Box<dyn TaskRuntime>, String>` — `provider:<id>` → `Harness { chat: Box::new(OpenAiCompatRuntime{..}), tools: tools_named(&effective.tools), hooks: hooks_named(&effective.hooks) }` built like `runtime_for`; anything else → `Err(unsupported(label))`

When the HTTP status is 400, 404 or 422 and the body mentions `tool` (case-insensitive), the error detail is exactly `This model or provider does not support tools; pick another model`.

- [ ] **Step 1: Write failing tests** in `provider.rs` `mod tests`:

```rust
#[test]
fn tool_replies_are_parsed() {
    let calls = r#"{"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[
        {"id":"c1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"prd.md\"}"}}]}}]}"#;
    let r = parse_tool_reply(calls).unwrap();
    assert_eq!(r.text, "");
    assert_eq!((r.tool_calls[0].id.as_str(), r.tool_calls[0].name.as_str()), ("c1", "read_file"));
    let text = parse_tool_reply(r#"{"choices":[{"message":{"content":"Built S1"}}]}"#).unwrap();
    assert!(text.tool_calls.is_empty());
    assert_eq!(text.text, "Built S1");
    assert!(parse_tool_reply(r#"{"error":{"message":"no credits"}}"#).unwrap_err().contains("no credits"));
}

#[test]
fn only_providers_can_build() {
    // task_runtime_for needs a store; test the non-provider branch through a helper
    // `fn unsupported(label: &str) -> String` that task_runtime_for uses.
    assert_eq!(unsupported("Claude lead"), "Building with Claude lead is not supported yet; pick a provider agent");
}
```

- [ ] **Step 2: Run** `cargo test -p panguyuban-desktop provider` → FAIL.

- [ ] **Step 3: Implement** the three items above. Reuse `parse_chat`'s error reading for `{"error":…}` bodies.

- [ ] **Step 4: Run** `cargo test -p panguyuban-desktop` → all PASS.

- [ ] **Step 5: Commit** `git commit -m "Let providers call tools"`

---

### Task 5: Build-story skill, prompts and Tauri commands

**Files:**
- Create: `skills/product/build-story/SKILL.md`, `crates/agent-runtime/src/build.rs`
- Modify: `crates/agent-runtime/src/lib.rs` (mod + `pub use`), `skills/registry.toml` (`build-next-story` `status = "ready"`), `apps/panguyuban-desktop/src-tauri/src/builder.rs`, `apps/panguyuban-desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: Task 1 `session_type`; Task 2 `Task`, `TaskEvent`, `StopReason`; Task 4 `task_runtime_for`.
- Produces (build.rs):
  - `pub fn build_system_prompt(write_path: &str) -> String` — skill (frontmatter stripped with the existing `strip_frontmatter`) + `## How this session runs` with these rules: you can read, list and search files in the project folder; you can write only `{write_path}`; keep the whole app in that one file, with CSS and JS inline and no external URLs (the preview blocks them); you cannot run anything; when done, reply without tool calls with a short summary of what you built and which acceptance lines you think now pass
  - `pub fn story_section(prd: &str, story_id: &str) -> Option<String>` — from the `### {id}. ` heading line up to (not including) the next line starting with `### ` or `## `
  - `pub fn build_prompt(prd: &str, story_id: &str) -> Result<String, String>` — `Build step {id} now.\n\n{section}\n\nThe whole PRD, for context:\n\n{prd}`; unknown id → `Err("{id} is not a step in prd.md")`
- Produces (builder.rs):
  - `#[derive(Deserialize)] #[serde(rename_all = "camelCase")] pub struct BuildStoryArgs { pub project_id: String, pub project_name: String, pub harness: String, pub agent_label: String, pub model: Option<String>, pub prd: String, pub story_id: String }`
  - `#[derive(Serialize)] #[serde(rename_all = "camelCase")] pub struct BuildStoryResult { pub message: String, pub steps: u32, pub stopped: Option<StopReason>, pub html: Option<String> }` — `html` is `app/index.html` after the run
  - `pub fn run_build_story(store: &SqliteStore, args: BuildStoryArgs, on_event: &dyn Fn(TaskEvent)) -> Result<BuildStoryResult, String>`
  - `pub fn stop_build(project_id: &str) -> bool` — sets that run's cancel flag; false when none runs
  - `pub fn load_harness_settings(store: &SqliteStore) -> HashMap<String, HarnessSettings>` — `app_data` key `harness`, keyed by session type id; missing or unreadable JSON → empty map (registry values apply)
- Produces (lib.rs): `#[tauri::command] async fn builder_build_story(state, args: builder::BuildStoryArgs, on_event: tauri::ipc::Channel<agent_runtime::TaskEvent>) -> Result<builder::BuildStoryResult, String>` (via `spawn_blocking`, like `builder_design`; a failed `on_event.send` is ignored so a closed window does not stop the run) and `#[tauri::command] fn builder_stop_build(project_id: String) -> bool`; both added to `generate_handler!`.

`run_build_story`: `project_dir`; copy `design.html` to `app/index.html` when the latter is missing (error `Approve a prototype before building` when neither exists); `session = session_type("build-next-story")`, `effective(&session, saved)` where `saved` is this session's entry from `load_harness_settings(store)`; `write_paths` from `session`, `max_steps`/`timeout` from `effective`, runtime from `task_runtime_for(…, &effective)`; register an `Arc<AtomicBool>` in `static BUILDS: Mutex<HashMap<String, Arc<AtomicBool>>>` (refuse with `A step is already being built for this prototype` if the id is present; remove it on every exit path, e.g. with a drop guard); `record = .panguyuban/runs/{story_id}-{unix_seconds}.jsonl`.

Skill text (`build-story/SKILL.md`, with `name: build-story` and a one-line `description` frontmatter like `html-prototype`): you are extending the approved prototype into the app, one step at a time; read `prd.md` and the current file before changing it; change only what the step needs and keep everything earlier steps built working; prefer `edit_file` for small changes, `write_file` only for a rewrite; made-up data only, never real personal or customer data; plain words in the summary, for a non-technical reader. Keep it under 60 lines.

- [ ] **Step 1: Write failing tests** in `build.rs`:

```rust
const PRD: &str = "# Orders\n\n## Steps\n\n### S1. List orders\nShow ORD-2041.\n- [ ] the list shows ORD-2041\n\n### S2. Filter\nBy customer.\n\n## Later\n- export\n";

#[test] fn a_story_is_its_heading_up_to_the_next_heading() // story_section(PRD,"S1") == Some("### S1. List orders\nShow ORD-2041.\n- [ ] the list shows ORD-2041\n") (trim-insensitive compare), story_section(PRD,"S2") ends before "## Later"
#[test] fn unknown_steps_are_an_error() // build_prompt(PRD,"S9").unwrap_err() == "S9 is not a step in prd.md"
#[test] fn the_system_prompt_names_the_one_file() // build_system_prompt("app/index.html") contains "app/index.html" and "## How this session runs" and not "---\nname:"
```

and in `builder.rs` `mod tests`:

```rust
#[test] fn one_build_per_project() // register("p1") Some, second register("p1") None, after the first guard drops register("p1") is Some again; stop_build("p1") true while held, stop_build("p2") false
```

(`fn register(project_id: &str) -> Option<RunGuard>` is the private helper `run_build_story` uses; `RunGuard` removes the entry on drop and derefs to the flag.)

- [ ] **Step 2: Run** `cargo test -p agent-runtime build && cargo test -p panguyuban-desktop builder` → FAIL.

- [ ] **Step 3: Write the skill, `build.rs`, `run_build_story`, `stop_build`, the two commands; set `status = "ready"`.**

- [ ] **Step 4: Run** `cargo test --workspace` → all PASS; `cargo build -p panguyuban-desktop` → OK.

- [ ] **Step 5: Commit** `git commit -m "Build a story with the harness from the app"`

---

### Task 6: Build stage UI

**Files:**
- Modify: `apps/panguyuban-desktop/package.json` (`npm install @tauri-apps/api@^2`), `apps/panguyuban-desktop/src/api.ts`, `apps/panguyuban-desktop/src/builder_flow.ts`, `apps/panguyuban-desktop/src/Builder.tsx`
- Create: `apps/panguyuban-desktop/src/build_run.check.mjs`

**Interfaces:**
- Consumes: Task 5 commands `builder_build_story({ args, onEvent })`, `builder_stop_build({ projectId })`; `TaskEvent` JSON `{kind:"step", tool, summary, ok}` / `{kind:"message", text}`; `BuildStoryResult` JSON `{message, steps, stopped: null|"maxSteps"|"timedOut"|"cancelled", html}`.
- Produces (api.ts): `export type TaskEvent`, `export interface BuildStoryResult`, `export async function builderBuildStory(args: { projectId: string; projectName: string; harness: string; agentLabel: string; model: string | null; prd: string; storyId: string }, onEvent: (e: TaskEvent) => void): Promise<BuildStoryResult>` (uses `Channel` from `@tauri-apps/api/core`; rejects with `"Building needs the desktop app"` outside it), `export async function builderStopBuild(projectId: string): Promise<boolean>`.
- Produces (builder_flow.ts):
  - `Project` gains `buildRun: { storyId: string; agentId: string; steps: string[] } | null` and `appHtml: string | null` (both `null` in `createProject`; old saved projects without them read as `null` — use `?? null` where read)
  - `export function realBuild(p: Project, story: Story): { agent: AgentDef } | { blocked: string } | null` — `null` when `!isLive(p)` (stand-in keeps the simulated `buildCurrentStory`); otherwise the agent from `agentFor`, or `{ blocked: "Building with {label} is not supported yet; pick a provider agent" }` when its harness does not start with `provider:`
  - `export function startStoryBuild(p: Project, agentId: string): Project` — sets `buildRun`, clears `agentError`
  - `export function addBuildStep(p: Project, line: string): Project`
  - `export function applyStoryBuild(p: Project, r: { message: string; stopped: string | null; html: string | null }): Project` — `stopped === null` → story `built`, `builtBy` = run agent, `appHtml = html`, `checksPassing` unchanged, agent says the message then `Look at the preview and tick each line that is true.`; otherwise story stays `todo`, `agentError` = `Stopped after too many steps.` / `Stopped: it took too long.` / `Stopped.` for `maxSteps` / `timedOut` / `cancelled`; `buildRun = null` in both
  - `export function storyBuildFailed(p: Project, error: string): Project` — `buildRun = null`, story stays `todo`, `agentError = error`
  - `routedAgent(story, p?)`: when `p` is given and `agentById(p.interviewAgent)?.harness` starts with `provider:`, return that agent; `agentFor` passes `p`
  - `canConfirmStory`: drop the `p.checksPassing` requirement when `p.appHtml !== null`
  - `canUndo`: `false` when `p.appHtml !== null`

- [ ] **Step 1: Write the failing check** `src/build_run.check.mjs` (style of `team_review.check.mjs`; build fixtures with `createProject("Orders", "Acme", "Sam", "", "provider-x")` then set `stage: "build"`, `stories: [story("S1")]`, and call `setProviderAgents([{ id: "x", name: "Local" }])`):

```js
// stand_in_projects_keep_the_simulated_build → realBuild(createProject(...no agent), s) === null
// cli_agents_are_blocked → with interviewAgent "claude-lead": realBuild(p, s).blocked === "Building with Claude lead is not supported yet; pick a provider agent"
// autopilot_uses_the_project_provider → realBuild(p, s).agent.id === "provider-x"
// a_finished_run_builds_the_story → applyStoryBuild(startStoryBuild(p,"provider-x"), {message:"Built S1", stopped:null, html:"<p>ORD-2041</p>"}): S1 status "built", builtBy "provider-x", appHtml set, buildRun null
// a_stopped_run_leaves_it_to_do → stopped "maxSteps": S1 "todo", agentError "Stopped after too many steps."
// real_builds_confirm_without_checks_and_cannot_undo → after a finished run and ticking S1's criteria: canConfirmStory true with checksPassing false; canUndo false after confirmStory
// steps_are_kept_in_order → addBuildStep twice → buildRun.steps equals ["read prd.md", "edited app/index.html"]
```

- [ ] **Step 2: Run** `node src/build_run.check.mjs` (from `apps/panguyuban-desktop`) → FAIL.

- [ ] **Step 3: Implement `api.ts` and `builder_flow.ts` changes.**

- [ ] **Step 4: Run** `node src/build_run.check.mjs && node src/team_review.check.mjs && node src/spaces_saved.check.mjs` → all print ok.

- [ ] **Step 5: Wire `Builder.tsx`.** In the `case "build"` action (around `Builder.tsx:900`), when `realBuild` returns `{ blocked }` show it as blocked; when `{ agent }`, run: `startStoryBuild`, then `builderBuildStory({... harness: agent.harness, agentLabel: agent.label, model: agent.model, prd: prdMarkdown(p), storyId })` with `onEvent` adding a step (`summary`, prefixed `✗ ` when `!ok`) or the message, `.then(applyStoryBuild)`, `.catch(storyBuildFailed)`, all through `builder.updateById(id, …)` like the design effect at `Builder.tsx:204-226`. While `buildRun` is set: the action reads `Building {id}…` (blocked), the story shows the step list (latest last) and a **Stop** button calling `builderStopBuild(p.id)`. When `appHtml` is set, the build-stage preview iframe uses `lockedDesign(project.appHtml)` instead of `designHtml`. Where the agent's message used to say checks pass, real builds show `Standards checks are not run yet.` under the preview.

- [ ] **Step 6: Run** `npm run build` (from `apps/panguyuban-desktop`) → OK, no type errors.

- [ ] **Step 7: Manual check** with `npm run desktop`: a provider with a tool-calling model, a prototype through to Build, **Build S1** → steps stream in, preview updates, Stop works mid-run, `app/index.html` and `.panguyuban/runs/S1-*.jsonl` exist in `<Documents>/Panguyuban/<name>-<id>/`. Report what happened, including any failure.

- [ ] **Step 8: Commit** `git commit -m "Build stage runs the harness with live steps and Stop"`

---

### Task 7: Settings → Agent harness

**Files:**
- Create: `apps/panguyuban-desktop/src/HarnessSettings.tsx`
- Modify: `apps/panguyuban-desktop/src-tauri/src/builder.rs`, `apps/panguyuban-desktop/src-tauri/src/lib.rs`, `apps/panguyuban-desktop/src/api.ts`, `apps/panguyuban-desktop/src/App.tsx` (render `<HarnessSection />` right after `<ProvidersSection />`, `App.tsx:1608`)

**Interfaces:**
- Consumes: Task 1 `harness_sessions`, `effective`, `HarnessSettings`, `SessionType`; Task 5 `load_harness_settings`; `SqliteStore::set_app_data(key, value)`.
- Produces (builder.rs):
  - `#[derive(Serialize)] #[serde(rename_all = "camelCase")] pub struct HarnessSessionView { pub session: SessionType, pub tools: Vec<String>, pub hooks: Vec<String>, pub max_steps: u32, pub timeout_minutes: u32 }` — `session` carries the ceiling (and `write_paths` for the locked line); the rest is the current effective choice
  - `pub fn harness_settings(store: &SqliteStore) -> Vec<HarnessSessionView>` (one per `harness_sessions()`)
  - `pub fn save_harness_settings(store: &SqliteStore, session_id: &str, settings: Option<HarnessSettings>) -> Result<Vec<HarnessSessionView>, String>` — `None` = reset (removes that entry); unknown `session_id` → `Err("{id} is not a session type")`; stores the settings as given (narrowing happens on read through `effective`) and returns the fresh views
- Produces (lib.rs): `#[tauri::command] fn builder_harness_settings(state) -> Result<Vec<builder::HarnessSessionView>, String>`, `#[tauri::command] fn builder_save_harness_settings(state, session_id: String, settings: Option<agent_runtime::HarnessSettings>) -> Result<Vec<builder::HarnessSessionView>, String>`, both in `generate_handler!`.
- Produces (api.ts): `export interface HarnessSessionView` mirroring the Rust JSON; `builderHarnessSettings(): Promise<HarnessSessionView[]>` (`[]` outside the desktop app); `builderSaveHarnessSettings(sessionId: string, settings: { tools: string[]; hooks: string[]; maxSteps: number; timeoutMinutes: number } | null): Promise<HarnessSessionView[]>`.

UI copy (labels by name; an unknown name shows the name itself):

| name | label |
|---|---|
| `read_file` | Read files |
| `list_files` | List files |
| `search` | Search |
| `write_file` | Write whole file |
| `edit_file` | Edit part of file |
| `no_external_urls` | Warn about links the preview blocks |

Section layout follows `ProvidersSettings.tsx` (`settings-section`, `settings-aside` with `<h2>Agent harness</h2>` and one line: `What the agent may do while it builds. Engineering sets the most it may do; you can switch things off or lower the limits.`, `settings-body`). Per session: its `labelEn` as heading; **Tools** and **Checks** as checkboxes, only for names in the session's ceiling; **Limits** as two number inputs with `min=1` and `max` = the ceiling, showing `(1–{max})`; **Always on** as two locked lines `Stays inside the project folder` and `Writes only {writePaths joined with ", "}` (`Writes anywhere in the project folder` for `*`); **Reset to defaults** and **Save** buttons, and the saved status line like Providers.

- [ ] **Step 1: Write failing tests** in `builder.rs` `mod tests` (use an in-memory or temp `SqliteStore` the way existing desktop tests do; if none do, `SqliteStore::open` on a `tempfile` path):

```rust
#[test] fn harness_settings_start_at_the_ceiling() // harness_settings(&store): one view, session.id "build-next-story", tools == the five, max_steps 40
#[test] fn saved_settings_narrow_and_reset() // save Some({tools:["read_file"], hooks:[], max_steps:5, timeout_minutes:3}) → view tools ["read_file"], hooks [], 5, 3; load_harness_settings has the entry; save None → back to the ceiling
#[test] fn saving_cannot_widen() // save Some({tools:["read_file","run_command"], max_steps:999, ..}) → view tools ["read_file"], max_steps 40
#[test] fn unknown_sessions_are_refused() // save_harness_settings(&store, "nope", None) → Err("nope is not a session type")
```

- [ ] **Step 2: Run** `cargo test -p panguyuban-desktop harness_settings saved_settings saving_cannot unknown_sessions` → FAIL.

- [ ] **Step 3: Implement** the builder.rs functions and the two commands.

- [ ] **Step 4: Run** `cargo test --workspace` → all PASS.

- [ ] **Step 5: Implement** `api.ts` additions, `HarnessSettings.tsx`, and render it in `App.tsx`.

- [ ] **Step 6: Run** `npm run build` (from `apps/panguyuban-desktop`) → OK.

- [ ] **Step 7: Manual check** with `npm run desktop`: Settings shows **Agent harness** with the five tools, the check, limits 40 / 15 and the two locked lines. Switch off **Write whole file**, set Max steps 10, Save, build a step → the step list shows a refused `write_file` if the model tries it, and the run stops by step 10. **Reset to defaults** brings everything back. Report what happened, including any failure.

- [ ] **Step 8: Commit** `git commit -m "Agent harness settings: switch tools and checks off, lower limits"`
