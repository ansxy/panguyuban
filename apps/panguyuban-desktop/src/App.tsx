import React, { useEffect, useState } from "react";
import {
  approvePr,
  DashboardPayload,
  getDashboardState,
  getPlaneAssetUrl,
  getPrDiff,
  importCalendar,
  listPlaneProjects,
  mergePrAndCloseTicket,
  PlaneProject,
  PullRequest,
  saveWorkspaceConfig,
  spaceStatus,
  startTicketBranch,
  syncOne,
  syncProviders,
  Ticket,
  WorkspaceConfig,
} from "./api";
import { DiffFiles, FilterTabs, Icon, type IconName } from "./ui";
import { AgentsView, shortPath, SidebarAgents, useAgents } from "./Agents";
import { BuilderView, useBuilder } from "./Builder";
import { ProvidersSection } from "./ProvidersSettings";
import { FEATURES, type FeatureKey, useFeatures } from "./features";
import { SidebarSpaces, TerminalStages, useSpaces } from "./Spaces";
import { FolderPanel, PanelMode } from "./FolderPanel";
import { RequestsView, useRequests } from "./Requests";
import { type HandoffPrefill, MemoryView } from "./Memory";
import { OverviewView, withSiblingFolders } from "./Overview";
import { THEMES, applyTheme, savedTheme } from "./theme";

type SectionKey = "overview" | "tickets" | "git" | "agents" | "builder" | "requests" | "memory" | "terminal" | "settings";
type DataState = "full" | "loading" | "empty" | "error";

function formatCiState(pr: PullRequest): string {
  if (pr.ci_state === "Pending") return "Pending";
  if ("Passing" in pr.ci_state) {
    return `${pr.ci_state.Passing.passed} / ${pr.ci_state.Passing.total} pass`;
  }
  return `${pr.ci_state.Failing.failed} / ${pr.ci_state.Failing.total} fail`;
}

/** Ticket list order, and the five steps of the progress track (Cancelled sits outside it). */
const TICKET_GROUPS = [
  { state: "InProgress", label: "In progress" },
  { state: "InReview", label: "In review" },
  { state: "Todo", label: "Todo" },
  { state: "Backlog", label: "Backlog" },
  { state: "Done", label: "Done" },
  { state: "Cancelled", label: "Cancelled" },
];
const TICKET_STEPS = [
  { state: "Backlog", label: "Backlog" },
  { state: "Todo", label: "Todo" },
  { state: "InProgress", label: "In progress" },
  { state: "InReview", label: "In review" },
  { state: "Done", label: "Done" },
];

/** Pull request list order. */
const PR_GROUPS = [
  { state: "ChangesRequested", label: "Changes requested" },
  { state: "ReviewRequired", label: "Review required" },
  { state: "Approved", label: "Approved" },
];

type GateOutcome = "ok" | "bad" | "pending";

/** The review and checks gates of a pull request, as outcome plus the words shown. */
function prGates(pr: PullRequest): {
  review: { outcome: GateOutcome; value: string };
  checks: { outcome: GateOutcome; value: string };
} {
  const review =
    pr.review_state === "Approved"
      ? { outcome: "ok" as const, value: "Approved" }
      : pr.review_state === "ChangesRequested"
        ? { outcome: "bad" as const, value: "Changes requested" }
        : {
            outcome: "pending" as const,
            value: pr.review_requested ? "Waiting for you" : "Waiting for review",
          };
  const outcome: GateOutcome =
    pr.ci_state === "Pending"
      ? "pending"
      : "Failing" in pr.ci_state
        ? "bad"
        : pr.ci_state.Passing.passed === pr.ci_state.Passing.total
          ? "ok"
          : "pending";
  return { review, checks: { outcome, value: formatCiState(pr) } };
}

