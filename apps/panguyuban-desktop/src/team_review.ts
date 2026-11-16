import type { ReviewRole, RoleReview } from "./api";

export type NodeStatus = "waiting" | "working" | "done" | "failed";

export interface ReviewNode {
  status: NodeStatus;
  result: RoleReview | null;
  error: string | null;
}

export interface TeamReview {
  prd: string;
  startedAt: number;
  finishedAt: number | null;
  nodes: Record<ReviewRole, ReviewNode>;
}

export const SPECIALISTS: ReviewRole[] = ["engineer", "ux", "qa"];
const ROLES: ReviewRole[] = ["engineer", "ux", "qa", "contrarian", "leader"];

export const ROLE_LABEL: Record<ReviewRole, string> = {
  engineer: "Engineer",
  ux: "UX",
  qa: "QA",
  contrarian: "Contrarian",
  leader: "Leader",
};

const blank = (): ReviewNode => ({ status: "waiting", result: null, error: null });

export function startReview(prd: string, now: number): TeamReview {
  const nodes = {} as Record<ReviewRole, ReviewNode>;
  for (const r of ROLES) nodes[r] = blank();
  return { prd, startedAt: now, finishedAt: null, nodes };
}

export function reviewState(r: TeamReview): "running" | "done" | "stopped" {
  if (SPECIALISTS.every((s) => r.nodes[s].status === "failed")) return "stopped";
  const l = r.nodes.leader.status;
  return l === "done" || l === "failed" ? "done" : "running";
}

export function setNode(
  r: TeamReview,
  role: ReviewRole,
  patch: Partial<ReviewNode>,
  now: number,
): TeamReview {
  const next: TeamReview = { ...r, nodes: { ...r.nodes, [role]: { ...r.nodes[role], ...patch } } };
  if (reviewState(next) !== "running") next.finishedAt = now;
  return next;
}

export function nextWave(r: TeamReview): ReviewRole[] {
  const n = r.nodes;
  const waiting = SPECIALISTS.filter((s) => n[s].status === "waiting");
  if (waiting.length) return waiting;
  if (SPECIALISTS.some((s) => n[s].status === "working")) return [];
  if (!SPECIALISTS.some((s) => n[s].status === "done")) return [];
  if (n.contrarian.status === "waiting") return ["contrarian"];
  const c = n.contrarian.status;
  if (n.leader.status === "waiting" && (c === "done" || c === "failed")) return ["leader"];
  return [];
}

export function earlierFor(r: TeamReview, role: ReviewRole): RoleReview[] {
  const roles = role === "contrarian" ? SPECIALISTS : role === "leader" ? [...SPECIALISTS, "contrarian" as ReviewRole] : [];
  const out: RoleReview[] = [];
  for (const k of roles) {
    const n = r.nodes[k];
    if (n.status === "done" && n.result) out.push(n.result);
  }
  return out;
}

export function retryFrom(r: TeamReview, role: ReviewRole): TeamReview {
  const reset: ReviewRole[] = [role];
  if (role !== "leader") reset.push("contrarian");
  reset.push("leader");
  const nodes = { ...r.nodes };
  for (const k of reset) nodes[k] = blank();
  return { ...r, finishedAt: null, nodes };
}

export function interrupt(r: TeamReview): TeamReview {
  const nodes = { ...r.nodes };
  for (const k of ROLES) {
    if (nodes[k].status === "working") nodes[k] = { ...nodes[k], status: "failed", error: "Interrupted, run again" };
  }
  return { ...r, nodes };
}

export function isStale(r: TeamReview, prd: string): boolean {
  return r.prd !== prd;
}

export function reviewSummary(r: TeamReview): string {
  const s = reviewState(r);
  if (s === "stopped") return "stopped";
  if (s === "running") {
    const n = ROLES.filter((k) => r.nodes[k].status === "done" || r.nodes[k].status === "failed").length;
    return `${n} of 5 done`;
  }
  const res = r.nodes.leader.result;
  if (r.nodes.leader.status !== "done" || !res) return "done · no verdict";
  const b = res.findings.filter((f) => f.severity === "blocker").length;
  return `done · ${b} blocker${b === 1 ? "" : "s"}`;
}
