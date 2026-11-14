import React, { useEffect, useRef, useState } from "react";
import {
  AgentSession,
  AgentStatus,
  agentSessions,
  agentUsage,
  killAgent,
  openAgentFolder,
  revealAgent,
  TokenWindow,
  UsageReport,
} from "./api";
import { FilterTabs, Icon } from "./ui";

const SESSION_POLL_MS = 3_000;
const USAGE_POLL_MS = 45_000;

/** Live agent sessions (polled while the window is visible) and usage (polled while shown). */
export function useAgents(active: boolean, enabled = true) {
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
    if (!enabled) {
      setSessions([]);
      return;
    }
    void loadSessions();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void loadSessions();
    }, SESSION_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled]);

  useEffect(() => {
    if (!active || !enabled) return;
    if (Date.now() - usageAt.current > 15_000) void loadUsage();
    const timer = setInterval(loadUsage, USAGE_POLL_MS);
    return () => clearInterval(timer);
  }, [active, enabled]);

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
  /** Opens a handoff of this folder; absent when the Memory feature is off. */
  onHandOff?: (cwd: string, name: string) => void;
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
  const groups = (["waiting", "busy", "idle"] as const)
    .map((status) => ({ status, items: visible.filter((s) => s.status === status) }))
    .filter((g) => g.items.length > 0);
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
          <span className="measured">{sessions.length}</span>
        </div>

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
          groups.map((group) => (
            <section key={group.status} className="ticket-group" aria-label={`${STATUS[group.status].label} sessions`}>
              <div className="ticket-group-head">
                <h2>{STATUS[group.status].label}</h2>
                <span className="measured">{group.items.length}</span>
              </div>
              <ul className="ticket-rows">
                {group.items.map((s) => {
                  const selected = s.session_id === active?.session_id;
                  const running = s.subagents.filter((a) => !a.finished).length;
                  return (
                    <li key={s.session_id}>
                      <button
                        type="button"
                        className="ticket-row"
                        data-selected={selected ? "true" : "false"}
                        aria-current={selected ? "true" : undefined}
                        onClick={() => setSelectedId(s.session_id)}
                      >
                        <span className="ticket-row-top">
                          <span className="agents-name">{s.name}</span>
                          <span className="agents-since" data-status={s.status}>
                            {duration(now - s.status_since_ms)}
                          </span>
                        </span>
                        <span className="agents-meta">
                          <span>{s.harness === "claude" ? "Claude" : "Antigravity"}</span>
                          {shortModel(s.model) && <span>{shortModel(s.model)}</span>}
                          <span className="agents-meta-path">{shortPath(s.cwd)}</span>
                        </span>
                        {running > 0 && (
                          <span className="agents-running">
                            {running} {running === 1 ? "subagent" : "subagents"} running
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}

        <UsageMeters usage={usage} sessions={sessions} now={now} />
      </section>

      <section className="pane pane--detail ticket-detail" aria-label="Selected agent session">
        {active ? (
          <AgentDetail key={active.session_id} session={active} now={now} focusButton={props.focusButton} onEnded={props.agents.refresh} onHandOff={props.onHandOff} />
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
          <Icon name="refresh" size={14} />
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
                <span className="nav-glyph">
                  <Icon name="agents" />
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
  onEnded,
  onHandOff,
}: {
  session: AgentSession;
  now: number;
  focusButton: React.ReactNode;
  onEnded: () => void;
  onHandOff?: (cwd: string, name: string) => void;
}) {
  const [note, setNote] = useState("");
  // Ending a session cannot be undone, so it takes a second click.
  const [confirmEnd, setConfirmEnd] = useState(false);
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
      <div className="agents-band" data-status={s.status}>
        <p className="agents-band-status">
          <span className="agents-band-label">{STATUS[s.status].label}</span>
          <span className="agents-band-for">for {duration(now - s.status_since_ms)}</span>
        </p>
        <div className="agents-band-actions">
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
          {onHandOff && (
            <button type="button" className="btn" onClick={() => onHandOff(s.cwd, s.name)}>
              Hand off
            </button>
          )}
          {s.harness === "claude" && (
            <button
              type="button"
              className="btn"
              onClick={() => run("Copied resume command", () => navigator.clipboard.writeText(resume))}
            >
              Copy resume command
            </button>
          )}
          {confirmEnd ? (
            <>
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => {
                  setConfirmEnd(false);
                  run("Session ended", () => killAgent(s.pid).then(onEnded));
                }}
              >
                Confirm: end {s.name}
              </button>
              <button type="button" className="btn" onClick={() => setConfirmEnd(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" className="btn" onClick={() => setConfirmEnd(true)}>
              End session
            </button>
          )}
        </div>
      </div>
      <span className="measured" role="status">
        {note}
      </span>

      <div className="ticket-head">
        <span className="measured-ink">{shortPath(s.cwd)}</span>
        <div className="pane-tools">{focusButton}</div>
      </div>
      <h2 className="ticket-title">{s.name}</h2>

      <dl className="agents-facts" aria-label="Session facts">
        <div>
          <dt>Harness</dt>
          <dd>{s.harness === "claude" ? "Claude Code" : "Antigravity"}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>{shortModel(s.model) || "Unknown"}</dd>
        </div>
        <div>
          <dt>Running for</dt>
          <dd>{duration(now - s.started_ms)}</dd>
        </div>
        <div>
          <dt>Tokens in</dt>
          <dd>{compact(s.input_tokens)}</dd>
        </div>
        <div>
          <dt>Tokens out</dt>
          <dd>{compact(s.output_tokens)}</dd>
        </div>
        <div>
          <dt>Session id</dt>
          <dd className="agents-mono">{s.session_id}</dd>
        </div>
        <div className="agents-facts-wide">
          <dt>Folder</dt>
          <dd className="agents-mono">{s.cwd}</dd>
        </div>
      </dl>

      <section className="agents-subs" aria-label="Subagents">
        <h3>Subagents</h3>
        {s.subagents.length === 0 ? (
          <p className="agent-empty">No subagents running or finished in the last 5 minutes.</p>
        ) : (
          <ul>
            {s.subagents.map((a) => (
              <li key={a.id} data-finished={a.finished || undefined}>
                <span className="agents-sub-state">{a.finished ? "Done" : "Running"}</span>
                <span className="agents-sub-desc" title={`${a.agent_type}: ${a.description}`}>
                  {a.description}
                </span>
                <span className="agents-sub-type">{a.agent_type}</span>
                <span className="measured">{duration((a.finished ? a.last_active_ms : now) - a.started_ms)}</span>
                <span className="measured">
                  in {compact(a.input_tokens)}, out {compact(a.output_tokens)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
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
          <dl className="usage-today">
            <div>
              <dt>Today</dt>
              <dd>{compact(report.today.effective)}</dd>
            </div>
            <div>
              <dt>In</dt>
              <dd>{compact(report.today.input + report.today.cache_write)}</dd>
            </div>
            <div>
              <dt>Out</dt>
              <dd>{compact(report.today.output)}</dd>
            </div>
            <div>
              <dt>Cache read</dt>
              <dd>{compact(report.today.cache_read)}</dd>
            </div>
          </dl>
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
        <span>{props.label}</span>
        {resetIn !== null && resetIn > 0 && <span className="meter-reset">resets in {duration(resetIn)}</span>}
        <span className="measured">{pct}%</span>
      </div>
      <div
        className="meter-track"
        role="meter"
        aria-label={`${props.label} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`${pct}% used, ${compact(props.window.effective)} of ${compact(props.limit)}`}
      >
        <span className="meter-fill" data-level={level} style={{ transform: `scaleX(${pct / 100})` }} />
      </div>
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
