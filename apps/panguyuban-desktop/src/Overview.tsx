import React from "react";
import { AgentSession, PullRequest, Ticket } from "./api";
import { padCount } from "./ui";

/** Home: what needs you right now, across tickets, pull requests and agents. */
export function OverviewView(props: {
  myActiveTickets: Ticket[];
  reviewPrs: PullRequest[];
  mergePrs: PullRequest[];
  agents: AgentSession[];
  onOpenTicket: (key: string) => void;
  onOpenPr: (pr: PullRequest, view: "review" | "merge") => void;
  onOpenAgent: (sessionId: string) => void;
}) {
  const { myActiveTickets, reviewPrs, mergePrs } = props;
  // Waiting first: those are the ones blocked on you.
  const liveAgents = props.agents
    .filter((a) => a.status !== "idle")
    .sort((a, b) => Number(b.status === "waiting") - Number(a.status === "waiting"));
  const waiting = liveAgents.filter((a) => a.status === "waiting").length;

  return (
    <section className="pane overview" aria-label="Overview">
      <div className="pane-header">
        <h1>Overview</h1>
      </div>

      <dl className="overview-stats">
        <Stat label="Tickets in progress" value={myActiveTickets.length} />
        <Stat label="PRs to review" value={reviewPrs.length} />
        <Stat label="Ready to merge" value={mergePrs.length} />
        <Stat label="Agents need you" value={waiting} alert={waiting > 0} />
      </dl>

      <div className="settings-grid">
        <Card title="My tickets in progress" empty="Nothing in progress">
          {myActiveTickets.map((t) => (
            <Row key={t.key} id={t.key} chip={t.state} title={t.title} onOpen={() => props.onOpenTicket(t.key)} />
          ))}
        </Card>
        <Card title="Agents" empty="No agents working">
          {liveAgents.map((a) => (
            <Row
              key={a.session_id}
              id={a.name}
              chip={a.status === "waiting" ? "Needs you" : "Working"}
              bad={a.status === "waiting"}
              title={a.cwd}
              onOpen={() => props.onOpenAgent(a.session_id)}
            />
          ))}
        </Card>
        <Card title="Review requested" empty="No reviews waiting">
          {reviewPrs.map((p) => (
            <PrRow key={`${p.repo}#${p.number}`} pr={p} onOpen={() => props.onOpenPr(p, "review")} />
          ))}
        </Card>
        <Card title="Ready to merge" empty="Nothing approved yet">
          {mergePrs.map((p) => (
            <PrRow key={`${p.repo}#${p.number}`} pr={p} onOpen={() => props.onOpenPr(p, "merge")} />
          ))}
        </Card>
      </div>
    </section>
  );
}

function Stat(props: { label: string; value: number; alert?: boolean }) {
  return (
    <div className="overview-stat" data-alert={props.alert || undefined}>
      <dt>{props.label}</dt>
      <dd className="measured-ink">{padCount(props.value)}</dd>
    </div>
  );
}

function Card(props: { title: string; empty: string; children: React.ReactNode[] }) {
  return (
    <div className="overview-card">
      <h2>{props.title}</h2>
      {props.children.length ? (
        <ul className="record-list">{props.children}</ul>
      ) : (
        <p className="record-meta">{props.empty}</p>
      )}
    </div>
  );
}

function PrRow({ pr, onOpen }: { pr: PullRequest; onOpen: () => void }) {
  const failing = typeof pr.ci_state === "object" && "Failing" in pr.ci_state;
  return (
    <Row
      id={`${pr.repo.split("/").pop()}#${pr.number}`}
      chip={failing ? "CI failing" : pr.review_state}
      bad={failing}
      title={pr.title}
      onOpen={onOpen}
    />
  );
}

function Row(props: { id: string; chip: string; bad?: boolean; title: string; onOpen: () => void }) {
  return (
    <li className="record-item">
      <div className="record-top">
        <button type="button" className="record-select-btn" onClick={props.onOpen}>
          {props.id}
        </button>
        <span className={props.bad ? "chip chip--bad" : "chip chip--ok"}>{props.chip}</span>
      </div>
      <div className="record-title">{props.title}</div>
    </li>
  );
}
