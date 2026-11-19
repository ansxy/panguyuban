import React, { useEffect, useRef, useState } from "react";
import { type AgentSession, SpaceStatus, spaceStatus, type TermInfo } from "./api";
import { shortModel, STATUS } from "./Agents";
import { maxId, parseSaved, snapshot } from "./spaces_saved";
import { TerminalView } from "./Terminal";

/** A tab's panes: a leaf is one terminal (started in `cwd`), a split divides its box (`ratio` to `a`, half by default). */
export type PaneLeaf = { pane: string; cwd: string; run?: string };
export type PaneSplit = { dir: "row" | "col"; a: PaneNode; b: PaneNode; ratio?: number };
export type PaneNode = PaneLeaf | PaneSplit;
export type TermTab = { id: string; root: PaneNode; focused: string };
/** A space is a set of terminal tabs, named after the folder its focused terminal is in. */
export type Space = { id: string; tabs: TermTab[]; activeTab: string };

const STATUS_POLL_MS = 5_000;
const HOME = "~";
const SAVED_KEY = "panguyuban.spaces";
// After launch, resumed agents take a few seconds to start and be seen; until then the
// saved layout (with their resume commands) is left as it was.
const RESTORE_GRACE_MS = 8_000;

let seq = 0;
const newId = () => `t${++seq}`;

function newTab(cwd: string, run?: string): TermTab {
  const pane = newId();
  return { id: newId(), root: { pane, cwd, run }, focused: pane };
}

function newSpace(): Space {
  const tab = newTab(HOME);
  return { id: newId(), tabs: [tab], activeTab: tab.id };
}

export function spaceName(cwd: string): string {
  return cwd === HOME ? HOME : (cwd.split("/").filter(Boolean).pop() ?? cwd);
}

/** Replaces pane `id` with what `f` returns; null removes it and its split collapses. */
function mapPane(node: PaneNode, id: string, f: (leaf: PaneLeaf) => PaneNode | null): PaneNode | null {
  if ("pane" in node) return node.pane === id ? f(node) : node;
  const a = mapPane(node.a, id, f);
  const b = mapPane(node.b, id, f);
  if (!a || !b) return a ?? b;
  return { ...node, a, b };
}

function firstPane(node: PaneNode): string {
  return "pane" in node ? node.pane : firstPane(node.a);
}

type Rect = { x: number; y: number; w: number; h: number };

const MIN_RATIO = 0.15;
const clampRatio = (ratio: number) => Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, ratio));

function halves(node: PaneSplit, r: Rect): [Rect, Rect] {
  const k = node.ratio ?? 0.5;
  return node.dir === "row"
    ? [{ ...r, w: r.w * k }, { ...r, x: r.x + r.w * k, w: r.w * (1 - k) }]
    : [{ ...r, h: r.h * k }, { ...r, y: r.y + r.h * k, h: r.h * (1 - k) }];
}

/** Each pane's box in percent of the tab. */
function layoutPanes(node: PaneNode, r: Rect = { x: 0, y: 0, w: 100, h: 100 }): [PaneLeaf, Rect][] {
  if ("pane" in node) return [[node, r]];
  const [first, second] = halves(node, r);
  return [...layoutPanes(node.a, first), ...layoutPanes(node.b, second)];
}

/** Each split's box, keyed by its path from the root ("", "a", "ab", …), for the drag handles. */
function layoutSplits(node: PaneNode, r: Rect = { x: 0, y: 0, w: 100, h: 100 }, path = ""): [string, PaneSplit, Rect][] {
  if ("pane" in node) return [];
  const [first, second] = halves(node, r);
  return [[path, node, r], ...layoutSplits(node.a, first, path + "a"), ...layoutSplits(node.b, second, path + "b")];
}

/** Replaces the split at `path` with what `f` returns. */
function mapSplit(node: PaneNode, path: string, f: (split: PaneSplit) => PaneSplit): PaneNode {
  if ("pane" in node) return node;
  if (!path) return f(node);
  return path[0] === "a"
    ? { ...node, a: mapSplit(node.a, path.slice(1), f) }
    : { ...node, b: mapSplit(node.b, path.slice(1), f) };
}

function currentTabOf(space: Space | undefined): TermTab | undefined {
  return space?.tabs.find((t) => t.id === space.activeTab) ?? space?.tabs.at(-1);
}

function paneIds(node: PaneNode): string[] {
  return "pane" in node ? [node.pane] : [...paneIds(node.a), ...paneIds(node.b)];
}

function findLeaf(node: PaneNode, id: string): PaneLeaf | undefined {
  if ("pane" in node) return node.pane === id ? node : undefined;
  return findLeaf(node.a, id) ?? findLeaf(node.b, id);
}

