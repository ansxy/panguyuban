# pangu: one policy, many agents — design

Date: 2026-11-17
Status: Draft
Builds on: `2026-11-17-agent-harness-design.md` (the harness, `Workspace`, registry ceiling, Settings narrowing)

## Intent

The user works in Spaces terminals with several coding agents (Claude Code, Antigravity,
Hermes, and Panguyuban's own harness). They want **one place** that decides how any of
them works on a project: which skills they follow, what they may read, write and run,
the limits, and a record of what they did. The agent is swappable; the rules are not.

`pangu` is a terminal command that provides that place:

- `pangu` runs Panguyuban's own loop with a provider saved in the app (OpenRouter, a
  Claude API key, a local server…).
- `pangu claude`, `pangu agy`, `pangu hermes` launch those agents with Panguyuban's
  skills added and Panguyuban's checks wired into their pre-tool hooks, so every file
  write and command they attempt is decided by the same Rust code that guards the
  harness loop.

A throwaway spike (`pangu-spike` branch, `crates/pangu-cli`) showed the terminal
experience and the Claude Code fallback. It read the provider from env vars, had no
shared checks for external agents and forgot the conversation between lines.

## Goals

- **One policy core** in `crates/agent-runtime`: given a normalized action (read, write,
  run, other) in a folder, decide allow / deny / ask, using `Workspace` and the
  registry ceiling narrowed by Settings → Agent harness.
- **`pangu`** (own loop): multi-turn conversation in the terminal, provider and model
  from the app, the five file tools plus `run_command` with a y / a / n prompt.
- **`pangu claude`**: Claude Code with our skills (`--plugin-dir`) and our
  PreToolUse / PostToolUse hooks passed per launch (`--settings`), nothing written
  into the user's Claude config or repo.
- **`pangu agy`** and **`pangu hermes`**: the same policy through their hook systems.
- **One run record** per session for every agent, in the app's data folder, never in
  the user's repo.
- **One Settings section**: a new "Work on a project" session type appears in
  Settings → Agent harness and narrows every agent the same way.

## Non-goals

- A Spaces panel UI (the terminal is the surface for now).
- Replacing any agent's own tools (approach 2 below).
- Enforcing per-agent model or cost limits; time limits for external agents.
- Windows support for `pangu` (macOS first; Linux should build).
- Sandboxing commands. Commands are approved by the user, not contained.

## Anti-goals

- `pangu` loosening an agent. For Claude Code, Antigravity and Hermes, Panguyuban only
  **adds guard rails**: its hook either denies or stays silent, never answers "allow",
  so the agent's own permission prompts and the user's own "always allow" choices work
  exactly as without `pangu` (chosen by the user, option A). A hook that fails, times out
  or crashes inside a `pangu` session must block, not pass.
- Writing into the user's repo or the agent's global config without asking. Run
  records, generated plugins and profiles live in Panguyuban's data folder; the one
  exception (Antigravity's plugin install) is asked for first.
- Changing how `claude`, `agy` or `hermes` behave when started **without** `pangu`.
- Provider keys leaving the keychain except into the HTTPS request.

## Constraints

- Agents and their hook formats (researched 2026-11-17; verify against the installed
  versions before relying on field names):
  - **Claude Code**: `--settings <json>` adds a session-only settings layer (merges
    with, does not replace, user hooks). PreToolUse stdin has `tool_name`,
    `tool_input`, `cwd`, `session_id`; deny/ask via stdout
    `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"|"ask"|"allow","permissionDecisionReason":"…"}}`
    or exit 2. PostToolUse can add `additionalContext`. Skills per launch via
    `--plugin-dir`. `--max-turns` is print-mode only.
  - **Antigravity (`agy`)**: hooks only from `.agents/hooks.json`, the global
    `~/.gemini/config/hooks.json`, or a **plugin**; no per-launch hook flag.
    PreToolUse stdin has `toolCall{name,args}`, `conversationId`, `workspacePaths`;
    stdout `{"decision":"deny"|"allow"|"ask","reason":…}`; default hook timeout 30 s.
    Skills via plugin. Built-in tools cannot be disabled. `--settings` exists for
    session permissions.
  - **Hermes**: hooks in a profile's `config.yaml` (`hooks.pre_tool_call` with
    `matcher`, `command`, `timeout`, `fail_closed`); block via
    `{"decision":"block","reason":…}` or exit 2; **no "ask"**. Fail-open unless
    `fail_closed: true`. First use of a hook needs consent (`--accept-hooks`).
    `-p <profile>` selects a separate config dir; `-s` preloads skills; any
    OpenAI-compatible model via `--provider custom --base-url --api-key -m`.
