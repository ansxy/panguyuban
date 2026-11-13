export type TicketState =
  | "Backlog"
  | "Todo"
  | "InProgress"
  | "InReview"
  | "Done"
  | "Cancelled";

export interface Ticket {
  id: string;
  key: string;
  title: string;
  description: string;
  state: TicketState;
  assignee: string | null;
  priority: string | null;
  updated_at: string;
  url: string;
  assigned_to_me: boolean;
}

export type ReviewState = "ReviewRequired" | "Approved" | "ChangesRequested";

export type CiState =
  | "Pending"
  | { Passing: { passed: number; total: number } }
  | { Failing: { failed: number; total: number } };

export interface PullRequest {
  repo: string;
  number: number;
  title: string;
  author: string;
  source_branch: string;
  target_branch: string;
  mergeable: boolean;
  additions: number;
  deletions: number;
  review_state: ReviewState;
  ci_state: CiState;
  linked_ticket_key: string | null;
  diff_preview: string[];
  url: string;
  review_requested: boolean;
}

export interface WorkspaceConfig {
  issue_provider: string;
  plane_base_url: string;
  plane_workspace_slug: string;
  plane_project_id: string;
  git_provider: string;
  github_api_url: string;
  github_repo: string;
  local_repo_path: string;
}

export interface DashboardPayload {
  tickets: Ticket[];
  pull_requests: PullRequest[];
  config: WorkspaceConfig;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
    };
  }
}

const INITIAL_DEMO_STATE: DashboardPayload = {
  tickets: [
    {
      id: "b62f8d9a-0142",
      key: "PAN-142",
      title: "Fix JWT refresh race on concurrent requests",
      description:
        "When two requests expire within the same millisecond, parallel refresh calls invalidate the first rotated token. Guard rotation with an async mutex inside the session store.",
      state: "InReview",
      assignee: "@ansar",
      priority: "high",
      updated_at: "2026-11-11T02:14:09Z",
      url: "https://app.plane.so/panguyuban/issues/PAN-142",
      assigned_to_me: true,
    },
    {
      id: "b62f8d9a-0145",
      key: "PAN-145",
      title: "Add exponential backoff to webhook delivery",
      description:
        "Failed webhook deliveries currently retry immediately and trip downstream rate limits. Schedule retries with jitter over 5 attempts.",
      state: "InProgress",
      assignee: "@alex",
      priority: "medium",
      updated_at: "2026-11-11T02:20:00Z",
      url: "https://app.plane.so/panguyuban/issues/PAN-145",
      assigned_to_me: false,
    },
    {
      id: "b62f8d9a-0149",
      key: "PAN-149",
      title: "Expose rate-limit headers on public endpoints",
      description:
        "Return X-RateLimit-Limit, X-RateLimit-Remaining, and X-RateLimit-Reset on all authenticated API routes.",
      state: "Todo",
      assignee: "@ansar",
      priority: "low",
      updated_at: "2026-11-11T02:30:00Z",
      url: "https://app.plane.so/panguyuban/issues/PAN-149",
      assigned_to_me: true,
    },
  ],
  pull_requests: [
    {
      repo: "ansar/panguyuban",
      review_requested: false,
      number: 89,
      title: "fix(auth): serialize token refresh with mutex",
      author: "@ansar",
      source_branch: "fix/pan-142-jwt",
      target_branch: "main",
      mergeable: true,
      additions: 84,
      deletions: 19,
      review_state: "Approved",
      ci_state: { Passing: { passed: 3, total: 3 } },
      linked_ticket_key: "PAN-142",
      diff_preview: [
        "@@ -42,7 +42,9 @@ impl TokenManager {",
        "-    let next = self.client.refresh(&current).await?;",
        "+    let _guard = self.refresh_lock.lock().await;",
        "+    let next = self.client.refresh(&current).await?;",
      ],
      url: "https://github.com/ansar/panguyuban/pull/89",
    },
    {
      repo: "ansar/panguyuban",
      review_requested: true,
      number: 92,
      title: "feat(webhook): bounded retry queue with jitter",
      author: "@alex",
      source_branch: "feat/pan-145-webhook",
      target_branch: "main",
      mergeable: true,
      additions: 142,
      deletions: 11,
      review_state: "ReviewRequired",
      ci_state: { Passing: { passed: 2, total: 3 } },
      linked_ticket_key: "PAN-145",
      diff_preview: [
        "@@ -18,4 +18,8 @@ pub fn next_backoff(attempt: u32) -> Duration {",
        "+    let base = 2_u64.saturating_pow(attempt);",
        "+    Duration::from_secs(base.min(300))",
      ],
      url: "https://github.com/ansar/panguyuban/pull/92",
    },
    {
      repo: "ansar/infra",
      review_requested: true,
      number: 94,
      title: "chore(cargo): bump tokio and reqwest crates",
      author: "@sarah",
      source_branch: "chore/tokio-bump",
      target_branch: "main",
      mergeable: true,
      additions: 18,
      deletions: 18,
      review_state: "ReviewRequired",
      ci_state: { Passing: { passed: 3, total: 3 } },
      linked_ticket_key: null,
      diff_preview: [
        "@@ -12,2 +12,2 @@ [dependencies]",
        '-tokio = "1.39"',
        '+tokio = "1.54"',
      ],
      url: "https://github.com/ansar/panguyuban/pull/94",
    },
  ],
  config: {
    issue_provider: "plane.so",
    plane_base_url: "https://api.plane.so",
    plane_workspace_slug: "panguyuban",
    plane_project_id: "panguyuban-core",
    git_provider: "github",
    github_api_url: "https://api.github.com",
    github_repo: "",
    local_repo_path: ".",
  },
};

