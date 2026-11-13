import React, { useEffect, useRef, useState } from "react";
import {
  AgentSession,
  AgentStatus,
  agentSessions,
  agentUsage,
  openAgentFolder,
  revealAgent,
  TokenWindow,
  UsageReport,
} from "./api";
import { FilterTabs } from "./ui";

const SESSION_POLL_MS = 3_000;
const USAGE_POLL_MS = 45_000;

/** Live agent sessions (polled while the window is visible) and usage (polled while shown). */
export function useAgents(active: boolean) {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [usage, setUsage] = useState<UsageReport[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Lives here so the sidebar can open a session in the Agents view.
  const [selectedId, setSelectedId] = useState("");
  const usageAt = useRef(0);

  async function loadSessions() {
    try {
      setSessions(await agentSessions());
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }

  async function loadUsage() {
    usageAt.current = Date.now();
    try {
      setUsage(await agentUsage());
    } catch (err) {
      setError(String(err));
    }
  }

  useEffect(() => {
    void loadSessions();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void loadSessions();
    }, SESSION_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!active) return;
    if (Date.now() - usageAt.current > 15_000) void loadUsage();
    const timer = setInterval(loadUsage, USAGE_POLL_MS);
    return () => clearInterval(timer);
  }, [active]);

  async function refresh() {
    setRefreshing(true);
    await Promise.all([loadSessions(), loadUsage()]);
    setRefreshing(false);
  }

  const waiting = sessions.filter((s) => s.status === "waiting").length;
  const busy = sessions.filter((s) => s.status === "busy").length;
  return { sessions, usage, error, refreshing, refresh, waiting, busy, selectedId, setSelectedId };
}

type AgentsState = ReturnType<typeof useAgents>;
type StatusFilter = "all" | AgentStatus;
type Harness = "claude" | "antigravity";

const STATUS: Record<AgentStatus, { glyph: string; label: string; rank: number }> = {
  waiting: { glyph: "◆", label: "Needs you", rank: 0 },
  busy: { glyph: "●", label: "Working", rank: 1 },
  idle: { glyph: "○", label: "Idle", rank: 2 },
};

/** top-bar's plan presets: effective tokens per 5h window and per week. */
const PRESETS: Record<Harness, { name: string; fiveHour: number; week: number }[]> = {
  claude: [
    { name: "Pro", fiveHour: 2.5e6, week: 18e6 },
    { name: "Max 5x", fiveHour: 12.5e6, week: 90e6 },
    { name: "Max 20x", fiveHour: 50e6, week: 360e6 },
    { name: "Team / API", fiveHour: 100e6, week: 500e6 },
  ],
  antigravity: [
    { name: "Standard", fiveHour: 3e6, week: 20e6 },
    { name: "Pro", fiveHour: 8e6, week: 50e6 },
    { name: "Heavy", fiveHour: 20e6, week: 120e6 },
    { name: "Max", fiveHour: 50e6, week: 300e6 },
  ],
};
const DEFAULT_PRESET: Record<Harness, string> = { claude: "Max 5x", antigravity: "Pro" };
const PRESET_KEY = "panguyuban.agentPresets";