/** Last launch's spaces, with new ids continuing after the saved ones. */
function restoreSpaces() {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(SAVED_KEY);
  } catch {
    // storage unavailable: start with one fresh space
  }
  const saved = parseSaved(raw);
  if (saved) seq = Math.max(seq, maxId(saved));
  return saved;
}

/**
 * Spaces and their terminal tabs. Shells end with the app, but the layout is saved:
 * the next launch reopens each pane in its folder, and resumes an agent that ran in it.
 */
export function useSpaces(sessions: AgentSession[]) {
  const [restored] = useState(restoreSpaces);
  const [list, setList] = useState<Space[]>(() => restored?.spaces ?? [newSpace()]);
  const [activeId, setActiveId] = useState(restored?.activeId ?? "");
  // pane id -> the folder its shell is in now (`~`-relative), reported by each pane.
  const [paneCwd, setPaneCwd] = useState<Record<string, string>>({});
  // pane id -> its foreground process group, to find the agent running in it.
  const [paneGroup, setPaneGroup] = useState<Record<string, number>>({});
  const [status, setStatus] = useState<Record<string, SpaceStatus>>({});
  const launchedAt = useRef(Date.now());

  const active = list.find((s) => s.id === activeId) ?? list[0];
  const currentTab = currentTabOf(active);
  const cwdOf = (space: Space | undefined): string => {
    const tab = currentTabOf(space);
    if (!tab) return HOME;
    // Until a pane reports, the folder it was opened in.
    return paneCwd[tab.focused] ?? findLeaf(tab.root, tab.focused)?.cwd ?? HOME;
  };

  // Saved shortly after each change, so quitting at any moment keeps the last state.
  useEffect(() => {
    const wait = Math.max(500, RESTORE_GRACE_MS - (Date.now() - launchedAt.current));
    const timer = setTimeout(() => {
      try {
        const saved = snapshot(list, active?.id ?? "", { cwd: paneCwd, group: paneGroup }, sessions);
        localStorage.setItem(SAVED_KEY, JSON.stringify(saved));
      } catch {
        // storage unavailable: this launch's layout is not kept
      }
    }, wait);
    return () => clearTimeout(timer);
  }, [list, active?.id, paneCwd, paneGroup, sessions]);

  const cwds = [...new Set(list.map(cwdOf))];
  useEffect(() => {
    const poll = () =>
      spaceStatus(cwds)
        .then((all) => setStatus(Object.fromEntries(all.map((s) => [s.path, s]))))
        .catch(() => {});
    poll();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") poll();
    }, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [cwds.join("\n")]);

  /** Applies `f` to one space; a space left with no tabs is removed. */
  function updateSpace(id: string, f: (space: Space) => Space): void {
    setList((all) => all.flatMap((s) => (s.id === id ? [f(s)] : [s])).filter((s) => s.tabs.length > 0));
  }

  function updateTab(spaceId: string, tabId: string, f: (tab: TermTab) => TermTab | null): void {
    updateSpace(spaceId, (s) => ({
      ...s,
      tabs: s.tabs.flatMap((t) => (t.id === tabId ? (f(t) ?? []) : [t])),
    }));
  }

  function add(): void {
    const space = newSpace();
    setList((all) => [...all, space]);
    setActiveId(space.id);
  }

  /** New tab in the active space, in the folder its focused terminal is in. */
  function openTab(): void {
    if (!active) return add();
    const tab = newTab(cwdOf(active));
    updateSpace(active.id, (s) => ({ ...s, tabs: [...s.tabs, tab], activeTab: tab.id }));
  }

  /** Shows the space already in `cwd`, or opens a new one there. */
  function openAt(cwd: string): void {
    const existing = list.find((s) => cwdOf(s) === cwd);
    if (existing) return setActiveId(existing.id);
    const tab = newTab(cwd);
    const space = { id: newId(), tabs: [tab], activeTab: tab.id };
    setList((all) => [...all, space]);
    setActiveId(space.id);
  }

  /** Runs `command` in a new tab of the space already in `cwd`, or of a new space there. */
  function runIn(cwd: string, command: string): void {
    const tab = newTab(cwd, command);
    const existing = list.find((s) => cwdOf(s) === cwd);
    if (existing) {
      updateSpace(existing.id, (s) => ({ ...s, tabs: [...s.tabs, tab], activeTab: tab.id }));
      return setActiveId(existing.id);
    }
    const space = { id: newId(), tabs: [tab], activeTab: tab.id };
    setList((all) => [...all, space]);
    setActiveId(space.id);
  }

  function split(spaceId: string, tabId: string, paneId: string, dir: "row" | "col"): void {
    const pane = newId();
    const cwd = paneCwd[paneId] ?? HOME;
    updateTab(spaceId, tabId, (t) => ({
      ...t,
      root: mapPane(t.root, paneId, (leaf) => ({ dir, a: leaf, b: { pane, cwd } }))!,
      focused: pane,
    }));
  }

  /** Moves the divider of the split at `path`; `ratio` is the first side's share. */
  function resizeSplit(spaceId: string, tabId: string, path: string, ratio: number): void {
    updateTab(spaceId, tabId, (t) => ({ ...t, root: mapSplit(t.root, path, (s) => ({ ...s, ratio: clampRatio(ratio) })) }));
  }

  function closePane(spaceId: string, tabId: string, paneId: string): void {
    updateTab(spaceId, tabId, (t) => {
      const root = mapPane(t.root, paneId, () => null);
      if (!root) return null;
      return { ...t, root, focused: t.focused === paneId ? firstPane(root) : t.focused };
    });
  }

  /** Agents running in this space's panes, matched by the pane's foreground process group. */
  function agentsOf(space: Space): { session: AgentSession; tabId: string; pane: string }[] {
    return space.tabs.flatMap((t) =>
      paneIds(t.root).flatMap((pane) => {
        const session = sessions.find((s) => s.pgid > 0 && s.pgid === paneGroup[pane]);
        return session ? [{ session, tabId: t.id, pane }] : [];
      }),
    );
  }

  /** Makes `pane` the focused terminal of its tab, that tab current, and its space active. */
  function showPane(spaceId: string, tabId: string, pane: string): void {
    updateSpace(spaceId, (s) => ({
      ...s,
      activeTab: tabId,
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, focused: pane } : t)),
    }));
    setActiveId(spaceId);
  }

  return {
    resizeSplit,
    agentsOf,
    showPane,
    list,
    active,
    currentTab,
    cwdOf,
    status,
    add,
    select: setActiveId,
    remove: (id: string) => setList((all) => all.filter((s) => s.id !== id)),
    openTab,
    openAt,
    runIn,
    selectTab: (tabId: string) => active && updateSpace(active.id, (s) => ({ ...s, activeTab: tabId })),
    closeTab: (tabId: string) => active && updateTab(active.id, tabId, () => null),
    split,
    splitFocused: (dir: "row" | "col") => active && currentTab && split(active.id, currentTab.id, currentTab.focused, dir),
    closePane,
    /** Closes the focused terminal of the current tab; the last one takes its tab with it. */
    closeFocused: () => active && currentTab && closePane(active.id, currentTab.id, currentTab.focused),
    focusPane: (spaceId: string, tabId: string, paneId: string) =>
      updateTab(spaceId, tabId, (t) => (t.focused === paneId ? t : { ...t, focused: paneId })),
    reportInfo: (paneId: string, info: TermInfo) => {
      setPaneCwd((all) => (all[paneId] === info.cwd ? all : { ...all, [paneId]: info.cwd }));
      setPaneGroup((all) => (all[paneId] === info.pgid ? all : { ...all, [paneId]: info.pgid }));
    },
  };
}