- App storage: SQLite at `dirs::data_local_dir()/panguyuban/state.db`; providers in
  `app_data` key `providers` (`[{id, name, baseUrl}]`); keys in the macOS keychain,
  service `com.ansar.panguyuban`, account `provider:<id>`; harness settings in
  `app_data` key `harness`. The app's chosen model per agent lives in the webview's
  localStorage and is **not** readable by `pangu`.
- A keychain item created by Panguyuban.app read by another binary (`pangu`) triggers
  a macOS access prompt once ("Always Allow").
- Hook processes are short-lived: `pangu check` must answer fast (well under the 30 s
  agy default) and must not need the app running.

## Approaches

| | Approach | Trade-off |
|---|---|---|
| **1 (chosen)** | **Hook-based policy hub.** Each agent keeps its own tools; its pre-tool hook calls `pangu check`, which runs one Rust policy; adapters translate hook formats and tool names | Works with all three agents today and keeps their tuned tools; each adapter keeps a tool-name map that needs upkeep |
| 2 | Our tools for everyone over MCP, agents' own tools switched off | Identical tools, but Antigravity cannot switch its built-ins off, and agents do worse with unfamiliar tools |
| 3 | Instructions only (skills / AGENTS.md) | Nothing enforced; rejected |

Chosen by the user after the research above.

## Design

### Shape

```
                  ┌──────────── agent-runtime ─────────────┐
                  │ policy::decide(ctx, action) → Decision  │
                  │ Workspace · registry · settings · record│
                  └───────▲──────────────────▲──────────────┘
                          │ in-process       │ `pangu check` / `pangu record` (hook processes)
   pangu (own loop) ──────┘                  │
   pangu claude ── claude --settings {hooks} --plugin-dir <gen>
   pangu agy    ── agy  (panguyuban plugin with hooks, active only under pangu)
   pangu hermes ── hermes -p panguyuban -s <skills> (profile with fail-closed hooks)
```

### Policy core (`agent-runtime`, new `policy.rs`)

```rust
pub enum Action {
    Read(String),          // path as given by the agent
    Write(String),
    Run(String),           // command line
    Other(String),         // agent tool name we don't map
}

pub enum Decision { Allow, Deny(String), Ask(String) }

pub struct PolicyContext {
    pub workspace: Workspace,          // folder + write_paths
    pub effective: Effective,          // registry ∩ settings for the session type
    pub always_allowed: Vec<String>,   // commands remembered for this folder
    pub steps_so_far: u32,
}

pub fn decide(ctx: &PolicyContext, action: &Action) -> Decision;
```

Rules, in order:
1. `steps_so_far >= effective.max_steps` → Deny "step limit reached".
2. `Read(p)`: inside the folder → Allow if a read tool is enabled, else Deny;
   outside → Ask "reads outside the project".
3. `Write(p)`: `Workspace` resolve + write_paths + never under `.git` (moved into
   `Workspace` as a fixed rule, so `"*"` can never reach `.git`); Deny with the reason
   if any fails; Deny if no write tool is enabled.
4. `Run(c)`: Deny if `run_command` is not enabled; Allow if `c` exactly matches an
   always-allowed entry for this folder; else Ask "run `c`?".
5. `Other(name)`: Ask "unknown tool name".

Paths from external agents may be absolute; `decide` converts an absolute path inside
the folder to relative before `Workspace` checks it.

