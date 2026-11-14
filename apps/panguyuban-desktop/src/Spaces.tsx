import React, { useEffect, useState } from "react";
import { SpaceStatus, spaceStatus } from "./api";
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

/** Spaces and their terminal tabs, for this launch only (shells don't outlive the app). */
export function useSpaces() {
  const [list, setList] = useState<Space[]>(() => [newSpace()]);
  const [activeId, setActiveId] = useState("");
  // pane id -> the folder its shell is in now (`~`-relative), reported by each pane.
  const [paneCwd, setPaneCwd] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Record<string, SpaceStatus>>({});

  const active = list.find((s) => s.id === activeId) ?? list[0];
  const currentTab = currentTabOf(active);
  const cwdOf = (space: Space | undefined): string => {
    const tab = currentTabOf(space);
    return (tab && paneCwd[tab.focused]) ?? HOME;
  };

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

  return {
    resizeSplit,
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
    reportCwd: (paneId: string, cwd: string) =>
      setPaneCwd((all) => (all[paneId] === cwd ? all : { ...all, [paneId]: cwd })),
  };
}

export type SpacesState = ReturnType<typeof useSpaces>;

function badgeHue(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

/** Sidebar list of spaces: letter badge, folder name, branch, ahead/behind. */
export function SidebarSpaces(props: { spaces: SpacesState; onOpen: (id: string) => void }) {
  const { spaces } = props;
  return (
    <nav className="nav-card" aria-label="Spaces">
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
        return (
          <div key={space.id} className="nav-item space-item" data-current={current || undefined}>
            <button
              type="button"
              className="nav-item-main"
              aria-current={current ? "page" : undefined}
              title={cwd}
              onClick={() => props.onOpen(space.id)}
            >
              <span
                className="nav-glyph space-badge"
                aria-hidden="true"
                style={{ "--badge-hue": badgeHue(name) } as React.CSSProperties}
              >
                {name.replace(/^[^a-z0-9]+/i, "")[0]?.toUpperCase() ?? "~"}
              </span>
              <span className="nav-text">
                <span className="nav-label">{name}</span>
              </span>
              {s?.branch && (
                <span className="nav-hint space-branch">
                  {s.ahead > 0 && `↑${s.ahead} `}
                  {s.behind > 0 && `↓${s.behind} `}
                  {s.branch}
                </span>
              )}
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
                    onCwd={(cwd) => spaces.reportCwd(leaf.pane, cwd)}
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
