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

// Outside the desktop app (plain browser) there is no backend: start empty.
let fallbackState: DashboardPayload = {
  tickets: [],
  pull_requests: [],
  config: {
    issue_provider: "plane.so",
    plane_base_url: "https://api.plane.so",
    plane_workspace_slug: "",
    plane_project_id: "",
    git_provider: "github",
    github_api_url: "https://api.github.com",
    github_repo: "",
    local_repo_path: ".",
  },
};

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
  githubToken?: string,
  calendarUrl?: string
): Promise<WorkspaceConfig> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<WorkspaceConfig>(
      "save_workspace_config",
      { config, planeToken, githubToken, calendarUrl }
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

export async function agentSessions(): Promise<AgentSession[]> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<AgentSession[]>("agent_sessions");
  }
  return [];
}

export async function agentUsage(): Promise<UsageReport[]> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<UsageReport[]>("agent_usage");
  }
  return [];
}

export async function revealAgent(pid: number, cwd: string): Promise<void> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<void>("reveal_agent", { pid, cwd });
  }
}

/** Ends the session's process. The backend only accepts pids of live tracked sessions. */
export async function killAgent(pid: number): Promise<void> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<void>("kill_agent", { pid });
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

/** Every model an agent tool offers. Empty outside the desktop app. */
export async function builderModels(harness: string): Promise<{ id: string; label: string }[]> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<{ id: string; label: string }[]>("builder_models", { harness });
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

export interface HttpRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body: string;
}

export interface HttpResponse {
  status: number;
  status_text: string;
  headers: [string, string][];
  /** First 2 MB only; `truncated` says whether more was dropped. */
  body: string;
  size: number;
  truncated: boolean;
  elapsed_ms: number;
}

/** Sends a request from Rust (no CORS); rejects on network or URL errors. */
export function sendHttp(request: HttpRequest): Promise<HttpResponse> {
  return window.__TAURI_INTERNALS__!.invoke<HttpResponse>("send_http", { request });
}

export interface CalendarEvent {
  id: string;
  title: string;
  start_ms: number;
  end_ms: number;
  all_day: boolean;
  calendar: string;
  location: string | null;
  join_url: string | null;
}

/** Meetings overlapping [fromMs, toMs) from the Mac's Calendar app and any ICS link
 * or imported .ics file, sorted by start. */
export async function calendarEvents(fromMs: number, toMs: number): Promise<CalendarEvent[]> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<CalendarEvent[]>("calendar_events", { fromMs, toMs });
  }
  return [];
}

/** Keeps a copy of an .ics file's text as the imported calendar; returns how many events it has. */
export async function importCalendar(ics: string): Promise<number> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<number>("import_calendar", { ics });
  }
  return (ics.match(/^BEGIN:VEVENT/gm) ?? []).length;
}

export async function openMeeting(url: string): Promise<void> {
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke<void>("open_meeting", { url });
  }
  window.open(url, "_blank", "noreferrer");
}
