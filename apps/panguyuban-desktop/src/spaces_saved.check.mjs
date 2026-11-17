import assert from "node:assert/strict";
import { maxId, parseSaved, resumeCommand, snapshot } from "./spaces_saved.ts";

const ID = "0c22040c-b395-480d-82fc-52a63414c868";
const agent = (harness, pgid, cwd = "/work/app") => ({ harness, session_id: ID, pgid, cwd });
const tab = (root) => ({ id: "t2", root, focused: "t3" });
const space = (root) => ({ id: "t1", tabs: [tab(root)], activeTab: "t2" });
const split = { dir: "row", a: { pane: "t3", cwd: "~" }, b: { pane: "t4", cwd: "~", run: "git checkout main" } };

// A pane running Claude saves its resume command and the agent's folder; others keep their folder only.
let saved = snapshot([space(split)], "t1", { cwd: { t3: "~/app", t4: "~/web" }, group: { t3: 500, t4: 600 } }, [agent("claude", 500)]);
let root = saved.spaces[0].tabs[0].root;
assert.deepEqual(root.a, { pane: "t3", cwd: "/work/app", run: `claude --resume ${ID}` });
assert.deepEqual(root.b, { pane: "t4", cwd: "~/web" }); // a one-off command is never replayed
assert.equal(saved.activeId, "t1");

// Antigravity resumes by conversation id.
assert.equal(resumeCommand(agent("antigravity", 1)), `agy --conversation ${ID}`);
// An id that is not a UUID is never typed into a shell.
assert.equal(resumeCommand({ harness: "claude", session_id: "x; rm -rf ~", pgid: 1, cwd: "/" }), null);

// A pane that has not reported yet keeps a restored resume, but not other commands.
const restored = { dir: "col", a: { pane: "t3", cwd: "/work/app", run: `claude --resume ${ID}` }, b: { pane: "t4", cwd: "~", run: "make deploy" } };
root = snapshot([space(restored)], "t1", { cwd: {}, group: {} }, []).spaces[0].tabs[0].root;
assert.equal(root.a.run, `claude --resume ${ID}`);
assert.equal(root.b.run, undefined);

// Once it reports and the agent has gone, the resume is dropped.
root = snapshot([space(restored)], "t1", { cwd: { t3: "~/app" }, group: { t3: 700 } }, []).spaces[0].tabs[0].root;
assert.deepEqual(root.a, { pane: "t3", cwd: "~/app" });

// Round trip through storage, and the next id continues past the saved ones.
const back = parseSaved(JSON.stringify(saved));
assert.deepEqual(back, saved);
assert.equal(maxId(back), 4);

// Anything unreadable or malformed starts fresh.
for (const bad of [null, "", "{", "[]", '{"spaces":[]}', '{"spaces":[{"id":"t1","tabs":[]}]}', '{"spaces":[{"id":"t1","tabs":[{"id":"t2","focused":"t3","root":{"dir":"row","a":{"pane":"t3","cwd":"~"}}}]}]}']) {
  assert.equal(parseSaved(bad), null, `should reject ${bad}`);
}

console.log("spaces_saved: ok");