let fallbackState: DashboardPayload = structuredClone(INITIAL_DEMO_STATE);

export async function getDashboardState(): Promise<DashboardPayload> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<DashboardPayload>(
      "get_dashboard_state"
    );
  }
  return structuredClone(fallbackState);
}

export async function syncProviders(): Promise<DashboardPayload> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<DashboardPayload>("sync_providers");
  }
  return structuredClone(fallbackState);
}

/** Refreshes one provider only: "sync_plane" or "sync_github". */
export async function syncOne(
  command: "sync_plane" | "sync_github"
): Promise<DashboardPayload> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<DashboardPayload>(command);
  }
  return structuredClone(fallbackState);
}

export async function getPrDiff(repo: string, prNumber: number): Promise<string[]> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<string[]>("get_pr_diff", {
      repo,
      prNumber,
    });
  }
  return [];
}

export async function startTicketBranch(ticketKey: string): Promise<string> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<string>("start_ticket_branch", {
      ticketKey,
    });
  }
  const ticket = fallbackState.tickets.find((t) => t.key === ticketKey);
  if (ticket) {
    ticket.state = "InProgress";
  }
  return `feat/${ticketKey.toLowerCase()}`;
}

export async function transitionTicketState(
  ticketKey: string,
  nextState: TicketState
): Promise<Ticket> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<Ticket>(
      "transition_ticket_state",
      { ticketKey, nextState }
    );
  }
  const ticket = fallbackState.tickets.find((t) => t.key === ticketKey);
  if (!ticket) {
    throw new Error(`Ticket ${ticketKey} not found`);
  }
  ticket.state = nextState;
  return structuredClone(ticket);
}

export async function approvePr(
  repo: string,
  prNumber: number
): Promise<PullRequest> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<PullRequest>("approve_pr", {
      repo,
      prNumber,
    });
  }
  const pr = fallbackState.pull_requests.find(
    (p) => p.repo === repo && p.number === prNumber
  );
  if (!pr) {
    throw new Error(`PR #${prNumber} not found`);
  }
  pr.review_state = "Approved";
  return structuredClone(pr);
}

export async function mergePrAndCloseTicket(
  repo: string,
  prNumber: number,
  ticketKey: string | null
): Promise<DashboardPayload> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<DashboardPayload>(
      "merge_pr_and_close_ticket",
      { repo, prNumber, ticketKey }
    );
  }
  fallbackState.pull_requests = fallbackState.pull_requests.filter(
    (pr) => !(pr.repo === repo && pr.number === prNumber)
  );
  if (ticketKey) {
    const ticket = fallbackState.tickets.find((t) => t.key === ticketKey);
    if (ticket) {
      ticket.state = "Done";
    }
  }
  return structuredClone(fallbackState);
}

export async function saveWorkspaceConfig(
  config: WorkspaceConfig,
  planeToken?: string,
  githubToken?: string
): Promise<WorkspaceConfig> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<WorkspaceConfig>(
      "save_workspace_config",
      { config, planeToken, githubToken }
    );
  }
  fallbackState.config = structuredClone(config);
  return structuredClone(fallbackState.config);
}

export interface PlaneProject {
  id: string;
  identifier: string | null;
  name: string | null;
}