/** "InProgress" -> "In progress", for states printed as the API stores them. */
function humanize(value: string): string {
  const spaced = value.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Chip colour by what the state means, so the list can be scanned. */
function stateChip(state: string): string {
  if (state === "Approved" || state === "Done") return "chip chip--ok";
  if (state === "ChangesRequested" || state === "Cancelled") return "chip chip--bad";
  if (state === "InProgress" || state === "InReview") return "chip chip--instrument";
  return "chip";
}

function prKey(pr: PullRequest): string {
  return `${pr.repo}#${pr.number}`;
}

export function App(): React.JSX.Element {
  const [section, setSection] = useState<SectionKey>("overview");
  const [ticketView, setTicketView] = useState<TicketView>("assigned");
  const [prView, setPrView] = useState<PrView>("all");
  const [dataState, setDataState] = useState<DataState>("full");
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);
  const [selectedTicketKey, setSelectedTicketKey] = useState<string>("");
  const [selectedPrKey, setSelectedPrKey] = useState<string>("");
  const [ticketFilter, setTicketFilter] = useState<string>("");
  const [prFilter, setPrFilter] = useState<string>("");
  const [actionStatus, setActionStatus] = useState<string>("");
  const [settingsStatus, setSettingsStatus] = useState<string>("");
  const [syncError, setSyncError] = useState<string>("");
  // One ticket/PR action at a time; the buttons disable while it runs.
  const [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState(savedTheme());
  // PR key awaiting a second click on merge (it cannot be undone).
  const [confirmMergeKey, setConfirmMergeKey] = useState<string>("");

  const [planeBaseUrl, setPlaneBaseUrl] = useState<string>(
    "https://api.plane.so"
  );
  const [planeWorkspaceSlug, setPlaneWorkspaceSlug] = useState<string>("");
  const [planeProjectId, setPlaneProjectId] = useState<string>("");
  const [planeToken, setPlaneToken] = useState<string>("");
  // PR key -> diff lines (or an error line), fetched when a PR is opened.
  const [diffs, setDiffs] = useState<Record<string, string[]>>({});
  const [layout, setLayout] = useLayout();
  const [features, setFeature] = useFeatures();
  const agents = useAgents(section === "agents", features.agents);
  const builder = useBuilder(features.prototypes);
  const spaces = useSpaces();
  const requests = useRequests();
  // Set by an agent's "Hand off": opens the Memory view's composer on that folder.
  const [handoffPrefill, setHandoffPrefill] = useState<HandoffPrefill | null>(null);
  // A view whose feature was just turned off falls back to Overview.
  const sectionFeature: Partial<Record<SectionKey, FeatureKey>> = {
    tickets: "tickets",
    git: "prs",
    agents: "agents",
    builder: "prototypes",
    requests: "requests",
    memory: "memory",
  };
  useEffect(() => {
    const needed = sectionFeature[section];
    if (needed && !features[needed]) setSection("overview");
  }, [section, features]);
  // Files or Changes beside the terminals, for the focused terminal's folder.
  const [sidePanel, setSidePanel] = useState<PanelMode | null>(null);
  const space = spaces.status[spaces.cwdOf(spaces.active)];
  const [refreshing, setRefreshing] = useState<"plane" | "git" | null>(null);
  const [planeProjects, setPlaneProjects] = useState<PlaneProject[]>([]);
  const [githubRepo, setGithubRepo] = useState<string>("");
  const [githubToken, setGithubToken] = useState<string>("");
  const [calendarUrl, setCalendarUrl] = useState<string>("");
  const [localRepoPath, setLocalRepoPath] = useState<string>(".");

  function applyDashboard(payload: DashboardPayload): void {
    setDashboard(payload);
    setPlaneBaseUrl(payload.config.plane_base_url);
    setPlaneWorkspaceSlug(payload.config.plane_workspace_slug);
    setPlaneProjectId(payload.config.plane_project_id);
    setGithubRepo(payload.config.github_repo);
    setLocalRepoPath(payload.config.local_repo_path);
  }

  useEffect(() => {
    getDashboardState()
      .then((payload) => {
        applyDashboard(payload);
      })
      .catch((err) => {
        setSyncError(String(err));
        setDataState("error");
      });
  }, []);

  const tickets: Ticket[] = dashboard?.tickets ?? [];
  // Scoped to the active space's GitHub repo; folders without one see every PR.
  const spaceRepo = space?.github_repo?.toLowerCase();
  const prs: PullRequest[] = (dashboard?.pull_requests ?? []).filter(
    (p) => !spaceRepo || p.repo.toLowerCase() === spaceRepo
  );

  const assignedTickets = tickets.filter((t) => t.assigned_to_me);
  const backlogTickets = tickets.filter(
    (t) => t.state === "Todo" || t.state === "Backlog"
  );
  const activeTickets = tickets.filter(
    (t) => t.state === "InProgress" || t.state === "InReview"
  );

  const reviewPrs = prs.filter((p) => p.review_requested);
  const myPrs = prs.filter((p) => !p.review_requested);
  const mergePrs = myPrs.filter(
    (p) => p.review_state === "Approved" && p.mergeable
  );

  const subMenuTickets =
    ticketView === "assigned"
      ? assignedTickets
      : ticketView === "backlog"
        ? backlogTickets
        : ticketView === "active"
          ? activeTickets
          : tickets;

  const filteredTickets = subMenuTickets.filter(
    (t) =>
      t.key.toLowerCase().includes(ticketFilter.toLowerCase()) ||
      t.title.toLowerCase().includes(ticketFilter.toLowerCase())
  );

  const subMenuPrs =
    prView === "review"
      ? reviewPrs
      : prView === "merge"
        ? mergePrs
        : prView === "mine"
          ? myPrs
          : prs;

  const filteredPrs = subMenuPrs.filter(
    (p) =>
      String(p.number).includes(prFilter) ||
      p.repo.toLowerCase().includes(prFilter.toLowerCase()) ||
      p.title.toLowerCase().includes(prFilter.toLowerCase()) ||
      p.source_branch.toLowerCase().includes(prFilter.toLowerCase())
  );

  const activeTicket =
    filteredTickets.find((t) => t.key === selectedTicketKey) ??
    filteredTickets[0] ??
    tickets[0];

  const activePr =
    filteredPrs.find((p) => prKey(p) === selectedPrKey) ??
    filteredPrs[0] ??
    prs[0];

  const activePrKey = activePr ? prKey(activePr) : "";
  const activeDiff = activePr?.diff_preview.length
    ? activePr.diff_preview
    : diffs[activePrKey];

  useEffect(() => {
    if (section !== "git" || !activePr || activeDiff) return;
    getPrDiff(activePr.repo, activePr.number)
      .then((lines) => setDiffs((d) => ({ ...d, [activePrKey]: lines })))
      .catch((err) =>
        setDiffs((d) => ({ ...d, [activePrKey]: [`Could not load diff: ${String(err)}`] }))
      );
  }, [section, activePrKey]);

  const linkedPrForTicket = activeTicket
    ? prs.find((p) => p.linked_ticket_key === activeTicket.key)
    : undefined;
  const ticketGroups = TICKET_GROUPS.map((g) => ({
    ...g,
    items: filteredTickets.filter((t) => t.state === g.state),
  })).filter((g) => g.items.length > 0);
  const prGroups = PR_GROUPS.map((g) => ({
    ...g,
    items: filteredPrs.filter((p) => p.review_state === g.state),
  })).filter((g) => g.items.length > 0);
  const gates = activePr ? prGates(activePr) : undefined;
  const mergeBlock = !activePr
    ? undefined
    : !activePr.mergeable
      ? "GitHub reports this PR can't be merged yet"
      : activePr.ci_state !== "Pending" && "Failing" in activePr.ci_state
        ? "Checks are failing"
        : activePr.review_state === "ChangesRequested"
          ? "Changes were requested"
          : undefined;
  const linkedKey = activePr?.linked_ticket_key ?? undefined;
  const stepIndex = TICKET_STEPS.findIndex((s) => s.state === activeTicket?.state);
  const ciFailing =
    !!linkedPrForTicket &&
    linkedPrForTicket.ci_state !== "Pending" &&
    "Failing" in linkedPrForTicket.ci_state;
  const updatedDate = activeTicket?.updated_at ? new Date(activeTicket.updated_at) : null;
  const updatedAt =
    updatedDate && !Number.isNaN(updatedDate.getTime())
      ? updatedDate.toLocaleString(undefined, {
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "";

  function handleMenuSelect(nextSection: SectionKey, view?: PrView): void {
    setSection(nextSection);
    if (view) setPrView(view);
    setDataState("full");
    setActionStatus("");
    setConfirmMergeKey("");
  }

  function openSpace(id: string): void {
    spaces.select(id);
    setSection("terminal");
  }

  function openTerminalTab(): void {
    spaces.openTab();
    setSection("terminal");
  }

  // ⌘T new tab, ⌘D split right, ⇧⌘D split down, ⌘W close the focused terminal.
  // Captured before xterm sees them. Close Window is ⇧⌘W in the app menu, so ⌘W never closes the app.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!e.metaKey || e.altKey || e.ctrlKey) return;
      const key = e.key.toLowerCase();
      if (key === "t") {
        e.preventDefault();
        openTerminalTab();
      } else if (key === "d" && section === "terminal") {
        e.preventDefault();
        spaces.splitFocused(e.shiftKey ? "col" : "row");
      } else if (key === "w" && !e.shiftKey) {
        // Outside the terminals ⌘W does nothing rather than close the window.
        e.preventDefault();
        if (section === "terminal") spaces.closeFocused();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  async function handleSyncProviders(): Promise<void> {
    setDataState("loading");
    try {
      const next = await syncProviders();
      applyDashboard(next);
      setDataState("full");
    } catch (err) {
      setSyncError(String(err));
      setDataState("error");
    }
  }

  async function handleRefresh(kind: "plane" | "git"): Promise<void> {
    setRefreshing(kind);
    try {
      const next = await syncOne(kind === "plane" ? "sync_plane" : "sync_github");
      applyDashboard(next);
      setActionStatus(
        kind === "plane"
          ? `Plane refreshed: ${next.tickets.length} tickets`
          : `GitHub refreshed: ${next.pull_requests.length} PRs`
      );
    } catch (err) {
      setActionStatus(`${kind === "plane" ? "Plane" : "GitHub"}: ${String(err)}`);
    } finally {
      setRefreshing(null);
    }
  }

  async function runAction(action: () => Promise<string>): Promise<void> {
    setBusy(true);
    try {
      setActionStatus(await action());
    } catch (err) {
      setActionStatus(String(err));
    } finally {
      setBusy(false);
    }
  }

  /** The local clone of `repo` (`owner/name`): a folder in or beside the ones already known. */
  async function findRepoFolder(repo: string): Promise<string | null> {
    const known = [
      ...spaces.list.map(spaces.cwdOf),
      shortPath(localRepoPath),
      ...agents.sessions.map((s) => shortPath(s.cwd)),
    ];
    const candidates = await withSiblingFolders(known);
    const found = (await spaceStatus(candidates)).find((s) => s.github_repo?.toLowerCase() === repo.toLowerCase());
    return found?.path ?? null;
  }

  /** Starts `claude` in a terminal at the PR's repo, to review it or resolve its merge conflicts. */
  async function runAgentOnPr(pr: PullRequest, kind: "review" | "conflicts"): Promise<void> {
    try {
      const folder = await findRepoFolder(pr.repo);
      if (!folder) {
        setActionStatus(`No local clone of ${pr.repo} found. Open it in a terminal once, then try again.`);
        return;
      }
      const n = pr.number;
      const where = `#${n} in ${pr.repo} (${pr.source_branch} into ${pr.target_branch})`;
      const prompt =
        kind === "review"
          ? `Review pull request ${where}. Read it with \`gh pr view ${n} --repo ${pr.repo}\` and \`gh pr diff ${n} --repo ${pr.repo}\`. List bugs, risky changes and missing tests, most severe first, each with file and line. Do not change any files and do not post anything to GitHub unless I ask.`
          : `Pull request ${where} cannot be merged because of conflicts. If this working tree has uncommitted changes, stop and tell me first. Otherwise fetch origin, check out ${pr.source_branch}, merge origin/${pr.target_branch} into it and resolve the conflicts, keeping the intent of both sides. Run the project's checks, then show me the resolution and wait for my go-ahead before committing or pushing.`;
      spaces.runIn(folder, `claude '${prompt.replace(/'/g, "'\\''")}'`);
      setSection("terminal");
    } catch (err) {
      setActionStatus(String(err));
    }
  }

  function handleCheckoutTicketBranch(ticketKey: string): Promise<void> {
    return runAction(async () => {
      const branch = await startTicketBranch(ticketKey);
      applyDashboard(await getDashboardState());
      return `Checked out ${branch}`;
    });
  }

  function handleApproveActivePr(): Promise<void> {
    return runAction(async () => {
      await approvePr(activePr.repo, activePr.number);
      applyDashboard(await getDashboardState());
      return `Approved ${prKey(activePr)}`;
    });
  }

  function handleMergeActivePr(): Promise<void> {
    setConfirmMergeKey("");
    return runAction(async () => {
      applyDashboard(
        await mergePrAndCloseTicket(activePr.repo, activePr.number, activePr.linked_ticket_key)
      );
      return activePr.linked_ticket_key
        ? `Merged ${prKey(activePr)} and closed ${activePr.linked_ticket_key}`
        : `Merged ${prKey(activePr)}`;
    });
  }

  async function handleLoadPlaneProjects(): Promise<void> {
    setSettingsStatus("Loading Plane projects…");
    try {
      const projects = await listPlaneProjects(
        planeBaseUrl.trim(),
        planeWorkspaceSlug.trim(),
        planeToken || undefined
      );
      setPlaneProjects(projects);
      setSettingsStatus(`Plane connected: ${projects.length} projects`);
    } catch (err) {
      setSettingsStatus(`Plane: ${String(err)}`);
    }
  }

  // Like top-bar, list the workspace's projects once settings open.
  useEffect(() => {
    if (section === "settings" && planeProjects.length === 0) {
      void handleLoadPlaneProjects();
    }
  }, [section]);

  async function handleImportCalendar(file: File | undefined): Promise<void> {
    if (!file) return;
    try {
      const count = await importCalendar(await file.text());
      setSettingsStatus(`Imported ${count} events from ${file.name}`);
    } catch (err) {
      setSettingsStatus(`Calendar: ${String(err)}`);
    }
  }

  async function handleSaveSettings(): Promise<void> {
    const baseConfig: WorkspaceConfig = dashboard?.config ?? {
      issue_provider: "plane.so",
      plane_base_url: "https://api.plane.so",
      plane_workspace_slug: "",
      plane_project_id: "",
      git_provider: "github",
      github_api_url: "https://api.github.com",
      github_repo: "",
      local_repo_path: ".",
    };
    const updatedConfig = await saveWorkspaceConfig(
      {
        ...baseConfig,
        plane_base_url: planeBaseUrl.trim(),
        plane_workspace_slug: planeWorkspaceSlug.trim(),
        plane_project_id: planeProjectId.trim(),
        github_repo: githubRepo.trim(),
        local_repo_path: localRepoPath,
      },
      planeToken || undefined,
      githubToken || undefined,
      calendarUrl || undefined
    );
    if (dashboard) {
      setDashboard({ ...dashboard, config: updatedConfig });
    }
    setPlaneToken("");
    setGithubToken("");
    setCalendarUrl("");
    setSettingsStatus("Settings saved");
  }

  return (
    <div
      className="app-shell"
      data-sidebar-collapsed={layout.sidebarCollapsed || undefined}
      style={
        {
          "--sidebar-w": `${layout.sidebarWidth}px`,
          "--list-w": `${layout.listWidth}px`,
        } as React.CSSProperties
      }
    >
      <div className="workspace-grid">
        <aside id="sidebar" className="sidebar" aria-label="Workspace navigation">
          <div className="sidebar-head">
            <span className="wordmark">Panguyuban</span>
            <button
              type="button"
              className="collapse-btn"
              aria-controls="sidebar"
              aria-expanded={!layout.sidebarCollapsed}
              aria-label={layout.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={layout.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={() => setLayout({ sidebarCollapsed: !layout.sidebarCollapsed })}
            >
              <Icon name={layout.sidebarCollapsed ? "expand" : "collapse"} />
            </button>
          </div>
          {!layout.sidebarCollapsed && (
            <Splitter
              label="Resize sidebar"
              controls="sidebar"
              value={layout.sidebarWidth}
              min={180}
              max={400}
              defaultValue={DEFAULT_LAYOUT.sidebarWidth}
              onChange={(sidebarWidth) => setLayout({ sidebarWidth })}
            />
          )}

          <SidebarSpaces spaces={spaces} onOpen={openSpace} />

          <nav className="nav-card nav-card--views" aria-label="Views">
            <NavItem
              icon="home"
              label="Overview"
              hint="What needs you"
              current={section === "overview"}
              collapsed={layout.sidebarCollapsed}
              attention={agents.waiting > 0}
              onSelect={() => handleMenuSelect("overview")}
            />
            {features.tickets && (
<NavItem
              icon="ticket"
              label="Tickets"
              hint="Plane"
              count={tickets.length}
              current={section === "tickets"}
              collapsed={layout.sidebarCollapsed}
              refreshing={refreshing === "plane"}
              refreshDisabled={refreshing !== null}
              onSelect={() => handleMenuSelect("tickets")}
              onRefresh={() => handleRefresh("plane")}
            />
)}
            {features.prs && (
<NavItem
              icon="pr"
              label="Pull requests"
              hint={space?.github_repo ?? "GitHub"}
              count={prs.length}
              current={section === "git"}
              collapsed={layout.sidebarCollapsed}
              refreshing={refreshing === "git"}
              refreshDisabled={refreshing !== null}
              onSelect={() => handleMenuSelect("git")}
              onRefresh={() => handleRefresh("git")}
            />
)}
            {features.agents && (
<NavItem
              icon="agents"
              label="Agents"
              hint={
                agents.waiting
                  ? `${agents.waiting} need${agents.waiting === 1 ? "s" : ""} you`
                  : agents.busy
                    ? `${agents.busy} working`
                    : "Claude · Antigravity"
              }
              attention={agents.waiting > 0}
              count={agents.sessions.length}
              current={section === "agents"}
              collapsed={layout.sidebarCollapsed}
              refreshing={agents.refreshing}
              refreshDisabled={agents.refreshing}
              onSelect={() => handleMenuSelect("agents")}
              onRefresh={agents.refresh}
            />
)}
            {features.prototypes && (
<NavItem
              icon="prototypes"
              label="Prototypes"
              hint="Guided builder"
              count={builder.projects.length}
              current={section === "builder"}
              collapsed={layout.sidebarCollapsed}
              onSelect={() => handleMenuSelect("builder")}
            />
)}
            {features.requests && (
<NavItem
              icon="requests"
              label="Requests"
              hint="HTTP client"
              count={requests.drafts.length}
              current={section === "requests"}
              collapsed={layout.sidebarCollapsed}
              onSelect={() => handleMenuSelect("requests")}
            />
)}
            {features.memory && (
<NavItem
              icon="memory"
              label="Memory"
              hint="Note and handoffs"
              current={section === "memory"}
              collapsed={layout.sidebarCollapsed}
              onSelect={() => handleMenuSelect("memory")}
            />
)}
          </nav>

          {!layout.sidebarCollapsed && features.agents && (
            <SidebarAgents
              agents={agents}
              onOpen={(id) => {
                agents.setSelectedId(id);
                handleMenuSelect("agents");
              }}
            />
          )}

          <nav className="nav-card nav-card--bottom" aria-label="System">
            <NavItem
              icon="settings"
              label="Settings"
              current={section === "settings"}
              collapsed={layout.sidebarCollapsed}
              onSelect={() => handleMenuSelect("settings")}
            />
          </nav>
        </aside>

        <div className="stage">
          {/* Terminal tabs only belong to the terminals; other views get the full height. */}
          {section === "terminal" && (
            <div className="tabbar" role="toolbar" aria-label="Tabs">
              {(spaces.active?.tabs ?? []).map((tab, idx) => {
                const current = section === "terminal" && tab.id === spaces.currentTab?.id;
                return (
                  <div key={tab.id} className="tab" data-current={current || undefined}>
                    <button
                      type="button"
                      className="tab-main"
                      aria-pressed={current}
                      onClick={() => {
                        spaces.selectTab(tab.id);
                        setSection("terminal");
                      }}
                    >
                      <span aria-hidden="true">›_</span> {idx + 1}
                    </button>
                    <button
                      type="button"
                      className="tab-close"
                      aria-label={`Close terminal tab ${idx + 1}`}
                      onClick={() => spaces.closeTab(tab.id)}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
              <button
                type="button"
                className="tab-add"
                aria-label="New terminal tab"
                title="New terminal tab (⌘T)"
                onClick={openTerminalTab}
              >
                +
              </button>
              <span className="tabbar-spacer" />
              {(["files", "changes"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className="tab-add tab-toggle"
                  aria-pressed={sidePanel === mode}
                  onClick={() => setSidePanel(sidePanel === mode ? null : mode)}
                >
                  <Icon name={mode} size={14} />
                  {mode === "files" ? "Files" : "Changes"}
                </button>
              ))}
            </div>
          )}

          {/* Always mounted (hidden off the terminals) so shells keep running. */}
          <div className="term-area" hidden={section !== "terminal"}>
            <TerminalStages spaces={spaces} shown={section === "terminal"} />

            {!spaces.currentTab && (
              <main className="main-stage main-stage--single">
                <section className="pane" aria-live="polite">
                  <div className="state-box">
                    <h1>No terminals open</h1>
                    <button type="button" className="btn btn--primary" onClick={openTerminalTab}>
                      Open a terminal (⌘T)
                    </button>
                  </div>
                </section>
              </main>
            )}

            {sidePanel && spaces.currentTab && (
              <FolderPanel mode={sidePanel} cwd={spaces.cwdOf(spaces.active)} onClose={() => setSidePanel(null)} />
            )}
          </div>

          {section !== "terminal" && dataState === "loading" && (
            <main className="main-stage main-stage--single">
              <section className="pane" aria-live="polite">
                <div className="state-box">
                  <h1>Syncing tickets and pull requests…</h1>
                  <div className="skeleton-line"></div>
                  <div className="skeleton-line"></div>
                  <div className="skeleton-line"></div>
                </div>
              </section>
            </main>
          )}

          {section !== "terminal" &&
            (dataState === "empty" ||
              (dataState === "full" &&
                ((section === "tickets" && !activeTicket) || (section === "git" && !activePr)))) && (
            <main className="main-stage main-stage--single">
              <section className="pane" aria-live="polite">
                <div className="state-box">
                  <h1>{section === "git" ? "No pull requests here" : "No tickets here"}</h1>
                  <p className="lead">
                    Nothing is waiting on you, or it has not synced yet.
                  </p>
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={handleSyncProviders}
                  >
                    Sync now
                  </button>
                </div>
              </section>
            </main>
          )}

          {section !== "terminal" && dataState === "error" && (
            <main className="main-stage main-stage--single">
              <section className="pane" aria-live="polite">
                <div className="state-box">
                  <h1>Could not sync tickets and pull requests</h1>
                  <p className="lead">
                    {syncError || "The sync failed."} Check your Plane and GitHub tokens in
                    Settings, or retry.
                  </p>
                  <div className="action-group">
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() => handleMenuSelect("settings")}
                    >
                      Open settings
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={handleSyncProviders}
                    >
                      Retry sync
                    </button>
                  </div>
                </div>
              </section>
            </main>
          )}

          {dataState === "full" && section === "tickets" && activeTicket && (
            <main className="main-stage" data-focus={layout.detailFocused || undefined}>
              <section id="ticket-list" className="pane pane--list" aria-label="Plane ticket queue">
                <Splitter
                  label="Resize list"
                  controls="ticket-list"
                  value={layout.listWidth}
                  min={260}
                  max={720}
                  defaultValue={DEFAULT_LAYOUT.listWidth}
                  onChange={(listWidth) => setLayout({ listWidth })}
                />
                <div className="pane-header">
                  <h1>Tickets</h1>
                </div>

                <FilterTabs
                  label="Ticket filter"
                  value={ticketView}
                  onChange={setTicketView}
                  options={[
                    { value: "assigned", label: "Mine", count: assignedTickets.length },
                    { value: "backlog", label: "Todo", count: backlogTickets.length },
                    { value: "active", label: "In progress", count: activeTickets.length },
                    { value: "all", label: "All", count: tickets.length },
                  ]}
                />

                <div className="filter-bar">
                  <label htmlFor="ticket-search" className="visually-hidden">
                    Filter Plane tickets
                  </label>
                  <input
                    id="ticket-search"
                    name="ticket-search"
                    type="search"
                    autoComplete="off"
                    inputMode="search"
                    className="input-field"
                    placeholder="Filter by key or title"
                    value={ticketFilter}
                    onChange={(e) => setTicketFilter(e.target.value)}
                  />
                </div>

                {ticketGroups.map((group) => (
                  <section key={group.state} className="ticket-group" aria-label={`${group.label} tickets`}>
                    <div className="ticket-group-head">
                      <h2>{group.label}</h2>
                      <span className="measured">{group.items.length}</span>
                    </div>
                    <ul className="ticket-rows">
                      {group.items.map((ticket) => {
                        const selected = ticket.key === activeTicket.key;
                        const priority = ticket.priority?.toLowerCase();
                        return (
                          <li key={ticket.key}>
                            <button
                              type="button"
                              className="ticket-row"
                              data-selected={selected ? "true" : "false"}
                              aria-current={selected ? "true" : undefined}
                              onClick={() => setSelectedTicketKey(ticket.key)}
                            >
                              <span className="ticket-row-top">
                                <span className="ticket-row-key">{ticket.key}</span>
                                {(priority === "urgent" || priority === "high") && (
                                  <span className="ticket-row-priority" data-priority={priority}>
                                    {humanize(priority)}
                                  </span>
                                )}
                              </span>
                              <span className="ticket-row-title">{ticket.title}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
                {filteredTickets.length === 0 && (
                  <p className="ticket-empty">No tickets match this filter</p>
                )}
              </section>

              <section
                className="pane pane--detail ticket-detail"
                aria-label="Selected Plane ticket inspector"
              >
                <div className="ticket-head">
                  <span className="measured-ink">{activeTicket.key}</span>
                  <div className="pane-tools">
                    {activeTicket.url && (
                      <a href={activeTicket.url} target="_blank" rel="noreferrer" className="btn">
                        Open in Plane
                      </a>
                    )}
                    <FocusButton layout={layout} setLayout={setLayout} />
                  </div>
                </div>
                <h2 className="ticket-title">{activeTicket.title}</h2>

                <ol className="ticket-track" aria-label="Ticket progress">
                  {TICKET_STEPS.map((step, idx) => (
                    <li
                      key={step.state}
                      data-step={idx < stepIndex ? "past" : idx === stepIndex ? "current" : "later"}
                      aria-current={idx === stepIndex ? "step" : undefined}
                    >
                      <span>{step.label}</span>
                      {step.state === "InReview" && linkedPrForTicket && (
                        <span
                          className="ticket-track-pr"
                          data-failing={ciFailing || undefined}
                        >
                          #{linkedPrForTicket.number} {formatCiState(linkedPrForTicket)}
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
                {activeTicket.state === "Cancelled" && (
                  <p className="ticket-cancelled">Cancelled</p>
                )}

                <div className="ticket-body">
                  <TicketDescription
                    text={activeTicket.description}
                    ticketUrl={activeTicket.url}
                  />
                  <dl className="ticket-facts">
                    <div>
                      <dt>Assignee</dt>
                      <dd>{activeTicket.assignee ?? "Unassigned"}</dd>
                    </div>
                    <div>
                      <dt>Priority</dt>
                      <dd>{activeTicket.priority ? humanize(activeTicket.priority) : "None"}</dd>
                    </div>
                    {updatedAt && (
                      <div>
                        <dt>Updated</dt>
                        <dd>{updatedAt}</dd>
                      </div>
                    )}
                    <div>
                      <dt>Pull request</dt>
                      <dd>
                        {linkedPrForTicket
                          ? `#${linkedPrForTicket.number} ${formatCiState(linkedPrForTicket)}`
                          : "None yet"}
                      </dd>
                    </div>
                  </dl>
                </div>

                <div className="action-bar">
                  <div className="action-group">
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={busy}
                      onClick={() => handleCheckoutTicketBranch(activeTicket.key)}
                    >
                      Checkout branch
                    </button>
                    {linkedPrForTicket ? (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          setSelectedPrKey(prKey(linkedPrForTicket));
                          handleMenuSelect("git", "all");
                        }}
                      >
                        Open pull request #{linkedPrForTicket.number}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => handleMenuSelect("git", "merge")}
                      >
                        Open pull requests
                      </button>
                    )}
                  </div>
                  <span className="measured" role="status">{actionStatus}</span>
                </div>
              </section>
            </main>
          )}

          {dataState === "full" && section === "git" && activePr && (
            <main className="main-stage" data-focus={layout.detailFocused || undefined}>
              <section id="pr-list" className="pane pane--list" aria-label="GitHub pull request queue">
                <Splitter
                  label="Resize list"
                  controls="pr-list"
                  value={layout.listWidth}
                  min={260}
                  max={720}
                  defaultValue={DEFAULT_LAYOUT.listWidth}
                  onChange={(listWidth) => setLayout({ listWidth })}
                />
                <div className="pane-header">
                  <h1>Pull requests</h1>
                  <span className="chip chip--instrument">
                    {dashboard?.config.github_repo || "All repos"}
                  </span>
                </div>

                <FilterTabs
                  label="Pull request filter"
                  value={prView}
                  onChange={setPrView}
                  options={[
                    { value: "review", label: "To review", count: reviewPrs.length },
                    { value: "mine", label: "Mine", count: myPrs.length },
                    { value: "merge", label: "Ready", count: mergePrs.length },
                    { value: "all", label: "All", count: prs.length },
                  ]}
                />

                <div className="filter-bar">
                  <label htmlFor="pr-search" className="visually-hidden">
                    Filter pull requests
                  </label>
                  <input
                    id="pr-search"
                    name="pr-search"
                    type="search"
                    autoComplete="off"
                    inputMode="search"
                    className="input-field"
                    placeholder="Filter by PR number or branch"
                    value={prFilter}
                    onChange={(e) => setPrFilter(e.target.value)}
                  />
                </div>

                {prGroups.map((group) => (
                  <section key={group.state} className="ticket-group" aria-label={`${group.label} pull requests`}>
                    <div className="ticket-group-head">
                      <h2>{group.label}</h2>
                      <span className="measured">{group.items.length}</span>
                    </div>
                    <ul className="ticket-rows">
                      {group.items.map((pr) => {
                        const selected = prKey(pr) === prKey(activePr);
                        const checksFailing = pr.ci_state !== "Pending" && "Failing" in pr.ci_state;
                        return (
                          <li key={prKey(pr)}>
                            <button
                              type="button"
                              className="ticket-row"
                              data-selected={selected ? "true" : "false"}
                              aria-current={selected ? "true" : undefined}
                              onClick={() => setSelectedPrKey(prKey(pr))}
                            >
                              <span className="ticket-row-top">
                                <span className="ticket-row-key">{`${pr.repo.split("/").pop()}#${pr.number}`}</span>
                                {checksFailing ? (
                                  <span className="ticket-row-priority" data-priority="urgent">
                                    Checks failing
                                  </span>
                                ) : (
                                  <span className="pr-row-size">
                                    +{pr.additions} −{pr.deletions}
                                  </span>
                                )}
                              </span>
                              <span className="ticket-row-title">{pr.title}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
                {filteredPrs.length === 0 && (
                  <p className="ticket-empty">No pull requests match this filter</p>
                )}
              </section>

              <section
                className="pane pane--detail ticket-detail"
                aria-label="Selected pull request inspector"
              >
                <div className="ticket-head">
                  <span className="measured-ink">{prKey(activePr)}</span>
                  <div className="pane-tools">
                    {activePr.url && (
                      <a href={activePr.url} target="_blank" rel="noreferrer" className="btn">
                        Open on GitHub
                      </a>
                    )}
                    <FocusButton layout={layout} setLayout={setLayout} />
                  </div>
                </div>
                <h2 className="ticket-title">{activePr.title}</h2>
                <p className="pr-byline">
                  {activePr.source_branch} into {activePr.target_branch}, by {activePr.author}
                </p>

                <div className="pr-gates">
                  <dl aria-label="Merge readiness">
                    <div data-outcome={gates!.review.outcome}>
                      <dt>Review</dt>
                      <dd>{gates!.review.value}</dd>
                    </div>
                    <div data-outcome={gates!.checks.outcome}>
                      <dt>Checks</dt>
                      <dd>{gates!.checks.value}</dd>
                    </div>
                    <div data-outcome={activePr.mergeable ? "ok" : "bad"}>
                      <dt>Conflicts</dt>
                      <dd>{activePr.mergeable ? "None" : "Can't merge yet"}</dd>
                    </div>
                  </dl>
                  <div className="action-group">
                    {activePr.review_requested ? (
                      <button
                        type="button"
                        className="btn btn--primary"
                        disabled={busy}
                        onClick={handleApproveActivePr}
                      >
                        Approve
                      </button>
                    ) : confirmMergeKey === prKey(activePr) ? (
                      <>
                        <button
                          type="button"
                          className="btn btn--primary"
                          disabled={busy}
                          onClick={handleMergeActivePr}
                        >
                          {activePr.linked_ticket_key
                            ? `Confirm: merge and close ${activePr.linked_ticket_key}`
                            : "Confirm merge"}
                        </button>
                        <button type="button" className="btn" onClick={() => setConfirmMergeKey("")}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="btn btn--primary"
                        disabled={busy || !!mergeBlock}
                        title={mergeBlock}
                        onClick={() => setConfirmMergeKey(prKey(activePr))}
                      >
                        Merge
                      </button>
                    )}
                    <button type="button" className="btn" disabled={busy} onClick={() => runAgentOnPr(activePr, "review")}>
                      Review with agent
                    </button>
                    {!activePr.mergeable && (
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => runAgentOnPr(activePr, "conflicts")}
                      >
                        Resolve conflicts with agent
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() =>
                        handleCheckoutTicketBranch(
                          activePr.linked_ticket_key ?? activePr.source_branch
                        )
                      }
                    >
                      Checkout branch
                    </button>
                  </div>
                </div>
                <span className="measured" role="status">
                  {actionStatus}
                </span>

                <dl className="pr-facts">
                  <div>
                    <dt>Changes</dt>
                    <dd className="pr-facts-num">
                      +{activePr.additions} −{activePr.deletions}
                    </dd>
                  </div>
                  <div>
                    <dt>Linked ticket</dt>
                    <dd>
                      {linkedKey && features.tickets && tickets.some((t) => t.key === linkedKey) ? (
                        <button
                          type="button"
                          className="pr-facts-link"
                          onClick={() => {
                            setSelectedTicketKey(linkedKey);
                            handleMenuSelect("tickets");
                          }}
                        >
                          {linkedKey}
                        </button>
                      ) : (
                        linkedKey ?? "None"
                      )}
                    </dd>
                  </div>
                </dl>

                <section className="pr-files" aria-label="Files changed">
                  <h3>Files changed</h3>
                  {!activeDiff ? (
                    <div className="diff-panel">
                      <div className="diff-line">Loading diff…</div>
                    </div>
                  ) : activeDiff.length === 0 ? (
                    <div className="diff-panel">
                      <div className="diff-line">No changes</div>
                    </div>
                  ) : (
                    <DiffFiles lines={activeDiff} />
                  )}
                </section>
              </section>
            </main>
          )}

          {dataState === "full" && section === "agents" && (
            <main className="main-stage" data-focus={layout.detailFocused || undefined}>
              <AgentsView
                agents={agents}
                splitter={
                  <Splitter
                    label="Resize list"
                    controls="agent-list"
                    value={layout.listWidth}
                    min={260}
                    max={720}
                    defaultValue={DEFAULT_LAYOUT.listWidth}
                    onChange={(listWidth) => setLayout({ listWidth })}
                  />
                }
                focusButton={<FocusButton layout={layout} setLayout={setLayout} />}
                onHandOff={
                  features.memory
                    ? (cwd, name) => {
                        setHandoffPrefill({ folder: shortPath(cwd), task: name });
                        handleMenuSelect("memory");
                      }
                    : undefined
                }
              />
            </main>
          )}

          {dataState === "full" && section === "builder" && (
            <main
              className={builder.project ? "main-stage main-stage--builder" : "main-stage main-stage--single"}
            >
              <BuilderView builder={builder} />
            </main>
          )}

          {dataState === "full" && section === "overview" && (
            <main className="main-stage main-stage--single">
              <OverviewView
                features={features}
                myActiveTickets={assignedTickets.filter((t) => t.state === "InProgress" || t.state === "InReview")}
                reviewPrs={reviewPrs}
                mergePrs={mergePrs}
                agents={agents.sessions}
                knownFolders={[
                  ...spaces.list.map(spaces.cwdOf),
                  ...agents.sessions.map((s) => shortPath(s.cwd)),
                  shortPath(localRepoPath),
                ]}
                onOpenInTerminal={(folder) => {
                  spaces.openAt(folder);
                  setSection("terminal");
                }}
                onOpenTicket={(key) => {
                  setTicketView("assigned");
                  setSelectedTicketKey(key);
                  handleMenuSelect("tickets");
                }}
                onOpenPr={(pr, view) => {
                  setSelectedPrKey(prKey(pr));
                  handleMenuSelect("git", view);
                }}
                onOpenAgent={(id) => {
                  agents.setSelectedId(id);
                  handleMenuSelect("agents");
                }}
              />
            </main>
          )}

          {dataState === "full" && section === "requests" && <RequestsView requests={requests} />}

          {dataState === "full" && section === "memory" && (
            <MemoryView prefill={handoffPrefill} runIn={spaces.runIn} showTerminal={() => setSection("terminal")} />
          )}

          {dataState === "full" && section === "settings" && (
            <main className="main-stage main-stage--single">
              <section className="pane" aria-label="Settings">
                <div className="pane-header">
                  <div>
                    <h1>Settings</h1>
                  </div>
                </div>

                <div className="settings-page">
                  <section className="settings-section">
                    <div className="settings-aside">
                      <h2>Features</h2>
                      <p>Turn off what you don’t use. It disappears from the app and stops running in the background.</p>
                    </div>
                    <ul className="settings-body feature-list">
                      {FEATURES.map((f) => (
                        <li key={f.key} className="feature-row">
                          <button
                            type="button"
                            role="switch"
                            className="switch"
                            aria-checked={features[f.key]}
                            aria-label={f.label}
                            onClick={() => setFeature(f.key, !features[f.key])}
                          />
                          <div className="feature-text">
                            <span className="feature-name">{f.label}</span>
                            <span className="feature-note">{f.what}</span>
                            {f.cost && <span className="feature-note">{f.cost}</span>}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>

                  <section className="settings-section">
                    <div className="settings-aside">
                      <h2>Appearance</h2>
                      <p>How the app looks.</p>
                    </div>
                    <div className="settings-body">
              <div className="field-group">
                <label className="field-label" htmlFor="theme">
                  Theme
                </label>
                <select
                  id="theme"
                  name="theme"
                  className="input-field"
                  value={theme}
                  onChange={(e) => {
                    setTheme(e.target.value);
                    applyTheme(e.target.value);
                  }}
                >
                  {THEMES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
                    </div>
                  </section>

                  <section className="settings-section">
                    <div className="settings-aside">
                      <h2>Plane</h2>
                      <p>Where your tickets come from.</p>
                    </div>
                    <div className="settings-body">
                      {features.tickets ? (
                        <>
                <div className="field-group">
                  <label className="field-label" htmlFor="plane-url">
                    Plane server URL
                  </label>
                  <input
                    id="plane-url"
                    name="plane-url"
                    type="url"
                    autoComplete="url"
                    className="input-field"
                    placeholder="https://plane.example.com"
                    value={planeBaseUrl}
                    onChange={(e) => setPlaneBaseUrl(e.target.value)}
                  />
                  <span className="field-help">
                    Self-hosted: your Plane domain. Cloud: https://api.plane.so
                  </span>
                </div>
                <div className="field-group">
                  <label className="field-label" htmlFor="plane-slug">
                    Plane workspace slug
                  </label>
                  <input
                    id="plane-slug"
                    name="plane-slug"
                    type="text"
                    autoComplete="organization"
                    className="input-field"
                    value={planeWorkspaceSlug}
                    onChange={(e) => setPlaneWorkspaceSlug(e.target.value)}
                  />
                  <span className="field-help">
                    From your Plane URL: plane.example.com/[slug]/projects
                  </span>
                </div>
                <div className="field-group">
                  <label className="field-label" htmlFor="plane-project">
                    Plane project
                  </label>
                  <select
                    id="plane-project"
                    name="plane-project"
                    className="input-field"
                    value={planeProjectId}
                    onChange={(e) => setPlaneProjectId(e.target.value)}
                  >
                    <option value="">All projects (first 4)</option>
                    {planeProjectId &&
                      !planeProjects.some((p) => p.id === planeProjectId) && (
                        <option value={planeProjectId}>{planeProjectId}</option>
                      )}
                    {planeProjects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.identifier ? `${p.identifier} · ` : ""}
                        {p.name ?? p.id}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn"
                    onClick={handleLoadPlaneProjects}
                  >
                    Test &amp; load projects
                  </button>
                  <span className="field-help">
                    Uses the URL, slug and token above (or the saved token).
                  </span>
                </div>
                <div className="field-group">
                  <label className="field-label" htmlFor="plane-token">
                    Plane API token
                  </label>
                  <input
                    id="plane-token"
                    name="plane-token"
                    type="password"
                    autoComplete="off"
                    className="input-field"
                    placeholder="Stored in your keychain"
                    value={planeToken}
                    onChange={(e) => setPlaneToken(e.target.value)}
                  />
                  <span className="field-help">
                    Profile settings, Personal access tokens. Saved in OS
                    keychain.
                  </span>
                </div>
                        </>
                      ) : (
                        <p className="settings-off">Tickets is turned off.</p>
                      )}
                    </div>
                  </section>

                  <section className="settings-section">
                    <div className="settings-aside">
                      <h2>GitHub</h2>
                      <p>Where your pull requests, checks and merges come from.</p>
                    </div>
                    <div className="settings-body">
                      {features.prs ? (
                        <>
                <div className="field-group">
                  <label className="field-label" htmlFor="github-repo">
                    Repository filter
                  </label>
                  <input
                    id="github-repo"
                    name="github-repo"
                    type="text"
                    autoComplete="off"
                    className="input-field"
                    placeholder="owner/repo — empty: all your PRs"
                    value={githubRepo}
                    onChange={(e) => setGithubRepo(e.target.value)}
                  />
                </div>
                <div className="field-group">
                  <label className="field-label" htmlFor="local-repo-path">
                    Local git repository path
                  </label>
                  <input
                    id="local-repo-path"
                    name="local-repo-path"
                    type="text"
                    autoComplete="off"
                    className="input-field"
                    value={localRepoPath}
                    onChange={(e) => setLocalRepoPath(e.target.value)}
                  />
                </div>
                <div className="field-group">
                  <label className="field-label" htmlFor="github-token">
                    GitHub personal access token
                  </label>
                  <input
                    id="github-token"
                    name="github-token"
                    type="password"
                    autoComplete="off"
                    className="input-field"
                    placeholder="Leave empty to use gh auth token"
                    value={githubToken}
                    onChange={(e) => setGithubToken(e.target.value)}
                  />
                  <span className="field-help">
                    Optional. Falls back to the GitHub CLI login (gh auth
                    login) when no token is saved.
                  </span>
                </div>
                        </>
                      ) : (
                        <p className="settings-off">Pull requests is turned off.</p>
                      )}
                    </div>
                  </section>

                  <ProvidersSection />

                  <section className="settings-section">
                    <div className="settings-aside">
                      <h2>Calendar</h2>
                      <p>On a Mac, calendars in the Calendar app show up on their own. Add a link or file for any others.</p>
                    </div>
                    <div className="settings-body">
                      {features.meetings ? (
                        <>
                          <div className="field-group">
                            <label className="field-label" htmlFor="calendar-url">
                              Calendar link (iCal / ICS)
                            </label>
                            <input
                              id="calendar-url"
                              name="calendar-url"
                              type="password"
                              autoComplete="off"
                              className="input-field"
                              placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
                              value={calendarUrl}
                              onChange={(e) => setCalendarUrl(e.target.value)}
                            />
                            <span className="field-help">
                              Google Calendar: Settings, your calendar, Secret address
                              in iCal format. Outlook: Publish calendar, ICS link.
                              Anyone with the link can read the calendar, so it is
                              kept in the OS keychain.
                            </span>
                          </div>
                          <div className="field-group">
                            <label className="field-label" htmlFor="calendar-file">
                              Or import an .ics file
                            </label>
                            <input
                              id="calendar-file"
                              name="calendar-file"
                              type="file"
                              accept=".ics,text/calendar"
                              className="input-field"
                              onChange={(e) => void handleImportCalendar(e.target.files?.[0])}
                            />
                            <span className="field-help">
                              A snapshot: import again to pick up changes.
                            </span>
                          </div>
                        </>
                      ) : (
                        <p className="settings-off">Meetings is turned off.</p>
                      )}
                    </div>
                  </section>

                  {(features.tickets || features.prs || features.meetings) && (
                    <div className="settings-save">
                      <button type="button" className="btn btn--primary" onClick={handleSaveSettings}>
                        Save connections
                      </button>
                      <span className="measured" role="status">
                        {settingsStatus}
                      </span>
                    </div>
                  )}
                </div>
              </section>
            </main>
          )}

          <footer className="statusbar">
            <span>This computer</span>
            {space?.branch && (
              <span>
                <Icon name="pr" size={12} />
                {space.branch}
              </span>
            )}
            {features.agents && (
              <span data-attention={agents.waiting > 0 || undefined}>
                ● {agents.sessions.length} agent{agents.sessions.length === 1 ? "" : "s"}
              </span>
            )}
            <span className="tabbar-spacer" />
            {features.tickets && <span>Plane: {dashboard?.config.plane_project_id || "all projects"}</span>}
            {features.prs && <span>GitHub: {space?.github_repo || dashboard?.config.github_repo || "all repos"}</span>}
          </footer>
        </div>
      </div>
    </div>
  );
}

// Asset id -> download URL, shared across tickets for this session.
const assetUrls = new Map<string, Promise<string>>();

function PlaneImage({ src, ticketUrl }: { src: string; ticketUrl: string }) {
  const [url, setUrl] = useState<string | null>(null);
  // Why it failed, shown so a broken asset endpoint or blocked URL is visible.
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUrl(null);
    setError(null);
    if (!assetUrls.has(src)) {
      // Drop failures from the cache so a later open can retry.
      const pending = getPlaneAssetUrl(src).catch((err) => {
        assetUrls.delete(src);
        throw err;
      });
      assetUrls.set(src, pending);
    }
    assetUrls.get(src)!.then(setUrl, (err) => setError(String(err)));
  }, [src]);

  if (error) {
    return (
      <a className="ticket-image-fallback" href={ticketUrl} target="_blank" rel="noreferrer">
        Image could not load ({error}) — open in Plane
      </a>
    );
  }
  if (!url) return <div className="ticket-image-fallback">Loading image…</div>;
  return (
    <img
      className="ticket-image"
      src={url}
      alt="Image from Plane ticket description"
      onError={() => setError(`image URL did not load: ${url.split("?")[0]}`)}
    />
  );
}

/** Ticket description text with `[image:<id>]` lines rendered as images. */
function TicketDescription({ text, ticketUrl }: { text: string; ticketUrl: string }) {
  if (!text) return <p className="ticket-description">No description</p>;
  return (
    <div className="ticket-description">
      {text.split("\n").map((line, idx) => {
        const image = /^\[image:(.+)\]$/.exec(line);
        return image ? (
          <PlaneImage key={idx} src={image[1]} ticketUrl={ticketUrl} />
        ) : (
          <p key={idx}>{line}</p>
        );
      })}
    </div>
  );
}

type TicketView = "assigned" | "backlog" | "active" | "all";
type PrView = "review" | "mine" | "merge" | "all";

/** One sidebar section: select it, see its count, refresh its provider. */
function NavItem(props: {
  icon: IconName;
  label: string;
  hint?: string;
  count?: number;
  current: boolean;
  collapsed: boolean;
  /** Something here needs the user (e.g. an agent waiting for input). */
  attention?: boolean;
  refreshing?: boolean;
  refreshDisabled?: boolean;
  onSelect: () => void;
  onRefresh?: () => void;
}) {
  return (
    <div
      className="nav-item"
      data-current={props.current || undefined}
      data-attention={props.attention || undefined}
    >
      <button
        type="button"
        className="nav-item-main"
        aria-current={props.current ? "page" : undefined}
        title={props.collapsed ? props.label : undefined}
        onClick={props.onSelect}
      >
        <span className="nav-glyph">
          <Icon name={props.icon} />
        </span>
        <span className="nav-text">
          <span className="nav-label">{props.label}</span>
          {props.hint && <span className="nav-hint">{props.hint}</span>}
        </span>
        {props.count !== undefined && (
          <span className="nav-count measured">{props.count}</span>
        )}
      </button>
      {props.onRefresh && (
        <button
          type="button"
          className="refresh-btn"
          aria-label={`Refresh ${props.label}`}
          title={`Refresh ${props.label}`}
          disabled={props.refreshDisabled}
          data-spinning={props.refreshing || undefined}
          onClick={props.onRefresh}
        >
          <Icon name="refresh" size={14} />
        </button>
      )}
    </div>
  );
}


type Layout = {
  sidebarCollapsed: boolean;
  detailFocused: boolean;
  sidebarWidth: number;
  listWidth: number;
};

const DEFAULT_LAYOUT: Layout = {
  sidebarCollapsed: false,
  detailFocused: false,
  sidebarWidth: 240,
  listWidth: 380,
};

const LAYOUT_KEY = "panguyuban.layout";

/** Sidebar/list sizes and collapse/focus toggles, remembered on this machine. */
function useLayout(): [Layout, (patch: Partial<Layout>) => void] {
  const [layout, setLayoutState] = useState<Layout>(() => {
    try {
      return { ...DEFAULT_LAYOUT, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}") };
    } catch {
      return DEFAULT_LAYOUT;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      // storage unavailable: layout just resets next launch
    }
  }, [layout]);
  return [layout, (patch) => setLayoutState((l) => ({ ...l, ...patch }))];
}

/**
 * Drag handle on the right edge of a pane (WAI-ARIA window splitter): drag or
 * arrow keys resize, Home/End jump to min/max, Enter or double-click resets.
 */
function Splitter(props: {
  label: string;
  controls: string;
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  onChange: (value: number) => void;
}) {
  const { value, min, max, defaultValue, onChange } = props;
  const clamp = (v: number) => Math.round(Math.min(max, Math.max(min, v)));

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const handle = e.currentTarget;
    const startX = e.clientX;
    const startValue = value;
    handle.setPointerCapture(e.pointerId);
    document.documentElement.dataset.resizing = "true";
    const move = (ev: PointerEvent) => onChange(clamp(startValue + ev.clientX - startX));
    const up = () => {
      delete document.documentElement.dataset.resizing;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 64 : 16;
    const next: Record<string, number> = {
      ArrowLeft: value - step,
      ArrowRight: value + step,
      Home: min,
      End: max,
      Enter: defaultValue,
    };
    if (e.key in next) {
      e.preventDefault();
      onChange(clamp(next[e.key]));
    }
  }

  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      aria-controls={props.controls}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={`${props.label} (double-click to reset)`}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      onDoubleClick={() => onChange(defaultValue)}
    />
  );
}

/** Toggles the detail pane between split view and full width. */
function FocusButton({
  layout,
  setLayout,
}: {
  layout: Layout;
  setLayout: (patch: Partial<Layout>) => void;
}) {
  const label = layout.detailFocused ? "Show list" : "Expand detail";
  return (
    <button
      type="button"
      className="collapse-btn"
      aria-pressed={layout.detailFocused}
      aria-label={label}
      title={label}
      onClick={() => setLayout({ detailFocused: !layout.detailFocused })}
    >
      {layout.detailFocused ? "⤡" : "⤢"}
    </button>
  );
}
