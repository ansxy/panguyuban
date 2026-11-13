import React, { useEffect, useState } from "react";
import {
  approvePr,
  DashboardPayload,
  getDashboardState,
  getPlaneAssetUrl,
  getPrDiff,
  listPlaneProjects,
  mergePrAndCloseTicket,
  PlaneProject,
  PullRequest,
  saveWorkspaceConfig,
  startTicketBranch,
  syncOne,
  syncProviders,
  Ticket,
  WorkspaceConfig,
} from "./api";
import { DiffFiles, FilterTabs, Icon, type IconName } from "./ui";
import { AgentsView, shortPath, SidebarAgents, useAgents } from "./Agents";
import { BuilderView, useBuilder } from "./Builder";
import { FEATURES, type FeatureKey, useFeatures } from "./features";
import { SidebarSpaces, TerminalStages, useSpaces } from "./Spaces";
import { FolderPanel, PanelMode } from "./FolderPanel";
import { RequestsView, useRequests } from "./Requests";
import { OverviewView } from "./Overview";
import { THEMES, applyTheme, savedTheme } from "./theme";

type SectionKey = "overview" | "tickets" | "git" | "agents" | "builder" | "requests" | "terminal" | "settings";
type DataState = "full" | "loading" | "empty" | "error";

function formatCiState(pr: PullRequest): string {
  if (pr.ci_state === "Pending") return "Pending";
  if ("Passing" in pr.ci_state) {
    return `${pr.ci_state.Passing.passed} / ${pr.ci_state.Passing.total} pass`;
  }
  return `${pr.ci_state.Failing.failed} / ${pr.ci_state.Failing.total} fail`;
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
  // A view whose feature was just turned off falls back to Overview.
  const sectionFeature: Partial<Record<SectionKey, FeatureKey>> = {
    tickets: "tickets",
    git: "prs",
    agents: "agents",
    builder: "prototypes",
    requests: "requests",
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

  // ⌘T new tab, ⌘D split right, ⇧⌘D split down. Captured before xterm sees them.
  // (⌘W stays the native Close Window shortcut.)
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
      githubToken || undefined
    );
    if (dashboard) {
      setDashboard({ ...dashboard, config: updatedConfig });
    }
    setPlaneToken("");
    setGithubToken("");
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
              hint="Plane & GitHub"
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

                <ul className="record-list" aria-label="Plane tickets">
                  {filteredTickets.map((ticket) => (
                    <li
                      key={ticket.key}
                      className="record-item"
                      data-selected={
                        ticket.key === activeTicket.key ? "true" : "false"
                      }
                    >
                      <div className="record-top">
                        <button
                          type="button"
                          className="record-select-btn"
                          onClick={() => setSelectedTicketKey(ticket.key)}
                        >
                          {ticket.key}
                        </button>
                        <span className={stateChip(ticket.state)}>{humanize(ticket.state)}</span>
                      </div>
                      <div className="record-title">{ticket.title}</div>
                      <div className="record-meta">
                        <span className="person-tag">
                          {ticket.assignee ?? "Unassigned"}
                        </span>
                        <span className="measured">
                          {ticket.priority ?? "normal"}
                        </span>
                      </div>
                    </li>
                  ))}
                  {filteredTickets.length === 0 && (
                    <li className="record-item record-meta">No tickets match this filter</li>
                  )}
                </ul>
              </section>

              <section
                className="pane pane--detail"
                aria-label="Selected Plane ticket inspector"
              >
                <div className="pane-header">
                  <div>
                    <span className="measured-ink">{activeTicket.key}</span>
                    <h2>{activeTicket.title}</h2>
                  </div>
                  <div className="pane-tools">
                    <span className="chip chip--person">
                      Assigned: {activeTicket.assignee ?? "Unassigned"}
                    </span>
                    <FocusButton layout={layout} setLayout={setLayout} />
                  </div>
                </div>

                <TicketDescription
                  text={activeTicket.description}
                  ticketUrl={activeTicket.url}
                />

                <div className="reading-row" aria-label="Ticket linked readings">
                  <div className="reading-cell">
                    <span className="reading-label">State</span>
                    <span className="reading-value">{humanize(activeTicket.state)}</span>
                  </div>
                  <div className="reading-cell">
                    <span className="reading-label">Linked pull request</span>
                    <span className="reading-value">
                      {linkedPrForTicket ? `#${linkedPrForTicket.number}` : "None"}
                    </span>
                  </div>
                  <div className="reading-cell">
                    <span className="reading-label">Checks</span>
                    <span className="reading-value">
                      {linkedPrForTicket
                        ? formatCiState(linkedPrForTicket)
                        : "Not started"}
                    </span>
                  </div>
                </div>

                <div className="action-bar">
                  <div className="action-group">
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() => handleMenuSelect("git", "merge")}
                    >
                      Open pull requests
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => handleCheckoutTicketBranch(activeTicket.key)}
                    >
                      Checkout branch
                    </button>
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

                <ul className="record-list" aria-label="Pull requests">
                  {filteredPrs.map((pr) => (
                    <li
                      key={prKey(pr)}
                      className="record-item"
                      data-selected={
                        prKey(pr) === prKey(activePr) ? "true" : "false"
                      }
                    >
                      <div className="record-top">
                        <button
                          type="button"
                          className="record-select-btn"
                          onClick={() => setSelectedPrKey(prKey(pr))}
                        >
                          #{pr.number}
                        </button>
                        <span className={stateChip(pr.review_state)}>{humanize(pr.review_state)}</span>
                      </div>
                      <div className="record-title">{pr.title}</div>
                      <div className="record-meta">
                        <span className="person-tag">{pr.author}</span>
                        <span className="measured">{pr.repo}</span>
                        <span className="measured">
                          {pr.linked_ticket_key ?? "No ticket"}
                        </span>
                      </div>
                    </li>
                  ))}
                  {filteredPrs.length === 0 && (
                    <li className="record-item record-meta">No pull requests match this filter</li>
                  )}
                </ul>
              </section>

              <section
                className="pane pane--detail"
                aria-label="Selected pull request inspector"
              >
                <div className="pane-header">
                  <div>
                    <span className="measured-ink">
                      {prKey(activePr)} ({activePr.source_branch} to{" "}
                      {activePr.target_branch})
                    </span>
                    <h2>{activePr.title}</h2>
                  </div>
                  <div className="pane-tools">
                    <span className={stateChip(activePr.review_state)}>{humanize(activePr.review_state)}</span>
                    <FocusButton layout={layout} setLayout={setLayout} />
                  </div>
                </div>

                <div className="reading-row" aria-label="Pull request summary">
                  <div className="reading-cell">
                    <span className="reading-label">Changes</span>
                    <span className="reading-value">
                      +{activePr.additions} / −{activePr.deletions}
                    </span>
                  </div>
                  <div className="reading-cell">
                    <span className="reading-label">Checks</span>
                    <span className="reading-value">
                      {formatCiState(activePr)}
                    </span>
                  </div>
                  <div className="reading-cell">
                    <span className="reading-label">Linked ticket</span>
                    <span className="reading-value">
                      {activePr.linked_ticket_key ?? "None"}
                    </span>
                  </div>
                </div>

                <div className="inspector-card">
                  <div className="inspector-section">
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
                  </div>
                </div>

                <div className="action-bar">
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
                        disabled={busy || !activePr.mergeable}
                        title={activePr.mergeable ? undefined : "GitHub reports this PR cannot be merged yet"}
                        onClick={() => setConfirmMergeKey(prKey(activePr))}
                      >
                        Squash and merge
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
                  <span className="measured" role="status">
                    {actionStatus}
                  </span>
                </div>
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

                  {(features.tickets || features.prs) && (
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
  hint: string;
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
          <span className="nav-hint">{props.hint}</span>
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
