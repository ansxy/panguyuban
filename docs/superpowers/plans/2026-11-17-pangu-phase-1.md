# pangu Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `pangu` terminal command that runs Panguyuban's own agent loop with a provider saved in the app, and `pangu claude`, which launches Claude Code with the app's skills and the app's guard-rail checks in its hooks — both governed by one Rust policy.

**Architecture:** `agent-runtime` gains a policy core (`policy.rs`), a fixed `.git` rule in `Workspace`, a `run_command` tool with an `Approver`, and multi-turn conversations. The OpenAI-compatible provider moves out of the Tauri crate into a shared `provider-openai` crate (blocking HTTP) so both the app and `pangu` use it. A new `pangu-cli` crate provides the `pangu` binary: the REPL, the hook subcommands (`check`, `record`, `allow`) with a Claude Code adapter, and the `claude` launcher. The app bundles the binary and offers to link it onto PATH.

**Tech Stack:** Rust (agent-runtime, panguyuban-core, reqwest 0.12 blocking + rustls, keyring 3, serde_json), Tauri 2 `bundle.externalBin`, React/TypeScript for one Settings button.

**Spec:** `docs/superpowers/specs/2026-11-17-pangu-one-policy-many-agents-design.md` (phase 1). Builds on `docs/superpowers/specs/2026-11-17-agent-harness-design.md`.

## Global Constraints

- External agents get **guard rails only**: a hook either denies or prints nothing; it never answers "allow". Allow and Ask are both silent for external agents.
- Inside a pangu session a hook that fails (bad JSON, unreadable DB, panic) must deny. Outside a session (`PANGU_SESSION` unset) a hook exits 0 with no output.
- Claude Code deny = exit code 2 with the reason on stderr (blocks even if pangu crashes with a panic caught by `catch_unwind`).
- "The folder" = git root above the launch directory (walk up for a `.git` entry), else the launch directory; fixed for the session; carried in env `PANGU_ROOT`; session id in env `PANGU_SESSION`.
- Writes into `.git` (the folder itself or anything under it, case-insensitive) are refused by `Workspace` for every caller.
- Session type `work-on-project`: `write_paths = ["*"]`, `shell = true`, `tools = ["read_file", "list_files", "search", "write_file", "edit_file", "run_command"]`, `hooks = []`, `max_steps = 200`, `timeout_minutes = 60`, `engineering_skills = ["*"]`, `status = "ready"`.
- Data folder: `dirs::data_local_dir()/panguyuban/`. DB `state.db`; run records `runs/<folder-slug>/<session>.jsonl`; generated Claude plugin `claude-plugin/`. `folder-slug` = absolute folder path with every char outside `[A-Za-z0-9]` replaced by `-`.
- `app_data` keys: `providers` (existing, `[{id, name, baseUrl}]`), `harness` (existing), `pangu` (new: `{"provider": "<id>", "model": "<id>"}`), `pangu-allowed` (new: `{"<abs folder>": ["<command>", …]}`).
- Keychain: service `com.ansar.panguyuban`, account `provider:<id>`. Keys never on a command line, never written to files.
- No company names; sample data uses orders/customers (ORD-2041, Acme). Commits use `ansxy@users.noreply.github.com`.
- After every task: `cargo test --workspace` passes (only the pre-existing unused `CiState` warning allowed); after tasks touching the frontend, `npm run build` in `apps/panguyuban-desktop` passes.

## Review Focus

1. A Claude Code hook payload with an absolute `file_path` inside the folder, one outside, and one into `.git` → silent, deny ("outside the project"), deny (".git") respectively. Test in Task 4 (`claude_writes_are_checked_by_absolute_path`).
2. `pangu check` run with `PANGU_SESSION` unset, or with the binary given garbage on stdin inside a session → exit 0 silent, and exit 2 respectively. Test in Task 4 (`outside_a_session_check_is_inert`, `bad_input_inside_a_session_denies`).
3. Settings switch off `run_command` → Claude `Bash` denied with "commands are switched off in Settings"; own loop never offers the tool. Test in Task 1 (`switched_off_tools_deny`) and Task 4.
4. Launch from a subdirectory of a repo → folder = repo root, so editing `README.md` at the root is allowed. Test in Task 4 (`the_folder_is_the_git_root`).
5. Provider saved without a key (local server) → requests are sent without auth, no error. Test in Task 3 (`no_key_sends_no_auth_header` via the request builder helper).

