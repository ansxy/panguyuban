import { useState } from "react";
import type { ReviewRole } from "./api";
import { duration } from "./Agents";
import { reviewState, ROLE_LABEL, SPECIALISTS, type ReviewNode, type TeamReview } from "./team_review";

function caption(n: ReviewNode): string {
  if (n.status === "done") {
    const c = n.result?.findings.length ?? 0;
    return `${c} finding${c === 1 ? "" : "s"}`;
  }
  return n.status === "working" ? "working…" : n.status;
}

export function TeamFlow({
  review,
  now,
  onRetry,
}: {
  review: TeamReview;
  now: number;
  onRetry?: (role: ReviewRole) => void;
}) {
  const [picked, setPicked] = useState<ReviewRole | null>(null);
  const running = reviewState(review) === "running";
  const node = (role: ReviewRole) => {
    const n = review.nodes[role];
    return (
      <button
        key={role}
        type="button"
        className={`team-flow-node is-${n.status}`}
        aria-pressed={picked === role}
        aria-label={`${ROLE_LABEL[role]}, ${caption(n)}`}
        onClick={() => setPicked(picked === role ? null : role)}
      >
        <span className="team-flow-dot" aria-hidden="true" />
        <strong>{ROLE_LABEL[role]}</strong>
        <span className="team-flow-sub">{caption(n)}</span>
      </button>
    );
  };
  const sel = picked ? review.nodes[picked] : null;
  const verdict = review.nodes.leader.result;
  return (
    <div className="team-flow">
      <div className="team-flow-graph">
        <span className="team-flow-prd">PRD</span>
        <div className="team-flow-col">{SPECIALISTS.map(node)}</div>
        {node("contrarian")}
        {node("leader")}
      </div>
      {running && <p className="field-help">Reviewing for {duration(now - review.startedAt)}</p>}
      {picked && sel && (
        <div className="team-flow-detail">
          <strong>{ROLE_LABEL[picked]}</strong>
          {sel.error && <p className="team-flow-error">{sel.error}</p>}
          <Findings role={sel.result} />
          {sel.status === "failed" && onRetry && (
            <button type="button" className="btn" disabled={running} onClick={() => onRetry(picked)}>
              Retry
            </button>
          )}
        </div>
      )}
      {!running && review.nodes.leader.status === "done" && verdict && (
        <div className="team-flow-detail">
          <strong>Leader verdict</strong>
          <p>{verdict.verdict}</p>
          <Findings role={verdict} />
        </div>
      )}
    </div>
  );
}

function Findings({ role }: { role: ReviewNode["result"] }) {
  if (!role) return null;
  return (
    <ul className="team-flow-findings">
      {role.findings.map((f, i) => (
        <li key={i}>
          <span className={`chip team-flow-tag is-${f.severity}`}>{f.severity}</span>
          {f.step && <span className="measured"> {f.step} </span>}
          {f.text}
        </li>
      ))}
    </ul>
  );
}
