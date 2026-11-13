import React, { useEffect, useState } from "react";
import { SpaceStatus, spaceStatus } from "./api";
import { TerminalView } from "./Terminal";

/** A tab's panes: a leaf is one terminal (started in `cwd`), a split halves its box. */
export type PaneLeaf = { pane: string; cwd: string };
export type PaneNode = PaneLeaf | { dir: "row" | "col"; a: PaneNode; b: PaneNode };
export type TermTab = { id: string; root: PaneNode; focused: string };
/** A space is a set of terminal tabs, named after the folder its focused terminal is in. */
export type Space = { id: string; tabs: TermTab[]; activeTab: string };

const STATUS_POLL_MS = 5_000;
const HOME = "~";

let seq = 0;
const newId = () => `t${++seq}`;

function newTab(cwd: string): TermTab {
  const pane = newId();
  return { id: newId(), root: { pane, cwd }, focused: pane };
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

/** Each pane's box in percent of the tab. */
function layoutPanes(node: PaneNode, r: Rect = { x: 0, y: 0, w: 100, h: 100 }): [PaneLeaf, Rect][] {
  if ("pane" in node) return [[node, r]];
  const [first, second]: [Rect, Rect] =
    node.dir === "row"
      ? [{ ...r, w: r.w / 2 }, { ...r, x: r.x + r.w / 2, w: r.w / 2 }]
      : [{ ...r, h: r.h / 2 }, { ...r, y: r.y + r.h / 2, h: r.h / 2 }];
  return [...layoutPanes(node.a, first), ...layoutPanes(node.b, second)];
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

  function split(spaceId: string, tabId: string, paneId: string, dir: "row" | "col"): void {
    const pane = newId();
    const cwd = paneCwd[paneId] ?? HOME;
    updateTab(spaceId, tabId, (t) => ({
      ...t,
      root: mapPane(t.root, paneId, (leaf) => ({ dir, a: leaf, b: { pane, cwd } }))!,
      focused: pane,
    }));
  }

  function closePane(spaceId: string, tabId: string, paneId: string): void {
    updateTab(spaceId, tabId, (t) => {
      const root = mapPane(t.root, paneId, () => null);
      if (!root) return null;
      return { ...t, root, focused: t.focused === paneId ? firstPane(root) : t.focused };
    });
  }

  return {
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
    selectTab: (tabId: string) => active && updateSpace(active.id, (s) => ({ ...s, activeTab: tabId })),
    closeTab: (tabId: string) => active && updateTab(active.id, tabId, () => null),
    split,
    splitFocused: (dir: "row" | "col") => active && currentTab && split(active.id, currentTab.id, currentTab.focused, dir),
    closePane,
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
                    focused={visible && tab.focused === leaf.pane}
                    onFocus={() => spaces.focusPane(space.id, tab.id, leaf.pane)}
                    onCwd={(cwd) => spaces.reportCwd(leaf.pane, cwd)}
                    onSplit={(dir) => spaces.split(space.id, tab.id, leaf.pane, dir)}
                    onClose={() => spaces.closePane(space.id, tab.id, leaf.pane)}
                  />
                </div>
              ))}
            </main>
          );
        })
      )}
    </>
  );
}