---

## File Structure

| File | Responsibility |
|---|---|
| `crates/agent-runtime/src/tools.rs` | `.git` write rule in `Workspace` |
| `crates/agent-runtime/src/policy.rs` (new) | `Action`, `Decision`, `PolicyContext`, `decide` |
| `crates/agent-runtime/src/commands.rs` (new) | `run_command` tool, `Approver`, `Approval` |
| `crates/agent-runtime/src/harness.rs` | `Conversation`, `Harness::run_turn` |
| `skills/registry.toml`, `skills/product/work-on-project/SKILL.md` (new) | session type + skill |
| `crates/provider-openai/` (new crate) | OpenAI-compatible `ChatModel`/`AgentRuntime` (blocking), saved providers, keychain key |
| `apps/panguyuban-desktop/src-tauri/src/provider.rs` | uses `provider-openai`; keeps async `models()` |
| `crates/pangu-cli/` (new crate, bin `pangu`) | `session.rs` (folder, env, record, allowed list), `hook.rs` (check/record + Claude adapter), `repl.rs` (own loop), `claude.rs` (launcher), `main.rs` (subcommands) |
| `apps/panguyuban-desktop/src-tauri/tauri.conf.json`, `scripts/build-pangu.sh` (new) | bundle `pangu` |
| `apps/panguyuban-desktop/src-tauri/src/lib.rs`, `src/HarnessSettings.tsx`, `src/api.ts` | "Install `pangu` command" button |

---

### Task 1: Policy core, `.git` rule, work-on-project session

**Files:**
- Modify: `crates/agent-runtime/src/tools.rs` (`Workspace::write`), `crates/agent-runtime/src/lib.rs` (mod + `pub use`), `skills/registry.toml`
- Create: `crates/agent-runtime/src/policy.rs`, `skills/product/work-on-project/SKILL.md`

**Interfaces:**
- Consumes: `Workspace` (`resolve`, `write`, `root`), `Effective { tools, hooks, max_steps, timeout }`, `session_type`, `effective`.
- Produces:
  - `pub enum Action { Read(String), Write(String), Run(String), Other(String) }`
  - `#[derive(Debug, PartialEq)] pub enum Decision { Allow, Deny(String), Ask(String) }`
  - `pub struct PolicyContext { pub workspace: Workspace, pub effective: Effective, pub always_allowed: Vec<String>, pub steps_so_far: u32 }`
  - `pub fn decide(ctx: &PolicyContext, action: &Action) -> Decision`
  - `pub fn relative_to(root: &Path, path: &str) -> Option<String>` — absolute path inside `root` → relative (forward slashes); relative input returned as is; absolute outside → `None`

Rules (`decide`), first match wins:
1. `steps_so_far >= effective.max_steps` and action is Write or Run → `Deny("step limit reached; start a new pangu session")`.
2. `Read(p)`: no `read_file`/`list_files`/`search` in `effective.tools` → `Deny("reading is switched off in Settings")`; `relative_to` is `None` → `Ask("reads outside the project")`; else `Allow`.
3. `Write(p)`: no `write_file`/`edit_file` enabled → `Deny("writing is switched off in Settings")`; `relative_to` is `None` → `Deny("writes outside the project are not allowed")`; `.git` rule or `write_paths` refuse (use a new `Workspace::check_write(rel) -> Result<(), String>` that `write` also calls) → `Deny(reason)`; else `Allow`.
4. `Run(c)`: no `run_command` enabled → `Deny("commands are switched off in Settings")`; `c` exactly in `always_allowed` → `Allow`; else `Ask(format!("run `{c}`?"))`.
5. `Other(_)` → `Ask("unknown tool")`.

`.git` rule: `check_write` refuses when the first path component equals `.git` (ASCII case-insensitive) with `"the .git folder is off limits"`, regardless of `write_paths`.

Registry: add the `work-on-project` session type exactly as in Global Constraints with `label_en = "Work on a project"`, `label_id = "Kerjakan proyek"`, `skill = "work-on-project"`, `phase = "build"`. Skill text (frontmatter `name: work-on-project`, one-line `description`), under 40 lines: read before editing; small, focused changes; follow the repo's existing style; run the project's own tests or build when they exist; never touch `.git`; never put real personal or customer data in code or tests; finish with a short summary of what changed and how it was checked.