/** The list pane and detail pane of the Agents section (rendered inside main-stage). */
export function AgentsView(props: {
  agents: AgentsState;
  splitter: React.ReactNode;
  focusButton: React.ReactNode;
}) {
  const { sessions, usage, error, selectedId, setSelectedId } = props.agents;
  const [filter, setFilter] = useState<StatusFilter>("all");
  const now = useNow(5_000);
  const announcement = useWaitingAnnouncement(sessions);

  const sorted = [...sessions].sort(
    (a, b) => STATUS[a.status].rank - STATUS[b.status].rank || b.started_ms - a.started_ms
  );
  const visible = sorted.filter((s) => filter === "all" || s.status === filter);
  const active = visible.find((s) => s.session_id === selectedId) ?? visible[0];
  const count = (st: AgentStatus) => sessions.filter((s) => s.status === st).length;

  return (
    <>
      <section id="agent-list" className="pane pane--list" aria-label="Agent sessions">
        {props.splitter}
        <div className="visually-hidden" role="status">
          {announcement}
        </div>
        <div className="pane-header">
          <h1>Agents</h1>
          <span className="chip chip--instrument">Live · {sessions.length}</span>
        </div>

        <UsageMeters usage={usage} sessions={sessions} now={now} />

        <FilterTabs
          label="Agent status filter"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All", count: sessions.length },
            { value: "waiting", label: "Needs you", count: count("waiting") },
            { value: "busy", label: "Working", count: count("busy") },
            { value: "idle", label: "Idle", count: count("idle") },
          ]}
        />

        {error && <p className="agent-error">Could not read agents: {error}</p>}

        {visible.length === 0 ? (
          <p className="agent-empty">
            {sessions.length === 0
              ? "No agent sessions running. Start claude or Antigravity in a terminal and it shows up here."
              : "No sessions match this filter."}
          </p>
        ) : (
          <ul className="record-list" aria-label="Agent sessions">
            {visible.map((s) => (
              <li
                key={s.session_id}
                className="record-item agent-item"
                data-selected={s.session_id === active?.session_id ? "true" : "false"}
                data-status={s.status}
              >
                <button
                  type="button"
                  className="agent-row"
                  aria-current={s.session_id === active?.session_id ? "true" : undefined}
                  onClick={() => setSelectedId(s.session_id)}
                >
                  <span className="record-top">
                    <StatusPill status={s.status} since={s.status_since_ms} now={now} />
                    <span className={`harness-tag harness-tag--${s.harness}`}>
                      {s.harness === "claude" ? "claude" : "agy"}
                    </span>
                  </span>
                  <span className="record-title">{s.name}</span>
                  <span className="agent-meta measured">
                    {[`↑${compact(s.input_tokens)} ↓${compact(s.output_tokens)}`, shortModel(s.model), shortPath(s.cwd)]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {s.subagents.length > 0 && (
                    <span className="agent-subs">
                      {s.subagents.map((a) => (
                        <span key={a.id} className="agent-sub" data-finished={a.finished || undefined}>
                          <span aria-hidden="true">└ {a.finished ? "✓" : "●"}</span>
                          <span className="agent-sub-desc">{a.description}</span>
                          <span className="measured">
                            {duration((a.finished ? a.last_active_ms : now) - a.started_ms)}
                          </span>
                          <span className="visually-hidden">{a.finished ? "finished" : "running"}</span>
                        </span>
                      ))}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="pane pane--detail" aria-label="Selected agent session">
        {active ? (
          <AgentDetail session={active} now={now} focusButton={props.focusButton} />
        ) : (
          <div className="pane-header">
            <h2>No session selected</h2>
            <div className="pane-tools">{props.focusButton}</div>
          </div>
        )}
      </section>
    </>
  );
}

/** Sidebar "Agents" section: sessions grouped by status; click opens one in the Agents view. */
export function SidebarAgents({ agents, onOpen }: { agents: AgentsState; onOpen: (sessionId: string) => void }) {
  const now = useNow(5_000);
  const groups = (["waiting", "busy", "idle"] as const)
    .map((status) => ({
      status,
      sessions: agents.sessions.filter((s) => s.status === status).sort((a, b) => b.started_ms - a.started_ms),
    }))
    .filter((g) => g.sessions.length > 0);

  return (
    <nav className="nav-card sidebar-agents" aria-label="Agents">
      <div className="sidebar-agents-head">
        <span className="sidebar-title">Agents</span>
        <button
          type="button"
          className="refresh-btn"
          aria-label="Refresh agents"
          title="Refresh agents"
          disabled={agents.refreshing}
          data-spinning={agents.refreshing || undefined}
          onClick={agents.refresh}
        >
          ↻
        </button>
      </div>
      {groups.length === 0 && <p className="nav-hint sidebar-agents-empty">No agents running</p>}
      {groups.map((g) => (
        <div key={g.status} className="sidebar-agents-group" data-status={g.status}>
          <span className="sidebar-agents-label">
            {STATUS[g.status].label} <span className="measured">{g.sessions.length}</span>
          </span>
          {g.sessions.map((s) => (
            <div key={s.session_id} className="nav-item sidebar-agent" data-status={s.status}>
              <button type="button" className="nav-item-main" title={s.cwd} onClick={() => onOpen(s.session_id)}>
                <span className="nav-glyph" aria-hidden="true">
                  ✦
                </span>
                <span className="nav-label">{s.name}</span>
                <span className="measured">{duration(now - s.status_since_ms)}</span>
                <span className="status-glyph" aria-hidden="true">
                  {STATUS[s.status].glyph}
                </span>
              </button>
            </div>
          ))}
        </div>
      ))}
    </nav>
  );
}

function AgentDetail({
  session: s,
  now,
  focusButton,
}: {
  session: AgentSession;
  now: number;
  focusButton: React.ReactNode;
}) {
  const [note, setNote] = useState("");
  const resume = `cd ${quote(s.cwd)} && claude --resume ${s.session_id}`;

  async function run(label: string, action: () => Promise<void>) {
    try {
      await action();
      setNote(label);
    } catch (err) {
      setNote(String(err));
    }
  }

  return (
    <>
      <div className="pane-header">
        <div>
          <span className="measured-ink">
            {s.harness === "claude" ? "Claude Code" : "Antigravity"} · pid {s.pid}
          </span>
          <h2>{s.name}</h2>
        </div>
        <div className="pane-tools">
          <StatusPill status={s.status} since={s.status_since_ms} now={now} />
          {focusButton}
        </div>
      </div>

      <div className="reading-row" aria-label="Session readings">
        <div className="reading-cell">
          <span className="reading-label">Running for</span>
          <span className="reading-value">{duration(now - s.started_ms)}</span>
        </div>
        <div className="reading-cell">
          <span className="reading-label">Tokens in / out</span>
          <span className="reading-value">
            {compact(s.input_tokens)} / {compact(s.output_tokens)}
          </span>
        </div>
        <div className="reading-cell">
          <span className="reading-label">Model</span>
          <span className="reading-value">{shortModel(s.model) || "—"}</span>
        </div>
      </div>

      <dl className="agent-facts">
        <dt>Folder</dt>
        <dd className="measured">{s.cwd}</dd>
        <dt>Session</dt>
        <dd className="measured">{s.session_id}</dd>
        <dt>Started</dt>
        <dd>{new Date(s.started_ms).toLocaleString()}</dd>
      </dl>

      <div className="inspector-card">
        <div className="inspector-section">
          <h3>Subagents</h3>
          {s.subagents.length === 0 ? (
            <p className="agent-empty">No subagents running or finished in the last 5 minutes.</p>
          ) : (
            <ul className="agent-sub-table">
              {s.subagents.map((a) => (
                <li key={a.id} data-finished={a.finished || undefined}>
                  <span className="agent-sub-state">{a.finished ? "✓ Done" : "● Running"}</span>
                  <span className="agent-sub-desc" title={`${a.agent_type}: ${a.description}`}>
                    {a.description}
                    <span className="nav-hint"> {a.agent_type}</span>
                  </span>
                  <span className="measured">
                    {duration((a.finished ? a.last_active_ms : now) - a.started_ms)}
                  </span>
                  <span className="measured">
                    ↑{compact(a.input_tokens)} ↓{compact(a.output_tokens)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="action-bar">
        <div className="action-group">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => run("Opened terminal", () => revealAgent(s.pid, s.cwd))}
          >
            Jump to terminal
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => run("Opened folder", () => openAgentFolder(s.cwd))}
          >
            Open folder
          </button>
          {s.harness === "claude" && (
            <button
              type="button"
              className="btn"
              onClick={() => run("Copied resume command", () => navigator.clipboard.writeText(resume))}
            >
              Copy resume command
            </button>
          )}
        </div>
        <span className="measured" role="status">
          {note}
        </span>
      </div>
    </>
  );
}

function StatusPill({ status, since, now }: { status: AgentStatus; since: number; now: number }) {
  const st = STATUS[status];
  return (
    <span className={`status-pill status-pill--${status}`}>
      <span className="status-glyph" aria-hidden="true">
        {st.glyph}
      </span>
      {st.label}
      <span className="measured"> {duration(now - since)}</span>
    </span>
  );
}

/** 5h and weekly meters against a plan preset (top-bar's limits card). */
function UsageMeters({
  usage,
  sessions,
  now,
}: {
  usage: UsageReport[];
  sessions: AgentSession[];
  now: number;
}) {
  const [harness, setHarness] = useState<Harness>("claude");
  const [presets, setPresets] = useState<Record<Harness, string>>(() => {
    try {
      return { ...DEFAULT_PRESET, ...JSON.parse(localStorage.getItem(PRESET_KEY) ?? "{}") };
    } catch {
      return DEFAULT_PRESET;
    }
  });
  const report = usage.find((u) => u.harness === harness);
  const preset = PRESETS[harness].find((p) => p.name === presets[harness]) ?? PRESETS[harness][0];

  function choosePreset(name: string) {
    const next = { ...presets, [harness]: name };
    setPresets(next);
    try {
      localStorage.setItem(PRESET_KEY, JSON.stringify(next));
    } catch {
      // storage unavailable: preset resets next launch
    }
  }

  return (
    <div className="usage-card" aria-label="Agent usage limits">
      <div className="usage-head">
        <FilterTabs
          label="Usage harness"
          value={harness}
          onChange={setHarness}
          options={[
            { value: "claude", label: "Claude", count: sessions.filter((x) => x.harness === "claude").length },
            { value: "antigravity", label: "Antigravity", count: sessions.filter((x) => x.harness === "antigravity").length },
          ]}
        />
        <label className="usage-preset">
          <span className="visually-hidden">Plan</span>
          <select value={preset.name} onChange={(e) => choosePreset(e.target.value)}>
            {PRESETS[harness].map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {report ? (
        <>
          <Meter label="5-hour window" window={report.five_hour} limit={preset.fiveHour} resetAfterMs={5 * 3600e3} now={now} />
          <Meter label="Week" window={report.week} limit={preset.week} resetAfterMs={7 * 24 * 3600e3} now={now} />
          <p className="usage-today measured">
            Today {compact(report.today.effective)} · ↑{compact(report.today.input + report.today.cache_write)} ↓
            {compact(report.today.output)} · cache {compact(report.today.cache_read)}
          </p>
        </>
      ) : (
        <p className="agent-empty">Loading usage…</p>
      )}
    </div>
  );
}

function Meter(props: { label: string; window: TokenWindow; limit: number; resetAfterMs: number; now: number }) {
  const pct = Math.min(100, Math.round((props.window.effective / props.limit) * 100));
  const level = pct >= 90 ? "high" : pct >= 70 ? "mid" : "low";
  const resetIn = props.window.oldest_ms ? props.window.oldest_ms + props.resetAfterMs - props.now : null;
  return (
    <div className="meter">
      <div className="meter-label">
        <span>
          {props.label}
          {resetIn !== null && resetIn > 0 && <span className="nav-hint"> · resets in {duration(resetIn)}</span>}
        </span>
        <span className="measured">{pct}%</span>
      </div>
      <div
        className="meter-track"
        role="meter"
        aria-label={`${props.label} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`${pct}% · ${compact(props.window.effective)} of ${compact(props.limit)}`}
      >
        <span className="meter-fill" data-level={level} style={{ width: `${Math.max(pct, 1)}%` }} />
      </div>
      <span className="meter-sub measured">
        {compact(props.window.effective)} / {compact(props.limit)}
      </span>
    </div>
  );
}

/** Text for the hidden live region: only "now waiting for you" transitions, never ticking numbers. */
function useWaitingAnnouncement(sessions: AgentSession[]): string {
  const previous = useRef<Map<string, AgentStatus>>(new Map());
  const [message, setMessage] = useState("");
  useEffect(() => {
    const newlyWaiting = sessions.filter(
      (s) => s.status === "waiting" && previous.current.has(s.session_id) && previous.current.get(s.session_id) !== "waiting"
    );
    if (newlyWaiting.length) setMessage(newlyWaiting.map((s) => `${s.name} needs you`).join(". "));
    previous.current = new Map(sessions.map((s) => [s.session_id, s.status]));
  }, [sessions]);
  return message;
}

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

export function duration(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function shortPath(cwd: string): string {
  return cwd.replace(/^\/Users\/[^/]+/, "~");
}

/** "claude-opus-5-5" -> "opus-5-5". */
function shortModel(model: string | null): string {
  return model ? model.replace(/^claude-/, "") : "";
}

function quote(path: string): string {
  return /^[\w./~-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}
