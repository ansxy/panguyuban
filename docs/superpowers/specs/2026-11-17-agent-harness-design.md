# Agent harness — design

Date: 2026-11-17
Status: Draft

## Intent

Today every agent in Panguyuban either talks without tools (`AgentRuntime::complete`:
text in, text out) or is someone else's harness (Claude Code, Antigravity). The app
cannot let an agent read and change files unless `claude` or `agy` is installed, and
then that tool, not the app, decides what the agent may do.

This adds Panguyuban's own harness: a loop that asks a model for its next step, runs the
tool it asks for after the app's own checks, sends the result back, and repeats until
the model is done. It works with any model saved under Settings → Providers. It sits
behind one task contract that Claude Code and Antigravity can also be adapted to later,
so the Build stage does not care which agent does the work.

The first job is the Build stage of the guided builder: build one story from the
approved `prd.md`. That stage is simulated today, and the guided-builder design leaves
open "how to limit an agent to the project folder and a set of commands, and how to
pass it the engineering skills". This design answers it for files; commands come with
the next version.

**Scope of this version (chosen by the user): a static web app, no commands.** The agent
builds one self-contained `app/index.html` (HTML, CSS and JS inline), starting from the
approved `design.html`, story by story. It cannot run anything. The user checks each
story in the same locked preview frame the prototype already uses.

## Goals

- A **task contract** in `crates/agent-runtime`, next to `complete()`, that any agent
  can implement: give it instructions, a folder and a policy; get back a stream of
  events and a final outcome; stop it at any time.
- **Our harness** implementing that contract over the existing OpenAI-compatible
  provider (`provider:<id>`), using the chat API's tool calling.
- **Tools**: read a file, list files, search text, write a file, edit a file.
- **Checks before every tool call**, enforced in code: the path stays inside the
  project folder, and writes only match the session type's `write_paths` in
  `skills/registry.toml`.