- [ ] **Step 1: Write failing tests** in `policy.rs` (`Workspace` on a tempdir with `write_paths ["*"]`, `effective` from `session_type("work-on-project")` with `None` saved, `always_allowed = ["npm test"]`, `steps_so_far = 0`):

```rust
#[test] fn writes_inside_are_allowed_and_git_is_not() // decide(Write("src/a.ts")) == Allow; Write(".git/hooks/pre-commit") == Deny("the .git folder is off limits"); Write(".GIT/config") is Deny
#[test] fn absolute_paths_are_made_relative() // relative_to(root, &format!("{}/src/a.ts", root)) == Some("src/a.ts"); relative_to(root, "/etc/hosts") == None; Write("/etc/hosts") == Deny("writes outside the project are not allowed"); Read("/etc/hosts") == Ask("reads outside the project")
#[test] fn commands_ask_unless_always_allowed() // Run("npm test") == Allow; Run("npm test -- --watch") == Ask("run `npm test -- --watch`?")
#[test] fn switched_off_tools_deny() // effective with saved tools Some(["read_file"]): Write → Deny("writing is switched off in Settings"); Run → Deny("commands are switched off in Settings")
#[test] fn the_step_limit_stops_writes_and_commands() // steps_so_far = 200: Write and Run → Deny("step limit reached; start a new pangu session"); Read still Allow
#[test] fn unknown_tools_ask() // Other("TodoWrite") == Ask("unknown tool")
```

and in `tools.rs`: `#[test] fn git_is_off_limits_even_with_star()` — `Workspace::new(dir, &["*"])`, `write(".git/config", "x")` is `Err` containing "off limits", file not created. In `registry.rs`: `#[test] fn work_on_project_is_a_harness_session()` — `harness_sessions()` ids contain `"work-on-project"` and its `effective(.., None).max_steps == 200`. (Update `only_sessions_with_tools_use_the_harness` to expect both ids.)

