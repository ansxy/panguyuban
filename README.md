# Panguyuban

A desktop workspace for the day-to-day of shipping software: your meetings,
Plane tickets, GitHub pull requests, coding agents and terminals in one window.

Built with Tauri 2 (Rust) and React.

## What's inside

| Section | What it does |
|---|---|
| **Overview** | Home page. The meeting on now (or next) with a Join button, a month calendar with the selected day's agenda, counts of what needs you, and short lists of your tickets in progress, PRs to review, PRs ready to merge and agents waiting on you. Each ticket has a project picker and **Open in terminal**. |
| **Spaces** | Embedded terminals (your login shell) in tabs with split panes, grouped by folder, with the folder's branch and ahead/behind. Files and Changes panel beside them. |
| **Tickets** | Your Plane.so tickets, with description, linked PR and **Checkout branch**. |
| **Pull requests** | GitHub PRs to review, yours, and ready to merge, with CI state, diff, approve and merge (which also closes the linked ticket). |
| **Agents** | Live Claude Code and Antigravity sessions on this Mac: who is working, who needs you, token usage. |
| **Prototypes** | Guided builder: an agent interviews you, writes a PRD, builds an HTML prototype, then hands it to engineering or builds it. |

Meetings come from the macOS **Calendar** app, so any account it syncs (Google
Workspace, Exchange, iCloud) shows up. Recurring meetings included.

## Platform support

Panguyuban is developed and tested on **macOS**. It is written to build on Linux and
Windows too, but those are not tested yet, and a few parts are macOS-only today:

| | macOS | Linux | Windows |
|---|---|---|---|
| Tested | yes | not yet | not yet |
| Meetings and calendar | macOS 14 or newer | no (reads the macOS Calendar app) | no |
| Tokens kept between launches | Keychain | not yet (no Linux keyring enabled) | Credential Manager |
| Terminals | yes | yes | not yet (expects a Unix shell) |
| Installable app bundle | `Panguyuban.app` | run from source | run from source (needs an `.ico` icon first) |

## Requirements

- Rust (stable) via [rustup](https://rustup.rs)
- Node.js 18 or newer, with npm
- The [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your system:
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`)
  - **Linux:** WebKitGTK and build tools. On Debian / Ubuntu:
    `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`
  - **Windows:** Microsoft C++ Build Tools and WebView2 (already on Windows 10 and 11)
- Optional, for each feature:
  - **GitHub:** the [`gh` CLI](https://cli.github.com), signed in with `gh auth login`, or a personal access token in Settings
  - **Plane:** a Plane API token (Plane → Profile settings → Personal access tokens)
  - **Meetings (macOS):** your work calendar added to the Calendar app (System Settings → Internet Accounts)
  - **Agents / Prototypes:** [Claude Code](https://claude.com/claude-code) (`claude`) or Antigravity (`agy`) on your `PATH`

## Install

```sh
git clone https://github.com/ansxy/panguyuban.git
cd panguyuban/apps/panguyuban-desktop
npm install
```

**macOS:** build the app and copy it into Applications.

```sh
npm run desktop:build
cp -R ../../target/release/bundle/macos/Panguyuban.app /Applications/
open /Applications/Panguyuban.app
```

**Linux and Windows:** run it from source (see [Platform support](#platform-support)).

```sh
npm run desktop
```

The first build compiles all the Rust dependencies and takes a few minutes.

### First run

1. **Settings:** enter your Plane URL, workspace slug, project and API token, and
   optionally a GitHub repo (`owner/repo`; leave it empty to see all your PRs) and your
   local repo path. Tokens go into the system keychain, never into files.
2. **GitHub:** if `gh auth login` is done, nothing else is needed.
3. **Calendar (macOS):** the first time the Overview opens, macOS asks for Calendar access.
   Allow it. If you said no, turn it back on in System Settings → Privacy & Security → Calendars.

### Where things are stored

- Settings and synced tickets / PRs: `state.db` in the `panguyuban` folder of your local
  app data (macOS `~/Library/Application Support`, Linux `~/.local/share`,
  Windows `%LOCALAPPDATA%`)
- Tokens: the system keychain, service `com.ansar.panguyuban`
- Prototypes and their PRDs: `Panguyuban` in your Documents folder
- Window layout and per-ticket project picks: the app's local storage

## Install with an agent

Paste this into Claude Code (or another coding agent) from any folder. It installs
Panguyuban and stops to ask you for anything secret.

```text
Install the Panguyuban desktop app on this computer.

1. Find out the operating system and version. Panguyuban is tested on macOS;
   on Linux or Windows, tell me it is untested there and what is missing
   (see "Platform support" in the README), then continue.
2. Check the requirements and install what is missing:
   - Rust stable (`rustc --version`, else install with rustup).
   - Node.js 18+ and npm (`node --version`).
   - The Tauri prerequisites for this system
     (https://v2.tauri.app/start/prerequisites/). On macOS that is the Xcode
     Command Line Tools (`xcode-select -p`, else `xcode-select --install` and
     wait for me to finish the installer).
   Ask me before installing anything with sudo or an installer window.
3. Clone https://github.com/ansxy/panguyuban.git into ~/project/panguyuban,
   or use it if it is already there.
4. In apps/panguyuban-desktop run `npm install`.
5. macOS: run `npm run desktop:build`, copy
   target/release/bundle/macos/Panguyuban.app (at the repository root) to
   /Applications and open it.
   Linux or Windows: run `npm run desktop` to start it from source.
   If a build fails, show me the error and fix it before going on.
6. Check the optional tools and tell me which features each enables, without
   installing them unless I say so: `gh auth status` (GitHub), `claude` and
   `agy` on the PATH (Agents and Prototypes).
7. Finish with a short summary: what you installed, how to start the app, and
   what I still have to do myself (Plane token in Settings, `gh auth login`,
   allowing Calendar access on macOS).

Never type, paste or store a token or password for me; I enter those in the
app's Settings. Do not change system settings.
```

## Development

```sh
cd apps/panguyuban-desktop
npm run dev            # browser preview at http://localhost:1420, with demo data
npm run desktop        # the real app, with hot reload
npm run build          # type check + frontend build
cargo test             # Rust tests (from the repository root)
```

Outside the desktop app (the browser preview) every backend call falls back to demo
data, so the UI can be worked on without Plane, GitHub or a calendar.

## Repository layout

```
apps/panguyuban-desktop/
  src/                 React UI (one file per section: Overview, Agents, Builder, Spaces, ...)
  src-tauri/           Tauri shell and commands (calendar, terminals, agents, builder, ...)
crates/
  panguyuban-core/     models, provider traits, SQLite store, workflows
  provider-plane/      Plane.so adapter
  provider-github/     GitHub adapter
  agent-runtime/       runs Claude Code / Antigravity one turn at a time
skills/                skill library the guided builder's agents follow
docs/                  design specs and plans
```

## License

MIT
