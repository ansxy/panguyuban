# Panguyuban

A macOS desktop workspace for the day-to-day of shipping software: your meetings,
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

## Requirements

- macOS 14 (Sonoma) or newer. The calendar needs it; the rest runs on older versions.
- Xcode Command Line Tools: `xcode-select --install`
- Rust (stable) via [rustup](https://rustup.rs)
- Node.js 18 or newer, with npm
- Optional, for each feature:
  - **GitHub:** the [`gh` CLI](https://cli.github.com), signed in with `gh auth login`, or a personal access token in Settings
  - **Plane:** a Plane API token (Plane → Profile settings → Personal access tokens)
  - **Meetings:** your work calendar added to the Calendar app (System Settings → Internet Accounts)
  - **Agents / Prototypes:** [Claude Code](https://claude.com/claude-code) (`claude`) or Antigravity (`agy`) on your `PATH`

## Install

```sh
git clone <this repo> panguyuban
cd panguyuban/apps/panguyuban-desktop
npm install
npm run desktop:build
```

The app is built to `target/release/bundle/macos/Panguyuban.app` at the repository root.
Copy it into Applications:

```sh
cp -R ../../target/release/bundle/macos/Panguyuban.app /Applications/
open /Applications/Panguyuban.app
```

The first build compiles all the Rust dependencies and takes a few minutes.

To run from source without installing, use `npm run desktop` (hot reload).

### First run

1. **Settings:** enter your Plane URL, workspace slug, project and API token, and
   optionally a GitHub repo (`owner/repo`; leave it empty to see all your PRs) and your
   local repo path. Tokens go into the macOS Keychain, never into files.
2. **GitHub:** if `gh auth login` is done, nothing else is needed.
3. **Calendar:** the first time the Overview opens, macOS asks for Calendar access. Allow it.
   If you said no, turn it back on in System Settings → Privacy & Security → Calendars.

### Where things are stored

- Settings and synced tickets / PRs: `~/Library/Application Support/panguyuban/state.db`
- Tokens: macOS Keychain, service `com.ansar.panguyuban`
- Prototypes and their PRDs: `~/Documents/Panguyuban/`
- Window layout and per-ticket project picks: the app's local storage

## Install with an agent

Paste this into Claude Code (or another coding agent) from any folder. It installs
Panguyuban and stops to ask you for anything secret.

```text
Install the Panguyuban desktop app on this Mac.

1. Check the requirements and install what is missing:
   - macOS 14 or newer (`sw_vers -productVersion`). If older, tell me the calendar
     will not work and continue.
   - Xcode Command Line Tools (`xcode-select -p`, else `xcode-select --install`
     and wait for me to finish the installer).
   - Rust stable (`rustc --version`, else install with rustup).
   - Node.js 18+ and npm (`node --version`, else install with Homebrew).
2. Clone the repository (ask me for the URL if you do not have it) into
   ~/project/panguyuban, or use it if it is already there.
3. In apps/panguyuban-desktop run `npm install`, then `npm run desktop:build`.
   If the build fails, show me the error and fix it before going on.
4. Copy target/release/bundle/macos/Panguyuban.app (at the repository root)
   to /Applications and open it.
5. Check the optional tools and tell me which features each enables, without
   installing them unless I say so: `gh auth status` (GitHub), `which claude`
   and `which agy` (Agents and Prototypes).
6. Finish with a short summary: what you installed, the app's path, and what I
   still have to do myself (Plane token in Settings, `gh auth login`, allowing
   Calendar access when macOS asks).

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