- [ ] **Step 2: Run** `cargo test -p agent-runtime policy tools registry` → FAIL.
- [ ] **Step 3: Implement** the above.
- [ ] **Step 4: Run** `cargo test --workspace` → PASS (the desktop crate's Settings tests that list harness sessions may need their expected list updated to include `work-on-project`).
- [ ] **Step 5: Commit** `git commit -m "Add the policy core, the .git rule and the work-on-project session"`

---

### Task 2: `run_command`, approvals and conversations

**Files:**
- Create: `crates/agent-runtime/src/commands.rs`
- Modify: `crates/agent-runtime/src/harness.rs`, `crates/agent-runtime/src/lib.rs`

**Interfaces:**
- Consumes: `Tool`, `ToolResult`, `Workspace`, `Harness`, `Task`, `TaskOutcome`, `TaskEvent`.
- Produces:
  - `#[derive(Debug, Clone, Copy, PartialEq)] pub enum Approval { Once, AlwaysHere, Deny }`
  - `pub trait Approver: Send + Sync { fn approve(&self, command: &str) -> Approval; }`
  - `pub struct RunCommand { approver: Box<dyn Approver>, allowed: Mutex<Vec<String>>, remember: Box<dyn Fn(&str) + Send + Sync>, timeout: Duration }` with `pub fn new(approver, always_allowed: Vec<String>, remember, timeout) -> RunCommand`; implements `Tool` as `run_command { command: string }`. Exact match in `allowed` → runs without asking. `AlwaysHere` → push to `allowed` and call `remember(command)`. `Deny` → `ToolResult::refused("denied `<cmd>`", "the user denied this command")`. Runs `sh -c <command>` in `ws.root()`, stdin null, combined stdout+stderr, killed at `timeout` (`"timed out after N s"`); output `exit code N\n<output>`; summary `ran `<cmd>` (exit N)`; `ok` = exit 0.
  - `pub struct Conversation { messages: Vec<serde_json::Value> }` with `Conversation::new() -> Conversation` and `pub fn is_empty(&self) -> bool`
  - `pub fn Harness::run_turn(&self, task: &Task, conversation: &mut Conversation, cancel: &AtomicBool, on_event: &dyn Fn(TaskEvent)) -> Result<TaskOutcome, RuntimeError>` — when the conversation is empty it starts with `task.system`; it always appends `task.prompt` as a user message; on return (finished or stopped) the conversation keeps every message so the next turn continues it. `run_task` becomes `run_turn` with a fresh `Conversation` (behaviour unchanged; existing tests stay green). Steps and `max_steps` count per turn.

`RunCommand` is not a built-in looked up by name (it needs an approver); `pangu` constructs it and adds it to `Harness.tools` when `effective.tools` contains `run_command`. `builtin_tool("run_command")` stays `None`, so the app's Build stage can never get it.

- [ ] **Step 1: Write failing tests** in `commands.rs` with a `struct Fixed(Approval, Mutex<u32>)` approver counting calls:

```rust
#[test] fn denied_commands_do_not_run() // Fixed(Deny): run "touch made.txt" → !ok, output "the user denied this command", file absent
#[test] fn once_runs_and_asks_again() // Fixed(Once): "echo ORD-2041" twice → both ok, output contains "exit code 0" and "ORD-2041", approver called 2 times
#[test] fn always_here_is_remembered() // Fixed(AlwaysHere): run "echo hi" twice → approver called once; remember callback received "echo hi" once
#[test] fn always_allowed_skips_the_prompt() // always_allowed ["echo hi"]: approver never called
#[test] fn failing_and_slow_commands_report() // "exit 3" → !ok, "exit code 3"; timeout 1 s with "sleep 5" → !ok, output contains "timed out after 1 s"
```

and in `harness.rs`:

```rust
#[test] fn a_conversation_carries_over_between_turns() // turn 1 reply "Hi"; turn 2 reply "Again" → second request's messages contain the system message once, user prompt 1, assistant "Hi", user prompt 2
```

- [ ] **Step 2: Run** `cargo test -p agent-runtime commands harness` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test --workspace` → PASS.
- [ ] **Step 5: Commit** `git commit -m "Add run_command with approvals and multi-turn conversations"`

---

### Task 3: Shared OpenAI-compatible provider crate

**Files:**
- Create: `crates/provider-openai/Cargo.toml`, `crates/provider-openai/src/lib.rs`
- Modify: root `Cargo.toml` (member), `apps/panguyuban-desktop/src-tauri/Cargo.toml` (dep), `apps/panguyuban-desktop/src-tauri/src/provider.rs`

**Interfaces:**
- Consumes: `agent_runtime::{AgentRuntime, ChatModel, ChatReply, ToolCall, RuntimeError}`, `panguyuban_core::storage::SqliteStore`.
- Produces:
  - `pub struct OpenAiCompat { pub base_url: String, pub api_key: Option<String> }` implementing `AgentRuntime` (the current `complete`) and `ChatModel` (the current `chat`), with `reqwest::blocking` (features `json`, `rustls-tls`, `blocking`; `default-features = false`) and the existing messages and error mapping moved verbatim (`require_model`, `http_error`, the tools-unsupported copy, empty-`tools` omission, `parse_chat`, `parse_tool_reply`, `normalize_base`, `connect_error`).
  - `#[derive(Deserialize, Clone, Debug)] #[serde(rename_all = "camelCase")] pub struct SavedProvider { pub id: String, pub name: String, pub base_url: String }`
  - `pub fn saved_providers(store: &SqliteStore) -> Result<Vec<SavedProvider>, String>` (`app_data` `providers`; missing → empty)
  - `pub fn provider_key(id: &str) -> Result<Option<String>, String>` — keychain service `com.ansar.panguyuban`, account `provider:{id}`; missing or blank → `None`. (keyring 3 with `apple-native`, `windows-native`, like the app.)
- The app's `provider.rs` keeps its keychain cache, `set_key`/`delete_key`/`has_key`, async `models()`, `runtime_for`, `task_runtime_for`, `HARNESS_PREFIX`, `unsupported`; `saved_runtime` returns `OpenAiCompat`. The `tauri::async_runtime::block_on` use disappears.

The existing provider tests move with the code (parse tests, tools-unsupported mapping, empty tools). Add:

```rust
#[test] fn no_key_sends_no_auth_header() // build the request via a helper `fn chat_request(&self, body: &Value, timeout: Duration) -> reqwest::blocking::RequestBuilder`; .build() has no Authorization header when api_key is None, and "Bearer k" when Some("k")
#[test] fn saved_providers_are_read_from_app_data() // SqliteStore::open_in_memory, set_app_data("providers", r#"[{"id":"x","name":"Local","baseUrl":"http://localhost:1/v1"}]"#) → one provider named "Local"; nothing saved → empty
```

- [ ] **Step 1: Move tests and add the two above** in the new crate → **Step 2: Run** `cargo test -p provider-openai` → FAIL (crate code missing).
- [ ] **Step 3: Implement** the crate and switch the app to it.
- [ ] **Step 4: Run** `cargo test --workspace` and `cargo build -p panguyuban-desktop` → PASS.
- [ ] **Step 5: Commit** `git commit -m "Share the OpenAI-compatible provider between the app and pangu"`

---

### Task 4: `pangu` sessions and hooks (`check`, `record`, `allow`) with the Claude adapter

**Files:**
- Create: `crates/pangu-cli/Cargo.toml` (bin `pangu`; deps `agent-runtime`, `panguyuban-core`, `provider-openai`, `serde`, `serde_json`, `dirs = "5"`; dev `tempfile = "3"`), `crates/pangu-cli/src/main.rs`, `src/session.rs`, `src/hook.rs`
- Modify: root `Cargo.toml` (member)

**Interfaces:**
- Consumes: `decide`, `Action`, `Decision`, `PolicyContext`, `relative_to`, `Workspace`, `session_type`, `effective`, `HarnessSettings`, `SqliteStore`.
- Produces (`session.rs`):
  - `pub fn find_root(start: &Path) -> PathBuf` — nearest ancestor (including `start`) containing a `.git` entry, else `start`
  - `pub fn data_dir() -> PathBuf` (`data_local_dir()/panguyuban`), `pub fn open_store() -> Result<SqliteStore, String>` (`data_dir()/state.db`)
  - `pub fn folder_slug(root: &Path) -> String`
  - `pub struct Session { pub id: String, pub root: PathBuf }`; `pub fn Session::start(root: PathBuf) -> Session` (id = `<unix seconds>-<pid>`); `pub fn Session::from_env() -> Option<Session>` (`PANGU_SESSION` + `PANGU_ROOT`, both required); `pub fn Session::env(&self) -> [(&'static str, String); 2]`; `pub fn Session::record_path(&self) -> PathBuf` (`data_dir()/runs/<slug>/<id>.jsonl`)
  - `pub fn append_record(path: &Path, line: serde_json::Value)` (creates dirs; failures ignored); `pub fn count_calls(path: &Path) -> u32` (lines with `"type":"call"`)
  - `pub fn allowed_commands(store, root) -> Vec<String>`, `pub fn remember_command(store, root, command) -> Result<(), String>` (`app_data` `pangu-allowed`)
  - `pub fn policy_context(store, session: &Session) -> Result<PolicyContext, String>` — `work-on-project` session type, `effective` with that id's entry from `app_data` `harness` (same JSON shape the app's `load_harness_settings` reads), `always_allowed`, `steps_so_far = count_calls(record)`