export type SpacesState = ReturnType<typeof useSpaces>;

/** Sidebar list of spaces: monogram badge, folder name, branch, and compact agent rows. */
export function SidebarSpaces(props: { spaces: SpacesState; onOpen: (id: string) => void }) {
  const { spaces } = props;
  return (
    <nav className="nav-card nav-card--spaces" aria-label="Spaces">
      <div className="nav-group-head">
        <span className="sidebar-title">Spaces</span>
        <button type="button" className="refresh-btn" aria-label="New space" title="New space" onClick={spaces.add}>
          +
        </button>
      </div>
      {spaces.list.map((space) => {
        const cwd = spaces.cwdOf(space);
        const name = spaceName(cwd);
        const s = spaces.status[cwd];
        const current = space.id === spaces.active?.id;
        const agents = [...spaces.agentsOf(space)].sort(
          (a, b) => STATUS[a.session.status].rank - STATUS[b.session.status].rank
        );
        const waiting = agents.some((a) => a.session.status === "waiting");
        return (
          <div key={space.id} className="space-group">
            <div
              className="nav-item space-item"
              data-current={current || undefined}
              data-attention={waiting || undefined}
            >
              <button
                type="button"
                className="nav-item-main"
                aria-current={current ? "page" : undefined}
                title={cwd}
                onClick={() => props.onOpen(space.id)}
              >
                <span className="nav-glyph space-badge" aria-hidden="true">
                  {name.replace(/^[^a-z0-9]+/i, "")[0]?.toUpperCase() ?? "~"}
                </span>
                <span className="nav-text">
                  <span className="nav-label">{name}</span>
                  {s?.branch && (
                    <span className="nav-hint space-branch">
                      {s.ahead > 0 && `↑${s.ahead} `}
                      {s.behind > 0 && `↓${s.behind} `}
                      {s.branch}
                    </span>
                  )}
                </span>
              </button>
              <button
                type="button"
                className="refresh-btn space-remove"
                aria-label={`Close space ${name}`}
                title="Close space (ends its terminals)"
                onClick={() => spaces.remove(space.id)}
              >
                ×
              </button>
            </div>
            {agents.length > 0 && (
              <div className="space-agents">
                {agents.map(({ session: a, tabId, pane }) => {
                  const model = shortModel(a.model);
                  return (
                    <button
                      key={pane}
                      type="button"
                      className="space-agent"
                      data-status={a.status}
                      title={`${a.name}${model ? ` (${model})` : ""} — ${STATUS[a.status].label} — ${a.cwd}`}
                      onClick={() => {
                        spaces.showPane(space.id, tabId, pane);
                        props.onOpen(space.id);
                      }}
                    >
                      <span className="status-glyph" aria-label={STATUS[a.status].label}>
                        {STATUS[a.status].glyph}
                      </span>
                      <span className="space-agent-name">{a.name}</span>
                      {model && <span className="space-agent-model">{model}</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

/**
 * Every space's terminal tabs. All stay mounted (hidden when not shown) so shells
 * survive switching tabs, spaces and views. Panes are a flat keyed list placed
 * by percent, so splitting never remounts (and kills) an existing shell.
 */
export function TerminalStages(props: { spaces: SpacesState; shown: boolean }) {
  const { spaces } = props;
  return (
    <>
      {spaces.list.flatMap((space) =>
        space.tabs.map((tab) => {
          const visible = props.shown && space.id === spaces.active?.id && tab.id === spaces.currentTab?.id;
          const panes = layoutPanes(tab.root).sort(([a], [b]) => a.pane.localeCompare(b.pane));
          return (
            <main key={tab.id} className="main-stage term-stage" hidden={!visible}>
              {panes.map(([leaf, r]) => (
                <div
                  key={leaf.pane}
                  className="term-slot"
                  style={{ left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` }}
                >
                  <TerminalView
                    cwd={leaf.cwd}
                    run={leaf.run}
                    focused={visible && tab.focused === leaf.pane}
                    onFocus={() => spaces.focusPane(space.id, tab.id, leaf.pane)}
                    onInfo={(info) => spaces.reportInfo(leaf.pane, info)}
                    onSplit={(dir) => spaces.split(space.id, tab.id, leaf.pane, dir)}
                    onClose={() => spaces.closePane(space.id, tab.id, leaf.pane)}
                  />
                </div>
              ))}
              {layoutSplits(tab.root).map(([path, split, r]) => (
                <PaneDivider
                  key={path}
                  split={split}
                  box={r}
                  onResize={(ratio) => spaces.resizeSplit(space.id, tab.id, path, ratio)}
                />
              ))}
            </main>
          );
        })
      )}
    </>
  );
}

/** Drag handle on a split's edge. Arrow keys move it 5%, double-click puts it back to the middle. */
function PaneDivider(props: { split: PaneSplit; box: Rect; onResize: (ratio: number) => void }) {
  const { split, box } = props;
  const row = split.dir === "row";
  const ratio = split.ratio ?? 0.5;
  const at = row
    ? { left: `${box.x + box.w * ratio}%`, top: `${box.y}%`, height: `${box.h}%` }
    : { top: `${box.y + box.h * ratio}%`, left: `${box.x}%`, width: `${box.w}%` };

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const stage = e.currentTarget.parentElement?.getBoundingClientRect();
    if (!stage) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    document.documentElement.dataset.resizing = row ? "col" : "row";
    const move = (ev: PointerEvent) => {
      const pct = row
        ? ((ev.clientX - stage.left) / stage.width) * 100
        : ((ev.clientY - stage.top) / stage.height) * 100;
      props.onResize(row ? (pct - box.x) / box.w : (pct - box.y) / box.h);
    };
    const target = e.currentTarget;
    const up = () => {
      delete document.documentElement.dataset.resizing;
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const back = row ? "ArrowLeft" : "ArrowUp";
    const forward = row ? "ArrowRight" : "ArrowDown";
    if (e.key !== back && e.key !== forward) return;
    e.preventDefault();
    props.onResize(ratio + (e.key === forward ? 0.05 : -0.05));
  }

  return (
    <div
      className="term-divider"
      data-dir={split.dir}
      style={at}
      role="separator"
      tabIndex={0}
      aria-label="Resize terminals"
      aria-orientation={row ? "vertical" : "horizontal"}
      aria-valuemin={Math.round(MIN_RATIO * 100)}
      aria-valuemax={Math.round((1 - MIN_RATIO) * 100)}
      aria-valuenow={Math.round(ratio * 100)}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      onDoubleClick={() => props.onResize(0.5)}
    />
  );
}