- **Live steps in the UI** while a story builds: each tool call as one line ("read
  prd.md", "edited app/index.html"), then the agent's final message. A Stop button.
- **A preview of the built app** in the existing locked frame.
- **A record of every run** in the project folder, so the handover carries what the
  agent did.
- A minimal `build-story` product skill so the Build stage has instructions to run.
- **Modular parts.** The loop knows nothing specific: the model, each tool and each
  hook (a check before or after a tool call) plug in through small interfaces, and
  which ones a session uses is listed by name in `skills/registry.toml`.
- **Customizable in Settings, narrow only.** An **Agent harness** section in Settings
  turns tools and hooks off or on and lowers the step and time limits, per session
  type. The registry is the ceiling: Settings can never add a tool, widen write paths
  or raise a limit past it. The folder boundary and write paths are shown locked.

## Non-goals (this version)

- Running commands of any kind (npm, tests, linters), project templates, dev servers,
  sandboxing. That is the next version: a real npm app in a macOS sandbox, its own
  design.
- More than one app file, a backend or a database.
- Claude Code and Antigravity adapters for the task contract. The contract must fit
  them (see Approaches); they come next, Claude Code first, Antigravity after checking
  what `agy` can restrict and stream.
- Ask-the-user permission popups.
- Context compaction, memory across sessions, subagents, MCP, web access.
- Set up and the standards checks. They stay simulated.
- Using the harness outside the Build stage (Spaces, tickets, PRs).
- Changing the existing text-only steps (interview, design, plan, review). They keep
  using `complete()`.

## Anti-goals

- The model reaching the machine any way other than through a checked tool. No path is
  used before it is resolved and checked.
- The agent changing `prd.md`, `design.html`, `plan.json` or anything outside its write
  paths. Those belong to the user and the app.
- Asking a non-technical user to judge a technical action.
- Silent truncation of what happened. Every step the agent took is in the run record,
  even if the UI shows a summary.

## Constraints

- Rust crate `crates/agent-runtime`, Tauri 2 app in `apps/panguyuban-desktop`. Builder
  commands already run agent calls inside `spawn_blocking`, and `OpenAiCompatRuntime`
  blocks on the Tauri async runtime from there (`provider.rs`); the loop follows the
  same pattern.
- Provider keys stay in the keychain and never reach the UI (as today).
- Project folder is `<Documents>/Panguyuban/<name>-<id>` (`builder::project_dir`).
- Policy comes from `skills/registry.toml`, compiled into the binary. Only
  `library_version` is read today, by scanning lines.
- The prototype preview is an iframe with `sandbox="allow-scripts allow-forms"` and
  `srcDoc={lockedDesign(html)}` (`Builder.tsx`, `Design.tsx`). A `srcDoc` cannot load
  sibling files, which is why the app is one file.
- Not every model calls tools well, and some providers reject the `tools` field. The
  harness cannot fix a weak model; it must fail with a clear message instead.

## Approaches

| | Approach | Trade-off |
|---|---|---|
| **A (chosen)** | Own small harness in `agent-runtime`: loop + tools + checks, over the existing provider runtime | Works with any model, full control of checks and events; we maintain it, and it is simpler than Claude Code |
| B | Wrap an existing open-source harness (opencode, Goose, Hermes Agent) as another CLI runtime | Least code and a mature agent; still an external install, and its own rules, not ours, decide what it may touch |
| C | Full Claude Code / Hermes-style harness from the start (memory, compaction, subagents, MCP) | Most capable eventually; months before the Build stage gets anything |

The user chose A, starting with one job and growing from real use, with Claude Code
then Antigravity adapters on the same contract afterwards.

For what the first version builds, three options were weighed: a static one-file app
with no commands (chosen), a real npm app with commands in a macOS sandbox, and a real
npm app with only a command allowlist. The builder check showed the allowlist alone
does not hold: the agent can write `package.json` scripts and then run an allowed
`npm test`. The user chose the static app first.

## Design

### Shape

```
Builder.tsx (Build stage, one story)
   │ invoke build_story(story, agent)          ▲ Channel<TaskEvent>
   ▼                                           │
src-tauri builder.rs: run_build_story ─────────┘
   │ policy from registry, folder, skills, cancel flag
   ▼
agent-runtime: TaskRuntime::run_task(task, cancel, on_event)
   ├── provider:<id>  → harness loop (this design)
   │                      └── ChatModel trait ← provider.rs implements it
   ├── claude         → later: claude -p --output-format stream-json --allowedTools …
   └── antigravity    → later
```

### The task contract (in `crates/agent-runtime`)

A second trait beside `AgentRuntime`, so the text-only steps are untouched:

```rust
pub trait TaskRuntime: Send + Sync {
    fn harness(&self) -> &'static str;
    fn run_task(
        &self,
        task: &Task,
        cancel: &AtomicBool,
        on_event: &dyn Fn(TaskEvent),
    ) -> Result<TaskOutcome, RuntimeError>;
}

pub struct Task {
    pub system: String,        // skill + engineering skills + run rules
    pub prompt: String,        // the story and its acceptance lines
    pub model: Option<String>,
    pub work_dir: PathBuf,     // the project folder; nothing outside it
    pub write_paths: Vec<String>, // from the registry; "*" = whole work_dir
    pub max_steps: u32,
    pub timeout: Duration,     // whole task
}

pub enum TaskEvent {
    Step { tool: String, summary: String, ok: bool }, // one line per tool call
    Message(String),                                  // text the agent says between steps
}

pub struct TaskOutcome {
    pub message: String, // the agent's final message
    pub steps: u32,
    pub stopped: Option<StopReason>, // MaxSteps | TimedOut | Cancelled; None when finished
}
```

A Claude Code adapter would map `write_paths` to `--allowedTools` / permission flags,
run in `work_dir`, kill its process when `cancel` is set, and turn `stream-json` lines
into `TaskEvent`s. The contract asks nothing an external harness cannot provide; that
is the test for any change to it. Commands, when they come, are a new field on `Task`,
not a new signature.

### The loop (our harness)

1. `messages = [system, user prompt]`; send with the tool definitions.
2. If the reply has tool calls: for each, check it (below), run it or refuse it, emit a
   `Step`, append the result (or the refusal reason) as a tool message. Go to 1.
3. If the reply has no tool calls: that text is the final message. Done.
4. Stop with a `StopReason` at `max_steps`, at `timeout`, or when `cancel` is set
   (checked before each model call and each tool call). The outcome still carries what
   was done.

A refused call is not an error: the model is told why ("writes are limited to
app/index.html") and can try something else.

The loop and tools live in `agent-runtime`, behind a small `ChatModel` trait (send
messages and tool definitions, get back text and/or tool calls). `provider.rs`
implements it with the tool-calling request and response (`tools`, `tool_calls`,
`role: tool` messages), since `OpenAiCompatRuntime` lives in the app crate and uses
`tauri::async_runtime`. Tests use a fake `ChatModel`. If the provider rejects `tools`,
the task fails with "This model or provider does not support tools; pick another model".

### Tools

All paths are relative to `work_dir`, resolved, and rejected if they leave it
(including through `..` and symlinks).

| Tool | Does | Check |
|---|---|---|
| `read_file(path)` | returns the text | inside `work_dir` |
| `list_files(pattern)` | glob | inside `work_dir` |
| `search(text, path?)` | matching lines with file and line number | inside `work_dir` |
| `write_file(path, content)` | creates or replaces | matches `write_paths` |
| `edit_file(path, old, new)` | replaces one exact, unique occurrence | matches `write_paths`; fails if `old` is missing or not unique |

Tool output sent back to the model is capped (size left to the builder) with a note
that it was cut; the full output goes to the run record.

### Plug-in parts

```rust
pub trait Tool: Send + Sync {
    fn name(&self) -> &'static str;
    fn definition(&self) -> Value;                        // what the model sees
    fn run(&self, ws: &Workspace, args: &Value) -> ToolResult;
}

pub trait Hook: Send + Sync {
    fn name(&self) -> &'static str;
    fn before(&self, call: &ToolCall, args: &Value) -> Result<(), String> { Ok(()) } // Err = refuse
    fn after(&self, call: &ToolCall, ws: &Workspace, result: &mut ToolResult) {}     // may add a note
}

pub struct Harness {
    pub chat: Box<dyn ChatModel>,
    pub tools: Vec<Box<dyn Tool>>,
    pub hooks: Vec<Box<dyn Hook>>,
}
```

Tools and hooks are looked up by name from the built-in set. Adding one later (a
command tool, an HTML check) is one new type plus its name in the registry; the loop
does not change.

- **Fixed, not a plug-in:** `Workspace` (folder boundary and `write_paths`). Every tool
  touches files only through it, so no setting or missing hook can remove those
  checks. The run record is also part of the loop, not a hook, because the handover
  depends on it.
- **Hooks in this version:** `no_external_urls`. After a successful write or edit, if
  the file contains `http://` or `https://`, the tool result gets a note that the
  preview blocks external URLs, so the model can inline or remove them.

### Registry

`build-next-story` in `skills/registry.toml` changes to this version's scope:
`write_paths = ["app/index.html"]`, `shell = false`, `status = "ready"` once the
`build-story` skill exists, plus the ceiling for the harness:

```toml
tools           = ["read_file", "list_files", "search", "write_file", "edit_file"]
hooks           = ["no_external_urls"]
max_steps       = 40
timeout_minutes = 15
```

The registry is parsed with a TOML parser, replacing the line scan.

### Settings (narrow only)

A new **Agent harness** section on the Settings page, built like the Providers
section, one block per session type that has `tools` (today only "Build the next
step"):

```
Agent harness
 Build the next step
  Tools    ☑ Read files  ☑ List files  ☑ Search  ☑ Write whole file  ☑ Edit part of file
  Checks   ☑ Warn about links the preview blocks
  Limits   Max steps [ 40 ] (1–40)   Time limit [ 15 ] min (1–15)
  Always on  🔒 Stays inside the project folder   🔒 Writes only app/index.html
                                                   [ Reset to defaults ]  [ Save ]
```

Saved in the app database (`app_data` key `harness`) as JSON per session type: the
tools and hooks switched on, `maxSteps`, `timeoutMinutes`. Rust applies it when a
build starts: `effective = registry ∩ saved` for tools and hooks, limits clamped to
`1..=registry value`; unknown names are ignored, and nothing saved means the registry
values. The UI only shows the choices; the narrowing is enforced in Rust, so a stale
or edited saved value can never widen anything. Turning off every write tool is
allowed (the agent can then only read and report); the step list will show its
refusals.

### What the agent is given

Before the first story, the app (not the agent) copies `design.html` to
`app/index.html` if that file does not exist yet, so building starts from the
prototype the user approved.

System prompt = `build-story` skill + every engineering skill the session type allows
+ a short "How this session runs" section (the tools, the folder, the one file it may
write, "keep everything in that one file, no external URLs, finish with a summary of
what you built and which acceptance lines you think pass"), in the same way
`interview_system_prompt` adds run rules today. Skills are compiled in with
`include_str!`, as the others are.

Prompt = the story's heading, text and acceptance lines from `prd.md`, plus the PRD
itself for context.

### Run record

Each run appends JSON lines to `<project>/.panguyuban/runs/<story-id>-<timestamp>.jsonl`:
the task (without the system prompt text), every model reply, every tool call with its
full result or refusal, and the outcome. Handover can point to these files.

### UI

On the Build stage, building a story calls a new Tauri command with a
`tauri::ipc::Channel<TaskEvent>`. The story shows a live list of steps as they arrive,
a Stop button, and the final message when done. The preview shows `app/index.html`
through the existing `lockedDesign` frame, and the user confirms acceptance lines
against it as the guided-builder design already describes.

Which agent builds is the existing agent choice for the story; the harness is used when
that agent's harness is `provider:<id>`. Choosing `claude` or `antigravity` for a build
story says "not supported yet" until their adapters exist.

## Decisions (my calls, open to correction)

- **First job is the Build stage, not the prototype.** The prototype already works
  without tools.
- **One app file.** The preview frame uses `srcDoc`, which cannot load sibling files.
  Ceiling: big apps make one big file; serving a folder through Tauri's asset protocol
  lifts it when needed.
- **No permission popup.** Write paths decide; nothing in this version is risky enough
  to ask about.
- **No new harness string.** `provider:<id>` means "our harness with that provider's
  model" for tasks, and "one plain turn" for `complete()`.
- **Channel, not global events**, for streaming steps: it is scoped to the one call.
- **No context compaction.** `max_steps` and the output cap bound the conversation.
  Ceiling: long stories on small-context models will hit the model's limit; add
  compaction when that happens in real use.
- **Runs can be stopped.** The cancel flag is in the contract now so the Claude Code
  and Antigravity adapters (which kill their process) do not change the signature later.
- **Autopilot uses the project's provider.** `routedAgent` in `builder_flow.ts` only
  picks from the fixed claude/antigravity list. For Build, when the project's chosen
  harness is `provider:<id>`, autopilot routes every story to it with the project's
  model; manual assignment still works.
- **What a run does to the story.** Finished → `built`, waiting for the user's
  confirmation as today. Stopped (max steps, timeout, Stop) or failed (provider error,
  no tool support) → stays `todo` with the reason, a Retry, and "Ask an engineer" as
  the guided-builder rules offer. Because standards checks stay simulated, a real build
  no longer sets `checksPassing: true`; the UI says checks are not run yet instead of
  claiming they pass.
- **Undo is off for real builds.** Undo only resets status today, and the harness
  changes the file. Until an app-owned snapshot per story exists, Undo is hidden for
  stories the harness built. Upgrade path: keep a copy of `app/index.html` per story
  and restore it.

## Left to the builder

- Tool output size cap.
- The `build-story` skill text (short; it can grow with use).
- Glob and search implementation (an existing dependency if one fits, else std).
- Where the step list and Stop button sit in the Build stage layout.
- Tests: path escape cases (`..`, absolute paths, symlinks), `write_paths` matching,
  `edit_file` missing/duplicate, parsing of tool-call replies, registry parsing, and
  the loop stopping at `max_steps`, timeout and cancel, with a fake `ChatModel`.