export async function listPlaneProjects(
  baseUrl: string,
  workspaceSlug: string,
  planeToken?: string
): Promise<PlaneProject[]> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<PlaneProject[]>(
      "list_plane_projects",
      { baseUrl, workspaceSlug, planeToken }
    );
  }
  return [];
}

/** Download URL for an image in a Plane ticket description (asset id or URL). */
export async function getPlaneAssetUrl(assetId: string): Promise<string> {
  if (/^https?:\/\//.test(assetId)) return assetId;
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<string>("get_plane_asset_url", {
      assetId,
    });
  }
  throw new Error("Images need the desktop app");
}

// ---------- Agents (local Claude Code / Antigravity sessions) ----------

export type AgentStatus = "busy" | "waiting" | "idle";

export interface SubAgent {
  id: string;
  description: string;
  agent_type: string;
  started_ms: number;
  last_active_ms: number;
  finished: boolean;
  input_tokens: number;
  output_tokens: number;
}

export interface AgentSession {
  harness: "claude" | "antigravity";
  session_id: string;
  pid: number;
  cwd: string;
  name: string;
  status: AgentStatus;
  started_ms: number;
  status_since_ms: number;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  subagents: SubAgent[];
}

export interface TokenWindow {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
  effective: number;
  oldest_ms: number | null;
}

export interface UsageReport {
  harness: "claude" | "antigravity";
  five_hour: TokenWindow;
  today: TokenWindow;
  week: TokenWindow;
}

const minutesAgo = (m: number) => Date.now() - m * 60_000;

/** Browser-preview data only; the desktop app reads real sessions. */
const DEMO_AGENTS: AgentSession[] = [
  {
    harness: "claude", session_id: "demo-1", pid: 1, cwd: "~/project/panguyuban", name: "panguyuban",
    status: "waiting", started_ms: minutesAgo(48), status_since_ms: minutesAgo(3), model: "claude-opus-5-5",
    input_tokens: 3_748_641, output_tokens: 154_319,
    subagents: [
      { id: "a1", description: "Map top-bar agent tracker", agent_type: "Explore", started_ms: minutesAgo(9), last_active_ms: minutesAgo(6), finished: true, input_tokens: 195_134, output_tokens: 4_134 },
      { id: "a2", description: "Research dashboard design", agent_type: "general-purpose", started_ms: minutesAgo(4), last_active_ms: minutesAgo(0), finished: false, input_tokens: 74_628, output_tokens: 125 },
    ],
  },
  {
    harness: "claude", session_id: "demo-2", pid: 2, cwd: "~/project/rey-ehr-be", name: "rey-ehr-be",
    status: "busy", started_ms: minutesAgo(130), status_since_ms: minutesAgo(1), model: "claude-sonnet-5-5",
    input_tokens: 1_081_077, output_tokens: 41_245, subagents: [],
  },
  {
    harness: "antigravity", session_id: "demo-3", pid: 3, cwd: "~/project/cova-front", name: "cova-front",
    status: "idle", started_ms: minutesAgo(300), status_since_ms: minutesAgo(22), model: null,
    input_tokens: 602_849, output_tokens: 18_210, subagents: [],
  },
];

const demoWindow = (effective: number): TokenWindow => ({
  input: effective * 0.2, output: effective * 0.05, cache_write: effective * 0.15, cache_read: effective * 6,
  effective, oldest_ms: minutesAgo(190),
});

export async function agentSessions(): Promise<AgentSession[]> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<AgentSession[]>("agent_sessions");
  }
  return structuredClone(DEMO_AGENTS);
}

export async function agentUsage(): Promise<UsageReport[]> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<UsageReport[]>("agent_usage");
  }
  return [
    { harness: "claude", five_hour: demoWindow(5_436_594), today: demoWindow(7_277_385), week: demoWindow(23_317_357) },
    { harness: "antigravity", five_hour: demoWindow(602_849), today: demoWindow(4_684_917), week: demoWindow(8_280_576) },
  ];
}

export async function revealAgent(pid: number, cwd: string): Promise<void> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<void>("reveal_agent", { pid, cwd });
  }
}

export async function openAgentFolder(cwd: string): Promise<void> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<void>("open_agent_folder", { cwd });
  }
}

// ---------- Guided builder (real agent for the PRD interview) ----------

export interface HarnessStatus {
  harness: "claude" | "antigravity";
  available: boolean;
}

export interface InterviewTurnArgs {
  projectId: string;
  projectName: string;
  client: string;
  author: string;
  harness: string;
  model: string | null;
  transcript: { from: "agent" | "user"; text: string }[];
}

