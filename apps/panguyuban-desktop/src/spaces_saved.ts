import type { AgentSession } from "./api";
import type { PaneNode, Space } from "./Spaces";

/** Spaces as saved for the next launch. */
export type SavedSpaces = { spaces: Space[]; activeId: string };

/** Panes as they report themselves: the folder their shell is in and their foreground process group. */
export type PaneReports = { cwd: Record<string, string>; group: Record<string, number> };

const SAFE_ID = /^[0-9a-f-]+$/i;
const RESUME = /^(claude --resume|agy --conversation) [0-9a-f-]+$/i;

/** The command that reopens this agent's conversation, or null if its id is not safe to type into a shell. */
export function resumeCommand(s: AgentSession): string | null {
  if (!SAFE_ID.test(s.session_id)) return null;
  return s.harness === "claude" ? `claude --resume ${s.session_id}` : `agy --conversation ${s.session_id}`;
}

/** What to save: each pane's current folder, and the resume command of an agent running in it. */
export function snapshot(spaces: Space[], activeId: string, panes: PaneReports, sessions: AgentSession[]): SavedSpaces {
  const keep = (node: PaneNode): PaneNode => {
    if (!("pane" in node)) return { ...node, a: keep(node.a), b: keep(node.b) };
    const group = panes.group[node.pane];
    // Not reported yet (it just opened): keep the resume it was restored with, nothing else it ran.
    if (group === undefined) {
      return { pane: node.pane, cwd: node.cwd, run: node.run && RESUME.test(node.run) ? node.run : undefined };
    }
    const agent = sessions.find((s) => s.pgid > 0 && s.pgid === group);
    const run = agent && resumeCommand(agent);
    return agent && run
      ? { pane: node.pane, cwd: agent.cwd, run }
      : { pane: node.pane, cwd: panes.cwd[node.pane] ?? node.cwd };
  };
  return { spaces: spaces.map((s) => ({ ...s, tabs: s.tabs.map((t) => ({ ...t, root: keep(t.root) })) })), activeId };
}

// Parsed JSON whose shape is being checked.
type Json = any;

const validNode = (n: Json): boolean =>
  !!n &&
  (typeof n.pane === "string"
    ? typeof n.cwd === "string"
    : (n.dir === "row" || n.dir === "col") && validNode(n.a) && validNode(n.b));

/** Last launch's spaces, or null when there are none or they cannot be read. */
export function parseSaved(raw: string | null): SavedSpaces | null {
  try {
    const saved: Json = JSON.parse(raw ?? "null");
    const ok =
      Array.isArray(saved?.spaces) &&
      saved.spaces.length > 0 &&
      saved.spaces.every(
        (s: Json) =>
          typeof s?.id === "string" &&
          Array.isArray(s.tabs) &&
          s.tabs.length > 0 &&
          s.tabs.every((t: Json) => typeof t?.id === "string" && typeof t.focused === "string" && validNode(t.root)),
      );
    return ok ? { spaces: saved.spaces, activeId: typeof saved.activeId === "string" ? saved.activeId : "" } : null;
  } catch {
    return null;
  }
}

/** The highest `t<n>` id in use, so new ids continue after it. */
export function maxId(saved: SavedSpaces): number {
  const ids = JSON.stringify(saved.spaces).match(/"t\d+"/g) ?? [];
  return Math.max(0, ...ids.map((id) => Number(id.slice(2, -1))));
}