How a decision reaches each agent (user's choice A: guard rails only):

| Decision | Own loop (`pangu`) | Claude Code / Antigravity / Hermes |
|---|---|---|
| Allow | runs | **silent** (no decision output; the agent's own permission flow decides) |
| Ask | y / a / n prompt | **silent** (the agent's own prompt already asks) |
| Deny | refused, reason to the model | **deny** with the reason, in the agent's format |

So for external agents only the deny rules matter: writes outside the folder or into
`.git`, writes or commands when that tool is switched off in Settings, and the step
limit. `Other` (agent tools we don't map, e.g. Claude's `Skill`, `TodoWrite`, MCP tools)
is silent. The own loop keeps today's strict `Workspace` reads (no reads outside the
folder); rule 2's outside-read Ask therefore only applies conceptually to external
agents, where it is silent.

### Session type

New entry in `skills/registry.toml`, which also appears in Settings → Agent harness:

```toml
[[session_type]]
id                 = "work-on-project"
label_en           = "Work on a project"
skill              = "work-on-project"
engineering_skills = ["*"]
phase              = "build"
write_paths        = ["*"]
shell              = true
tools              = ["read_file", "list_files", "search", "write_file", "edit_file", "run_command"]
hooks              = []
max_steps          = 200
timeout_minutes    = 60
status             = "ready"
```

Plus a short `skills/product/work-on-project/SKILL.md` (how to work in a real repo:
read before editing, small changes, run the project's tests, summarize).

### `run_command` tool and approvals (own loop)

A built-in `run_command { command }` tool in `agent-runtime`. It asks an `Approver`
(trait object passed to the harness) before running:

```rust
pub enum Approval { Once, AlwaysHere, Deny }
pub trait Approver: Send + Sync { fn approve(&self, command: &str) -> Approval; }
```

`pangu` implements it as the terminal y / a / n prompt reading `/dev/tty`. `AlwaysHere`
appends to the folder's always-allowed list. Commands run with `sh -c` in the folder,
a per-command timeout, output capped like other tools, and are killed on cancel.
The decision goes through `policy::decide` first, so Settings and the step limit apply.

### Conversation (own loop)

`pangu` is multi-turn: the harness gains a conversation the caller keeps (the message
list carries over between prompts in one session). One run record per session.
Ctrl-C during a turn cancels that turn (the existing cancel flag), a second Ctrl-C or
`exit` quits.

### Providers and model (own loop)

`pangu` reads providers from the app database and the key from the keychain. Choice
order: `--provider <name|id>` and `--model <id>` flags; else the last pair used, saved
in `app_data` key `pangu`; else, if exactly one provider exists, that one, asking for
the model on first run; else a clear message pointing to Settings → Providers. No
provider and no flags but `claude` installed → print a hint to use `pangu claude`.

### `pangu check` and `pangu record` (hook side)

- `pangu check --agent <claude|agy|hermes>` reads the agent's hook JSON on stdin, maps
  it to an `Action` with that agent's tool-name table, loads context (folder from the
  hook's cwd / workspace path, settings, always-allowed list, step count for the
  session from the record), calls `decide`, prints the agent's decision format.
  - Any error (bad JSON, DB unreadable, panic) inside a `pangu` session → the agent's
    **deny** with the reason.
  - Output is only ever a deny or nothing (see the decision table).
  - Only enforces when the env var `PANGU_SESSION` is set (it is set by `pangu <agent>`
    and carries the session id and the folder). Without it, it exits 0 with no output,
    so the agy plugin and Hermes profile are inert when the user runs them directly.
  - The hook command in plugins and profiles is wrapped so a missing `pangu` binary or
    an unset `PANGU_SESSION` exits 0 silently:
    `sh -c '[ -n "$PANGU_SESSION" ] && command -v pangu >/dev/null || exit 0; exec pangu check --agent agy'`.
    Inside a session the binary is guaranteed (pangu launched the agent).
- `pangu record --agent <…>` (post-tool hook) appends the call and a short result to
  the session's record and increments the step count.
- `pangu allow "<command>"` adds a command to the current folder's always-allowed list
  (used by the own loop; external agents keep their own approval lists).

Tool-name tables (to verify by logging real hook payloads before finalizing):

| Agent | Read | Write | Run |
|---|---|---|---|
| Claude Code | `Read`, `Glob`, `Grep` | `Edit`, `Write`, `MultiEdit`, `NotebookEdit` | `Bash` |
| Antigravity | to capture | to capture | to capture |
| Hermes | `read_file`, … (to capture) | `write_file`, `patch`, … | `terminal` |

Anything not in a table → `Other` → silent for external agents.

### Adapters

- **`pangu claude [args…]`**: build a plugin folder in the app data dir with the
  skills (`skills/<name>/SKILL.md` per Claude's plugin format), and a settings JSON
  with PreToolUse and PostToolUse hooks (matcher `.*`) that run the absolute path of
  `pangu check --agent claude` / `pangu record --agent claude`; set `PANGU_SESSION`;
  exec `claude --settings <json> --plugin-dir <dir> [args…]`.
- **`pangu agy [args…]`**: on first use, ask the user, then `agy plugin install` a
  `panguyuban` plugin (skills + hooks calling `pangu check/record --agent agy`, timeout
  10 s). Set `PANGU_SESSION`; exec `agy [args…]`. `pangu agy --uninstall` removes it.
- **`pangu hermes [args…]`**: on first use, create the `panguyuban` profile (hooks with
  `fail_closed: true`, matcher for every tool, skills). Hermes keeps its own model and
  provider setup; `pangu` never passes keys to it (no `--api-key` on the command line,
  no keys copied into the profile). How the profile reaches the user's model config is
  settled in phase 3 after inspecting Hermes's profile layout. Set `PANGU_SESSION`;
  exec `hermes -p panguyuban --accept-hooks [args…]`.

### Run record

`<data_local_dir>/panguyuban/runs/<folder-slug>/<session>.jsonl` for every agent: the
session start (agent, folder, model when known), each decision (action, decision,
reason), each completed call (from post hooks or the own loop), and the end. The app
can show these later; this design only writes them.

### Always-allowed commands

Stored per folder in `app_data` key `pangu-allowed` (`{ "<abs folder>": ["npm test", …] }`).
Exact string match only. Shown and removable in Settings later (not in this design).

## Phases (my call)

1. **Core + `pangu`**: policy core, `.git` rule in `Workspace`, `run_command` +
   `Approver`, conversation, providers from the app, session type + skill, record,
   `pangu check/record/allow` with the Claude table, **`pangu claude`**.
2. **`pangu agy`**: capture tool names, plugin install/uninstall.
3. **`pangu hermes`**: capture tool names, profile setup.

Each phase is usable on its own; Claude Code first because it is the agent the user
has today.

## Decisions (my calls, open to correction)

- **The folder** is the git root above the launch directory, or the launch directory
  when it is not in a repo. It is fixed for the session and carried in `PANGU_SESSION`;
  per-call hook `cwd` values do not move it.
- **Installing `pangu`**: the binary ships inside Panguyuban.app
  (`Contents/MacOS/pangu`), built from the same workspace so the compiled-in registry
  always matches the app; the app offers to link it onto PATH
  (`/opt/homebrew/bin` or `/usr/local/bin`). The keychain prompt appears once per
  install/update.
- **Step limit**: own loop counts per prompt (as the harness does today); external
  agents count completed tool calls per session from the record (refused and `Other`
  calls don't count); at the limit every write and command is denied with "step limit
  reached; start a new pangu session".
- **Own loop reads stay strict** (inside the folder only).
- **Code location**: `pangu` needs the SQLite store (`crates/panguyuban-core`), the
  keychain reader and the OpenAI-compatible `ChatModel` (today in the Tauri app crate).
  The keychain reader and `ChatModel` move to a small shared crate (or
  `panguyuban-core`) used by both the app and `pangu`.
- The `.git` write ban moves into `Workspace` (fixed, not a hook), closing the final
  review's `"*"` note for every caller.
- Time limits are not enforced for external agents; step limits are, by counting
  calls in the record.
- The spike's `crates/pangu-cli` is the starting point for the real crate, rewritten
  to the rules above; the spike branch is not merged as is.

## Left to the builder

- Exact Claude/agy/Hermes payload field names (log real payloads first).
- `pangu` prompt rendering, colours, Ctrl-C handling details.
- How the generated plugin/profile folders are refreshed when skills change.
- Tests: `policy::decide` rule table, each adapter's JSON mapping with captured
  payloads, fail-closed on bad input, `PANGU_SESSION` absent → inert, absolute→relative
  path conversion, `.git` refusal in `Workspace`.