- Produces (`hook.rs`):
  - `pub enum Agent { Claude }` (agy/hermes come in later phases)
  - `pub fn claude_action(payload: &serde_json::Value) -> Action` — `tool_name` + `tool_input`: `Read`→Read(`file_path`), `Glob`/`Grep`→Read(`path`, default "."), `Edit`/`Write`/`MultiEdit`→Write(`file_path`), `NotebookEdit`→Write(`notebook_path`), `Bash`→Run(`command`), anything else → Other(name)
  - `pub enum HookOutcome { Silent, Deny(String) }`; `pub fn check(agent: Agent, stdin: &str, session: Option<&Session>, ctx: impl FnOnce(&Session) -> Result<PolicyContext, String>) -> HookOutcome` — no session → Silent; bad JSON or ctx error → Deny(reason); decide → Deny only for `Decision::Deny`, else Silent; appends `{"type":"decision", action, decision, reason}` to the record
  - `pub fn record(agent: Agent, stdin: &str, session: &Session)` — appends `{"type":"call","tool":…,"input":<tool_input truncated to 2 000 chars>}`
- `main.rs` subcommands: `pangu check --agent claude` (Deny → reason on stderr, exit 2; Silent → exit 0, no output; whole body in `std::panic::catch_unwind`, panic inside a session → exit 2 "pangu check failed"), `pangu record --agent claude` (always exit 0), `pangu allow "<command>"` (uses `Session::from_env()` root, else `find_root(cwd)`; prints `Always allowed in <root>: <command>`).