export interface InterviewTurnResult {
  message: string;
  prd: string | null;
  prd_path: string | null;
}

/** Which agent command-line tools are installed. Empty outside the desktop app. */
export async function builderAgents(): Promise<HarnessStatus[]> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<HarnessStatus[]>("builder_agents");
  }
  return [];
}

export async function builderInterviewTurn(args: InterviewTurnArgs): Promise<InterviewTurnResult> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<InterviewTurnResult>("builder_interview_turn", { args });
  }
  throw new Error("A real agent needs the desktop app");
}

/** Overwrites prd.md for a prototype (used when the user approves it). */
export async function builderSavePrd(args: {
  projectId: string;
  projectName: string;
  content: string;
  /** Which document in the prototype's folder to write. Defaults to prd.md. */
  file?: "prd.md" | "handover.md";
}): Promise<string> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<string>("builder_save_prd", { args });
  }
  throw new Error("Saving needs the desktop app");
}

export interface StepPlan {
  id: string;
  size: "small" | "hard";
  needs_engineer: boolean;
  reason: string;
}

export interface BuildPlan {
  summary: string;
  steps: StepPlan[];
}

/** Has the agent size each step of the approved PRD and flag the ones an engineer must clear. */
export async function builderPlan(args: {
  projectId: string;
  projectName: string;
  harness: string;
  model: string | null;
  prd: string;
}): Promise<BuildPlan> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<BuildPlan>("builder_plan", { args });
  }
  throw new Error("A real agent needs the desktop app");
}

export interface DesignResult {
  message: string;
  html: string;
  path: string | null;
}

/** Has the agent propose the HTML mock-up for an approved PRD, or revise the current one. */
export async function builderDesign(args: {
  projectId: string;
  projectName: string;
  harness: string;
  model: string | null;
  prd: string;
  current: string | null;
  changes: string[];
}): Promise<DesignResult> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<DesignResult>("builder_design", { args });
  }
  throw new Error("A real agent needs the desktop app");
}

/** Starts the user's login shell on a PTY and returns its id. */
export async function termOpen(cols: number, rows: number, cwd: string): Promise<number> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<number>("term_open", { cols, rows, cwd });
  }
  throw new Error("The terminal needs the desktop app");
}

// The rest only run after termOpen succeeded, so Tauri is there.

/** Waits for the next shell output; an empty buffer means the shell exited. */
export function termRead(id: number): Promise<ArrayBuffer> {
  return window.__TAURI_INTERNALS__!.invoke<ArrayBuffer>("term_read", { id });
}

export function termWrite(id: number, data: string): Promise<void> {
  return window.__TAURI_INTERNALS__!.invoke<void>("term_write", { id, data });
}

export function termResize(id: number, cols: number, rows: number): Promise<void> {
  return window.__TAURI_INTERNALS__!.invoke<void>("term_resize", { id, cols, rows });
}

export function termClose(id: number): Promise<void> {
  return window.__TAURI_INTERNALS__!.invoke<void>("term_close", { id });
}

export interface TermInfo {
  command: string;
  cwd: string;
}

/** The pane's foreground program and folder, for its header. */
export function termInfo(id: number): Promise<TermInfo> {
  return window.__TAURI_INTERNALS__!.invoke<TermInfo>("term_info", { id });
}

export interface SpaceStatus {
  path: string;
  branch: string | null;
  ahead: number;
  behind: number;
  github_repo: string | null;
}

/** Git state of each folder (`~` allowed). Empty outside the desktop app. */
export async function spaceStatus(paths: string[]): Promise<SpaceStatus[]> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<SpaceStatus[]>("space_status", { paths });
  }
  return [];
}

export interface DirEntry {
  name: string;
  is_dir: boolean;
}

// Folder panel calls only run in the desktop app (the panel sits beside a terminal).

/** One folder level, folders first (`~` allowed). */
export function folderList(path: string): Promise<DirEntry[]> {
  return window.__TAURI_INTERNALS__!.invoke<DirEntry[]>("folder_list", { path });
}

/** A text file's contents; rejects for binary or very large files. */
export function folderReadFile(path: string): Promise<string> {
  return window.__TAURI_INTERNALS__!.invoke<string>("folder_read_file", { path });
}

/** Uncommitted changes (edits since HEAD plus new files) as unified diff lines. */
export function folderChanges(path: string): Promise<string[]> {
  return window.__TAURI_INTERNALS__!.invoke<string[]>("folder_changes", { path });
}
