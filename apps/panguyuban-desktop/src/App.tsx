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
import { FilterTabs, padCount } from "./ui";
import { AgentsView, SidebarAgents, useAgents } from "./Agents";
import { BuilderView, useBuilder } from "./Builder";

type SectionKey = "tickets" | "git" | "agents" | "builder" | "settings";
type DataState = "full" | "loading" | "empty" | "error";

function formatCiState(pr: PullRequest): string {
  if (pr.ci_state === "Pending") return "Pending";
  if ("Passing" in pr.ci_state) {
    return `${pr.ci_state.Passing.passed} / ${pr.ci_state.Passing.total} pass`;
  }
  return `${pr.ci_state.Failing.failed} / ${pr.ci_state.Failing.total} fail`;
}

function prKey(pr: PullRequest): string {
  return `${pr.repo}#${pr.number}`;
}

export function App(): React.JSX.Element {
  const [section, setSection] = useState<SectionKey>("tickets");
  const [ticketView, setTicketView] = useState<TicketView>("assigned");
  const [prView, setPrView] = useState<PrView>("all");
  const [dataState, setDataState] = useState<DataState>("full");
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);
  const [selectedTicketKey, setSelectedTicketKey] = useState<string>("PAN-142");
  const [selectedPrKey, setSelectedPrKey] = useState<string>("");
  const [ticketFilter, setTicketFilter] = useState<string>("");
  const [prFilter, setPrFilter] = useState<string>("");
  const [actionStatus, setActionStatus] = useState<string>("Ready on GitHub");
  const [settingsStatus, setSettingsStatus] = useState<string>(
    "SQLite config ready"
  );

  const [planeBaseUrl, setPlaneBaseUrl] = useState<string>(
    "https://api.plane.so"
  );
  const [planeWorkspaceSlug, setPlaneWorkspaceSlug] =
    useState<string>("panguyuban");
  const [planeProjectId, setPlaneProjectId] =
    useState<string>("panguyuban-core");
  const [planeToken, setPlaneToken] = useState<string>("");
  // PR key -> diff lines (or an error line), fetched when a PR is opened.
  const [diffs, setDiffs] = useState<Record<string, string[]>>({});
  const [layout, setLayout] = useLayout();
  const agents = useAgents(section === "agents");
  const builder = useBuilder();
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
      .catch(() => {
        setDataState("error");
      });
  }, []);

  const tickets: Ticket[] = dashboard?.tickets ?? [];
  const prs: PullRequest[] = dashboard?.pull_requests ?? [];

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
  }

  async function handleSyncProviders(): Promise<void> {
    setDataState("loading");
    try {
      const next = await syncProviders();
      applyDashboard(next);
      setDataState("full");
    } catch {
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

  async function handleCheckoutTicketBranch(ticketKey: string): Promise<void> {
    const branch = await startTicketBranch(ticketKey);
    const next = await getDashboardState();
    applyDashboard(next);
    setActionStatus(`Checked out ${branch}`);
  }

  async function handleApproveActivePr(): Promise<void> {
    if (!activePr) return;
    await approvePr(activePr.repo, activePr.number);
    const next = await getDashboardState();
    applyDashboard(next);
    setActionStatus(`Approved ${prKey(activePr)}`);
  }

  async function handleMergeActivePr(): Promise<void> {
    if (!activePr) return;
    const next = await mergePrAndCloseTicket(
      activePr.repo,
      activePr.number,
      activePr.linked_ticket_key
    );
    applyDashboard(next);
    setActionStatus(
      `Merged ${prKey(activePr)} and closed ${activePr.linked_ticket_key ?? "branch"}`
    );
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
      plane_workspace_slug: "panguyuban",
      plane_project_id: "panguyuban-core",
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
    setSettingsStatus("Saved provider settings to SQLite and keychain");
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
      <header className="topbar">
        <div className="topbar-brand">
          <a href="#tickets" className="wordmark" aria-label="Panguyuban home">
            Panguyuban
          </a>
          <span className="chip chip--instrument" role="status">
            Plane: {dashboard?.config.plane_project_id ?? "panguyuban-core"}
          </span>
          <span className="chip chip--instrument" role="status">
            GitHub: {dashboard?.config.github_repo || "all repos"}
          </span>
        </div>

      </header>

      <div className="workspace-grid">
        <aside id="sidebar" className="sidebar" aria-label="Workspace navigation">
          <div className="sidebar-head">
            <span className="sidebar-title">Workspace</span>
            <button
              type="button"
              className="collapse-btn"
              aria-controls="sidebar"
              aria-expanded={!layout.sidebarCollapsed}
              aria-label={layout.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={layout.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={() => setLayout({ sidebarCollapsed: !layout.sidebarCollapsed })}
            >
              {layout.sidebarCollapsed ? "»" : "«"}
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

          <nav className="nav-card" aria-label="Sections">
            <NavItem
              glyph="◫"
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
            <NavItem
              glyph="⑂"
              label="Pull requests"
              hint="GitHub"
              count={prs.length}
              current={section === "git"}
              collapsed={layout.sidebarCollapsed}
              refreshing={refreshing === "git"}
              refreshDisabled={refreshing !== null}
              onSelect={() => handleMenuSelect("git")}
              onRefresh={() => handleRefresh("git")}
            />
            <NavItem
              glyph="✦"
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
            <NavItem
              glyph="▣"
              label="Prototypes"
              hint="Guided builder"
              count={builder.projects.length}
              current={section === "builder"}
              collapsed={layout.sidebarCollapsed}
              onSelect={() => handleMenuSelect("builder")}
            />
          </nav>

          {!layout.sidebarCollapsed && (
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
              glyph="⚙"
              label="Settings"
              hint="Plane & GitHub"
              current={section === "settings"}
              collapsed={layout.sidebarCollapsed}
              onSelect={() => handleMenuSelect("settings")}
            />
          </nav>
        </aside>

        {dataState === "loading" && (
          <main className="main-stage main-stage--single">
            <section className="pane" aria-live="polite">
              <div className="state-box">
                <h1>Synchronising Plane.so and GitHub records</h1>
                <p className="lead">
                  Reading SQLite cache and polling active adapters over Rust
                  async runtime.
                </p>
                <div className="skeleton-line"></div>
                <div className="skeleton-line"></div>
                <div className="skeleton-line"></div>
              </div>
            </section>
          </main>
        )}

        {dataState === "empty" && (
          <main className="main-stage main-stage--single">
            <section className="pane" aria-live="polite">
              <div className="state-box">
                <h1>No assigned tickets or pull requests in this queue</h1>
                <p className="lead">
                  Your Plane workspace queue is clear, or you can pull the
                  latest changes from your configured providers.
                </p>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={handleSyncProviders}
                >
                  Sync providers now
                </button>
              </div>
            </section>
          </main>
        )}

        {dataState === "error" && (
          <main className="main-stage main-stage--single">
            <section className="pane" aria-live="polite">
              <div className="state-box">
                <h1>Plane.so adapter token expired</h1>
                <p className="lead">
                  The Rust provider-plane client received HTTP 401 from
                  api.plane.so. Update your API key in provider settings or
                  retry connection.
                </p>
                <div className="action-group">
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => handleMenuSelect("settings")}
                  >
                    Open provider settings
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
                <h1>Tickets (Plane.so)</h1>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setSelectedTicketKey("PAN-149")}
                >
                  New ticket
                </button>
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
                        Inspect {ticket.key}
                      </button>
                      <span className="chip chip--ok">{ticket.state}</span>
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
                  <span className="reading-label">Plane state</span>
                  <span className="reading-value">{activeTicket.state}</span>
                </div>
                <div className="reading-cell">
                  <span className="reading-label">Linked pull request</span>
                  <span className="reading-value">
                    {linkedPrForTicket ? `#${linkedPrForTicket.number}` : "None"}
                  </span>
                </div>
                <div className="reading-cell">
                  <span className="reading-label">CI verification</span>
                  <span className="reading-value">
                    {linkedPrForTicket
                      ? formatCiState(linkedPrForTicket)
                      : "Not started"}
                  </span>
                </div>
              </div>

              <div className="inspector-card">
                <div className="inspector-section">
                  <h3>Ticket to Git audit trail</h3>
                  <div className="trail-list">
                    <div className="trail-row">
                      <span className="measured">02:14:09</span>
                      <span className="person-tag">
                        {activeTicket.assignee ?? "@ansar"}
                      </span>
                      <span>
                        Synced {activeTicket.key} from Plane workspace
                      </span>
                    </div>
                    {linkedPrForTicket && (
                      <div className="trail-row">
                        <span className="measured">02:41:12</span>
                        <span className="person-tag">
                          {linkedPrForTicket.author}
                        </span>
                        <span>
                          Linked pull request #{linkedPrForTicket.number} on{" "}
                          {linkedPrForTicket.source_branch}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="action-bar">
                <div className="action-group">
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => handleMenuSelect("git", "merge")}
                  >
                    Open PR view
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => handleCheckoutTicketBranch(activeTicket.key)}
                  >
                    Checkout branch
                  </button>
                </div>
                <span className="measured">{actionStatus}</span>
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
                <h1>Git and Pull Requests</h1>
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
                        Inspect PR #{pr.number}
                      </button>
                      <span className="chip chip--ok">{pr.review_state}</span>
                    </div>
                    <div className="record-title">{pr.title}</div>
                    <div className="record-meta">
                      <span className="person-tag">{pr.author}</span>
                      <span className="measured">{pr.repo}</span>
                      <span className="measured">
                        {pr.linked_ticket_key ?? "unlinked"}
                      </span>
                    </div>
                  </li>
                ))}
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
                  <span className="chip chip--ok">{activePr.review_state}</span>
                  <FocusButton layout={layout} setLayout={setLayout} />
                </div>
              </div>

              <div className="reading-row" aria-label="Pull request telemetry">
                <div className="reading-cell">
                  <span className="reading-label">Diff delta</span>
                  <span className="reading-value">
                    +{activePr.additions} / -{activePr.deletions}
                  </span>
                </div>
                <div className="reading-cell">
                  <span className="reading-label">CI checks</span>
                  <span className="reading-value">
                    {formatCiState(activePr)}
                  </span>
                </div>
                <div className="reading-cell">
                  <span className="reading-label">Linked ticket</span>
                  <span className="reading-value">
                    {activePr.linked_ticket_key ?? "Unlinked"}
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
                    <div className="diff-files">
                      {splitDiffByFile(activeDiff).map((file) => (
                        <details key={file.path} className="diff-file" open>
                          <summary className="diff-file-head">
                            <span className="diff-file-path">{file.path}</span>
                            <span className="diff-file-stat">
                              <span className="diff-stat-plus">+{file.adds}</span>{" "}
                              <span className="diff-stat-minus">−{file.dels}</span>
                            </span>
                          </summary>
                          <div className="diff-panel" aria-label={`Diff of ${file.path}`}>
                            {file.lines.map((line, idx) => (
                              <div
                                key={idx}
                                className={
                                  line.startsWith("@@")
                                    ? "diff-line diff-line--hunk"
                                    : line.startsWith("+")
                                      ? "diff-line diff-line--plus"
                                      : line.startsWith("-")
                                        ? "diff-line diff-line--minus"
                                        : "diff-line"
                                }
                              >
                                {line}
                              </div>
                            ))}
                          </div>
                        </details>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="action-bar">
                <div className="action-group">
                  {activePr.review_requested ? (
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={handleApproveActivePr}
                    >
                      Approve PR
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={handleMergeActivePr}
                    >
                      Squash and merge
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn"
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

        {dataState === "full" && section === "settings" && (
          <main className="main-stage main-stage--single">
            <section className="pane" aria-label="Provider adapter settings">
              <div className="pane-header">
                <div>
                  <h1>Modular provider adapters</h1>
                  <p className="lead">
                    Panguyuban separates Rust traits in panguyuban-core from
                    platform adapters so you can swap Plane.so or GitHub without
                    touching the UI.
                  </p>
                </div>
              </div>

              <div className="settings-grid">
                <div className="inspector-card">
                  <div className="inspector-section">
                    <div className="record-top">
                      <h2>IssueProvider trait</h2>
                      <span className="chip chip--ok">
                        Active: provider-plane
                      </span>
                    </div>
                    <p>
                      Connects ticket queues, state transitions, and cycle
                      metadata to the Tauri frontend.
                    </p>
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
                        placeholder="Stored in OS keychain"
                        value={planeToken}
                        onChange={(e) => setPlaneToken(e.target.value)}
                      />
                      <span className="field-help">
                        Profile settings, Personal access tokens. Saved in OS
                        keychain.
                      </span>
                    </div>
                  </div>
                </div>

                <div className="inspector-card">
                  <div className="inspector-section">
                    <div className="record-top">
                      <h2>GitProvider trait</h2>
                      <span className="chip chip--ok">
                        Active: provider-github
                      </span>
                    </div>
                    <p>
                      Manages pull request review queues, CI status checks,
                      local git2 branches, and squash merges.
                    </p>
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
                  </div>
                </div>
              </div>

              <div className="action-bar">
                <div className="action-group">
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={handleSaveSettings}
                  >
                    Save settings
                  </button>
                </div>
                <span className="measured" role="status">
                  {settingsStatus}
                </span>
              </div>
            </section>
          </main>
        )}
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

type DiffFile = { path: string; lines: string[]; adds: number; dels: number };

/**
 * Splits a unified diff into one entry per file (at each `diff --git` header),
 * dropping the index/---/+++ header lines. A headerless diff is one "changes" file.
 */
function splitDiffByFile(lines: string[]): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let inHeader = false;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const path = line.split(" b/").pop() ?? line;
      current = { path, lines: [], adds: 0, dels: 0 };
      files.push(current);
      inHeader = true;
      continue;
    }
    if (!current) {
      current = { path: "changes", lines: [], adds: 0, dels: 0 };
      files.push(current);
    }
    if (inHeader && !line.startsWith("@@")) {
      // rename/binary/mode notes are worth keeping; index and ---/+++ are not
      if (/^(rename|Binary|new file|deleted file|similarity)/.test(line)) current.lines.push(line);
      continue;
    }
    inHeader = false;
    current.lines.push(line);
    if (line.startsWith("+")) current.adds++;
    else if (line.startsWith("-")) current.dels++;
  }
  return files;
}

type TicketView = "assigned" | "backlog" | "active" | "all";
type PrView = "review" | "mine" | "merge" | "all";

/** One sidebar section: select it, see its count, refresh its provider. */
function NavItem(props: {
  glyph: string;
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
        <span className="nav-glyph" aria-hidden="true">
          {props.glyph}
        </span>
        <span className="nav-text">
          <span className="nav-label">{props.label}</span>
          <span className="nav-hint">{props.hint}</span>
        </span>
        {props.count !== undefined && (
          <span className="nav-count measured">{padCount(props.count)}</span>
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
          ↻
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