- [ ] **Step 1: Write failing tests** (tempdir repos; payloads as JSON literals with neutral data):

```rust
// session.rs
#[test] fn the_folder_is_the_git_root() // tmp/repo/.git + tmp/repo/src → find_root(src) == repo; no .git anywhere → start itself
#[test] fn slugs_are_path_safe() // folder_slug("/Users/sam/code/orders-api") == "-Users-sam-code-orders-api"
#[test] fn calls_are_counted_from_the_record() // append 2 call lines + 1 decision line → count_calls == 2; missing file → 0
#[test] fn remembered_commands_are_per_folder() // in-memory store: remember(root A, "npm test") → allowed(A) == ["npm test"], allowed(B) empty
// hook.rs
#[test] fn claude_tools_map_to_actions() // Edit{file_path} → Write; Bash{command:"npm test"} → Run("npm test"); Grep{} → Read("."); TodoWrite → Other("TodoWrite")
#[test] fn claude_writes_are_checked_by_absolute_path() // ctx root = repo: Write "<repo>/src/a.ts" → Silent; "/etc/hosts" → Deny("writes outside the project are not allowed"); "<repo>/.git/config" → Deny("the .git folder is off limits")
#[test] fn outside_a_session_check_is_inert() // session None → Silent, ctx closure never called
#[test] fn bad_input_inside_a_session_denies() // stdin "not json" → Deny; ctx returns Err("db") → Deny containing "db"
#[test] fn asks_are_silent_for_claude() // Bash "rm -rf build" (not always-allowed) → Silent; Settings with run_command off → Deny("commands are switched off in Settings")
```

- [ ] **Step 2: Run** `cargo test -p pangu-cli` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test --workspace` → PASS. Then manual: `echo '{}' | PANGU_SESSION= ./target/debug/pangu check --agent claude; echo $?` → `0`; `echo 'x' | PANGU_SESSION=1 PANGU_ROOT=/tmp ./target/debug/pangu check --agent claude; echo $?` → `2`.
- [ ] **Step 5: Commit** `git commit -m "pangu: sessions and guard-rail hooks for Claude Code"`

---

### Task 5: `pangu` — the own-loop REPL

**Files:**
- Create: `crates/pangu-cli/src/repl.rs`
- Modify: `crates/pangu-cli/src/main.rs`

**Interfaces:**
- Consumes: Task 2 `Conversation`, `run_turn`, `RunCommand`, `Approver`, `Approval`; Task 3 `OpenAiCompat`, `saved_providers`, `provider_key`; Task 4 `Session`, `find_root`, `open_store`, `policy_context`, `remember_command`, `append_record`; `tools_named`, `hooks_named`, `build`-style skill loading.
- Produces:
  - `pub struct Choice { pub provider: SavedProvider, pub model: String }`
  - `pub fn choose(providers: &[SavedProvider], saved: Option<(String, String)>, flag_provider: Option<&str>, flag_model: Option<&str>) -> Result<Choice, String>` — flags win (provider matched by id or case-insensitive name); else saved pair if that provider still exists; else the only provider when exactly one exists **and** a model is known (flag or saved); otherwise `Err` with copy: no providers → `No provider saved. Add one in Panguyuban → Settings → Providers, or run \`pangu claude\`.`; provider but no model → `Pick a model: pangu --model <id>`; several providers → `Several providers saved; pick one: pangu --provider <name> --model <id>`
  - `pub fn system_prompt(root: &Path) -> String` — `work-on-project` skill + every engineering skill (`engineering_skills = ["*"]`: `skills/engineering/*/SKILL.md`, compiled in with `include_str!`, frontmatter stripped) + a "How this session runs" section naming the folder, the tools, that commands ask first and `.git` is off limits.
  - `pub fn run(args: &[String]) -> i32` — the REPL.

