import assert from "node:assert/strict";
import {
  createProject, setProviderAgents, realBuild, startStoryBuild, addBuildStep,
  applyStoryBuild, canConfirmStory, confirmStory, canUndo, toggleCriterion,
} from "./builder_flow.ts";

setProviderAgents([{ id: "x", name: "Local" }]);

const story = (id) => ({
  id, title: "Orders list", status: "todo", needsEngineer: false, engineerCleared: false,
  size: "hard", assignedTo: null, builtBy: null, note: "",
  criteria: [{ text: "Shows ORD-2041", done: false }],
});
const fixture = (agent) => ({
  ...createProject("Orders", "Acme", "Sam", "", agent),
  stage: "build",
  stories: [story("S1")],
});
const live = () => fixture("provider-x");
const s1 = (p) => p.stories[0];

// stand_in_projects_keep_the_simulated_build
assert.equal(realBuild(fixture(null), story("S1")), null);

// cli_agents_are_blocked
assert.equal(
  realBuild(fixture("claude-lead"), story("S1")).blocked,
  "Building with Claude lead is not supported yet; pick a provider agent"
);

// autopilot_uses_the_project_provider
assert.equal(realBuild(live(), story("S1")).agent.id, "provider-x");

// a_finished_run_builds_the_story
const finished = () =>
  applyStoryBuild(startStoryBuild(live(), "provider-x"), { message: "Built S1", stopped: null, html: "<p>ORD-2041</p>" });
{
  const p = finished();
  assert.equal(s1(p).status, "built");
  assert.equal(s1(p).builtBy, "provider-x");
  assert.equal(p.appHtml, "<p>ORD-2041</p>");
  assert.equal(p.buildRun, null);
}

// a_stopped_run_leaves_it_to_do
{
  const p = applyStoryBuild(startStoryBuild(live(), "provider-x"), { message: "", stopped: "maxSteps", html: null });
  assert.equal(s1(p).status, "todo");
  assert.equal(p.agentError, "Stopped after too many steps.");
}

// real_builds_confirm_without_checks_and_cannot_undo
{
  let p = finished();
  p = toggleCriterion(p, "S1", 0);
  assert.equal(p.checksPassing, false);
  assert.equal(canConfirmStory(p), true);
  p = confirmStory(p);
  assert.equal(s1(p).status, "confirmed");
  assert.equal(canUndo(p), false);
}

// steps_are_kept_in_order
{
  let p = startStoryBuild(live(), "provider-x");
  p = addBuildStep(addBuildStep(p, "read prd.md"), "edited app/index.html");
  assert.deepEqual(p.buildRun.steps, ["read prd.md", "edited app/index.html"]);
}

console.log("build_run: ok");
