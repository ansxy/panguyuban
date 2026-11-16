import assert from "node:assert/strict";
import {
  startReview, setNode, nextWave, earlierFor, retryFrom,
  reviewState, interrupt, isStale, reviewSummary,
} from "./team_review.ts";

const rr = (role, findings = []) => ({ role, findings, verdict: "v", fixes: "" });
const done = (r, role, findings) => setNode(r, role, { status: "done", result: rr(role, findings) }, 1);
const fail = (r, role) => setNode(r, role, { status: "failed", error: "x" }, 1);
const work = (r, role) => setNode(r, role, { status: "working" }, 1);

// first_wave_is_the_specialists
assert.deepEqual(nextWave(startReview("p", 0)), ["engineer", "ux", "qa"]);

// contrarian_waits_for_all_specialists
{
  let r = startReview("p", 0);
  r = done(r, "engineer"); r = work(r, "ux"); r = done(r, "qa");
  assert.deepEqual(nextWave(r), []);
  r = done(r, "ux");
  assert.deepEqual(nextWave(r), ["contrarian"]);
  assert.equal(earlierFor(r, "contrarian").length, 3);
}

// leader_runs_after_contrarian_fails
{
  let r = startReview("p", 0);
  for (const s of ["engineer", "ux", "qa"]) r = done(r, s);
  r = fail(r, "contrarian");
  assert.deepEqual(nextWave(r), ["leader"]);
}

// stops_when_every_specialist_failed
{
  let r = startReview("p", 0);
  for (const s of ["engineer", "ux", "qa"]) r = fail(r, s);
  assert.deepEqual(nextWave(r), []);
  assert.equal(reviewState(r), "stopped");
  assert.notEqual(r.finishedAt, null);
}

const all = () => {
  let r = startReview("p", 0);
  for (const s of ["engineer", "ux", "qa", "contrarian"]) r = done(r, s);
  return r;
};

// retry_leader_keeps_the_rest
{
  const r = retryFrom(fail(all(), "leader"), "leader");
  assert.equal(Object.values(r.nodes).filter((n) => n.status === "done").length, 4);
  assert.equal(r.nodes.leader.status, "waiting");
}

// retry_specialist_resets_later_waves
{
  const r = retryFrom(done(all(), "leader"), "ux");
  for (const k of ["ux", "contrarian", "leader"]) assert.equal(r.nodes[k].status, "waiting");
  assert.equal(r.nodes.engineer.status, "done");
  assert.equal(r.nodes.qa.status, "done");
  assert.equal(r.finishedAt, null);
}

// interrupt_marks_working_nodes_failed
{
  const r = interrupt(work(done(startReview("p", 0), "engineer"), "ux"));
  assert.equal(r.nodes.ux.status, "failed");
  assert.equal(r.nodes.ux.error, "Interrupted, run again");
  assert.equal(r.nodes.engineer.status, "done");
}

// stale_after_prd_changes
assert.equal(isStale(startReview("a", 0), "b"), true);

// summary_counts_blockers
{
  const r = done(all(), "leader", [
    { severity: "blocker", step: null, text: "a" },
    { severity: "suggestion", step: null, text: "b" },
  ]);
  assert.equal(reviewSummary(r), "done · 1 blocker");
  assert.equal(reviewSummary(startReview("p", 0)), "0 of 5 done");
}