REPL behaviour: header `Panguyuban agent · <provider name> · <model> · <root>`; prompt `> `; each line = one `run_turn` with `Task { system, prompt: line, model, work_dir: root, write_paths: ["*"], max_steps: effective.max_steps, timeout: effective.timeout, record: Some(session.record_path()) }` on one `Conversation`; tools = `tools_named(effective.tools without run_command)` + `RunCommand` when enabled (approver = `TtyApprover` reading one char from `/dev/tty` after printing `  ▶ wants to run: <cmd>  [y] allow  [a] always here  [n] deny`; `remember` = `remember_command`); events print `  ✓ <summary>` / `  ✗ <summary>` and messages indented; then the final message or `Stopped: <reason>`. Saves the choice to `app_data` `pangu` after the first successful turn. `exit` or EOF quits. Ctrl-C during a turn sets the cancel flag (via a `ctrlc`-free approach: a signal handler using `libc::signal` is acceptable, or leave Ctrl-C as process exit — builder's call, state it in the report).

- [ ] **Step 1: Write failing tests** for `choose` and `system_prompt`:

```rust
#[test] fn flags_win() // providers [Local, Router]; flags ("router", "qwen") → Router/qwen
#[test] fn the_saved_choice_is_reused() // saved ("x","m1") with x present → x/m1; saved provider deleted → falls through
#[test] fn one_provider_still_needs_a_model() // [Local], no saved, no flags → Err("Pick a model: pangu --model <id>")
#[test] fn no_provider_points_to_settings() // [] → Err containing "Settings → Providers" and "pangu claude"
#[test] fn the_prompt_names_the_folder_and_rules() // system_prompt("/tmp/orders-api") contains "/tmp/orders-api", ".git", "## How this session runs", not "---\nname:"
```

- [ ] **Step 2: Run** `cargo test -p pangu-cli repl` → FAIL.
- [ ] **Step 3: Implement** `repl.rs` and wire `pangu` with no subcommand (flags `--provider`, `--model`) to `repl::run`.
- [ ] **Step 4: Run** `cargo test --workspace` → PASS; `./target/debug/pangu` in a temp folder with an empty data dir (`HOME=<tmp>`) prints the no-provider message and exits 1.
- [ ] **Step 5: Commit** `git commit -m "pangu: the own-loop REPL with app providers and command approvals"`

---

### Task 6: `pangu claude`

**Files:**
- Create: `crates/pangu-cli/src/claude.rs`
- Modify: `crates/pangu-cli/src/main.rs`

**Interfaces:**
- Consumes: Task 4 `Session`, `find_root`, `data_dir`, `append_record`; Task 5 skill texts (reuse the same compiled-in skills).
- Produces:
  - `pub fn write_plugin(dir: &Path) -> std::io::Result<()>` — rewrites `dir` with `.claude-plugin/plugin.json` (`{"name":"panguyuban","description":"Panguyuban skills and rules","version":"<crate version>"}`) and `skills/<name>/SKILL.md` for `work-on-project` and each engineering skill (files written with their original frontmatter).
  - `pub fn hook_settings(pangu: &Path) -> serde_json::Value` — `{"hooks":{"PreToolUse":[{"matcher":".*","hooks":[{"type":"command","command":"<pangu> check --agent claude","timeout":10}]}],"PostToolUse":[{"matcher":".*","hooks":[{"type":"command","command":"<pangu> record --agent claude","timeout":10}]}]}}` with `<pangu>` the absolute, shell-quoted path of the running binary (`std::env::current_exe`).
  - `pub fn run(args: &[String]) -> i32` — `claude` must be on PATH (else `Claude Code (claude) is not installed or not on PATH` exit 1); root = `find_root(cwd)`; `Session::start`; record `{"type":"start","agent":"claude","root":…}`; `write_plugin(data_dir()/claude-plugin)`; exec `claude --settings <json string> --plugin-dir <dir> <args…>` with the session env vars set (unix `CommandExt::exec`; the session end is not recorded since exec replaces the process).

- [ ] **Step 1: Write failing tests:**

```rust
#[test] fn the_plugin_has_the_skills() // write_plugin(tmp) → tmp/.claude-plugin/plugin.json name "panguyuban"; tmp/skills/work-on-project/SKILL.md exists and starts with "---"
#[test] fn hooks_call_this_binary() // hook_settings("/Applications/Panguyuban.app/Contents/MacOS/pangu") → PreToolUse[0].hooks[0].command == "'/Applications/Panguyuban.app/Contents/MacOS/pangu' check --agent claude"; PostToolUse uses "record"
#[test] fn rewriting_the_plugin_drops_old_skills() // put tmp/skills/old/SKILL.md, write_plugin(tmp) → old gone
```

- [ ] **Step 2: Run** `cargo test -p pangu-cli claude` → FAIL.
- [ ] **Step 3: Implement** and route `pangu claude [args…]`.
- [ ] **Step 4: Run** `cargo test --workspace` → PASS. Manual check left to the user (needs a Claude login): in a repo, `pangu claude`, ask it to edit `.git/config` → blocked with "the .git folder is off limits"; ask it to edit a file in the repo → Claude's normal prompt appears; the session's `runs/…jsonl` shows decision and call lines.
- [ ] **Step 5: Commit** `git commit -m "pangu claude: Claude Code with Panguyuban skills and guard rails"`

---

### Task 7: Ship `pangu` inside the app and link it onto PATH

**Files:**
- Create: `scripts/build-pangu.sh`
- Modify: `apps/panguyuban-desktop/src-tauri/tauri.conf.json`, `apps/panguyuban-desktop/package.json`, `apps/panguyuban-desktop/src-tauri/src/lib.rs`, `apps/panguyuban-desktop/src/api.ts`, `apps/panguyuban-desktop/src/HarnessSettings.tsx`, `.gitignore`

**Interfaces:**
- Produces:
  - `scripts/build-pangu.sh [debug|release]` — `cargo build -p pangu-cli` (with `--release` for release), then copies `target/<profile>/pangu` to `apps/panguyuban-desktop/src-tauri/binaries/pangu-<host triple>` (triple from `rustc -vV`). `binaries/` is git-ignored.
  - `tauri.conf.json`: `"bundle": { …, "externalBin": ["binaries/pangu"] }`; `beforeDevCommand` = `sh ../../scripts/build-pangu.sh debug && npm run dev`; `beforeBuildCommand` = `sh ../../scripts/build-pangu.sh release && npm run build` (paths relative to `apps/panguyuban-desktop`; verify Tauri's working directory and adjust).
  - `fn cli_link_target() -> Option<PathBuf>` — first of `/opt/homebrew/bin`, `/usr/local/bin` that exists and is writable.
  - `#[tauri::command] fn install_pangu() -> Result<String, String>` — source = `current_exe().parent()/pangu` (must exist, else `pangu is not bundled in this build`); replaces an existing symlink at `<target>/pangu` (refuses to replace a regular file: `<path> exists and is not a link; remove it first`); returns the link path. `#[tauri::command] fn pangu_status() -> Option<String>` — the link path if `<target>/pangu` is a symlink to the bundled binary.
  - `api.ts`: `installPangu(): Promise<string>`, `panguStatus(): Promise<string | null>` (null outside the desktop app).
  - `HarnessSettings.tsx`: under the section heading, a row `Command line` with text `Use the agent from any terminal: run pangu, or pangu claude.` and a button **Install `pangu` command** (or `Installed at <path>` with **Reinstall**), status line on error.

- [ ] **Step 1: Write failing tests** in `lib.rs` (or a small `cli_link.rs` module): `#[test] fn links_are_replaced_but_files_are_not()` — with a helper `fn link_into(dir: &Path, source: &Path) -> Result<PathBuf, String>` on tempdirs: no file → link created; existing link → replaced; existing regular file → Err containing "is not a link".
- [ ] **Step 2: Run** `cargo test -p panguyuban-desktop link` → FAIL.
- [ ] **Step 3: Implement** script, config, commands, UI.
- [ ] **Step 4: Run** `cargo test --workspace`, `npm run build` → PASS; `sh scripts/build-pangu.sh debug` creates `apps/panguyuban-desktop/src-tauri/binaries/pangu-<triple>`; `npm run desktop:build` produces `Panguyuban.app/Contents/MacOS/pangu` (check with `ls`).
- [ ] **Step 5: Commit** `git commit -m "Ship pangu inside the app and link it onto PATH from Settings"`
