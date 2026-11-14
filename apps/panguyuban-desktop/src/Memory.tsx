import React, { useEffect, useRef, useState } from "react";
import { agentClis, folderChanges, memoryRemove, memoryStatus, memorySync, spaceStatus, type MemoryTarget } from "./api";
import { usePersisted } from "./persisted";

interface Memory {
  text: string;
  targets: Record<string, boolean>;
}

function parseMemory(raw: string): Memory {
  try {
    const m = JSON.parse(raw);
    return { text: typeof m?.text === "string" ? m.text : "", targets: m?.targets && typeof m.targets === "object" ? m.targets : {} };
  } catch {
    return { text: "", targets: {} };
  }
}

/** The agents a handoff can start, by the command that starts them. */
const AGENTS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "agy", label: "Antigravity" },
  { id: "hermes", label: "Hermes" },
];
const MAX_HANDOFFS = 50;
const MAX_FILES = 50;

interface Fields {
  folder: string;
  task: string;
  done: string;
  decisions: string;
  next: string;
  listFiles: boolean;
}

interface Handoff extends Fields {
  id: string;
  at: string; // ISO time
  agent: string;
}

function parseHandoffs(raw: string): Handoff[] {
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** A folder to hand off and what to call the task, set by the Agents view's "Hand off". */
export interface HandoffPrefill {
  folder: string;
  task: string;
}

const BLANK: Fields = { folder: "", task: "", done: "", decisions: "", next: "", listFiles: true };

function stateText(t: MemoryTarget): string {
  switch (t.state) {
    case "in_sync":
      return "In sync";
    case "out_of_date":
      return "Changed since last sync";
    case "not_written":
      return "Not written yet";
    case "not_installed":
      return "Agent not installed";
    case "too_long":
      return `Too long for ${t.label}: ${t.length?.toLocaleString("en-US")} of ${t.limit?.toLocaleString("en-US")} characters`;
    case "busy":
      return `${t.label} is busy, try again`;
    default:
      return `Error: ${t.detail ?? "unknown"}`;
  }
}

/** File names from the `diff --git a/x b/y` lines of a unified diff. */
function changedFiles(diff: string[]): string[] {
  const names = diff.filter((l) => l.startsWith("diff --git ")).map((l) => l.split(" b/").pop() ?? l);
  return [...new Set(names)];
}

function buildPrompt(f: Fields, branch: string | null, files: string[] | null): string {
  const lines = ["You are picking up work another agent started. Read this handoff, check the current state of the folder, then continue.", ""];
  const add = (label: string, value: string | null | undefined) => {
    if (value?.trim()) lines.push(`${label}: ${value.trim()}`);
  };
  add("Task", f.task);
  add("Done so far", f.done);
  add("Decisions", f.decisions);
  add("Next step", f.next);
  add("Branch", branch);
  if (files?.length) add("Changed files", files.slice(0, MAX_FILES).join(", "));
  return lines.join("\n");
}

function firstLine(s: string): string {
  return s.trim().split("\n")[0];
}

function folderName(folder: string): string {
  return folder.split("/").filter(Boolean).pop() ?? folder;
}

/** The Memory section: the note every agent reads, where it is written, and handoffs between agents. */
export function MemoryView(props: {
  prefill: HandoffPrefill | null;
  runIn: (cwd: string, command: string) => void;
  showTerminal: () => void;
}) {
  const [memory, setMemory, loaded, loadError] = usePersisted<Memory>("memory", "", parseMemory, { text: "", targets: {} });
  const [handoffs, setHandoffs, handoffsLoaded] = usePersisted<Handoff[]>("handoffs", "", parseHandoffs, []);
  const [statuses, setStatuses] = useState<MemoryTarget[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  // The open composer: its starting fields and a number that resets it when another handoff is opened.
  const [composer, setComposer] = useState<{ fields: Fields; n: number } | null>(null);
  const counter = useRef(0);

  const enabled = (id: string) => memory.targets[id] !== false;

  // Statuses follow the text, a moment after typing stops.
  useEffect(() => {
    if (!loaded) return;
    const timer = window.setTimeout(() => {
      memoryStatus(memory.text).then(setStatuses).catch((err) => setNote(String(err)));
    }, 800);
    return () => window.clearTimeout(timer);
  }, [memory.text, loaded]);

  useEffect(() => {
    if (props.prefill) openComposer({ ...BLANK, folder: props.prefill.folder, task: props.prefill.task });
  }, [props.prefill]);

  function openComposer(fields: Fields) {
    setComposer({ fields, n: ++counter.current });
  }

  async function act(action: () => Promise<MemoryTarget[]>, done: (list: MemoryTarget[]) => string) {
    setBusy(true);
    try {
      const list = await action();
      setStatuses(list);
      setNote(done(list));
    } catch (err) {
      setNote(String(err));
    } finally {
      setBusy(false);
    }
  }

  const ids = statuses.filter((t) => enabled(t.id)).map((t) => t.id);

  return (
    <main className="main-stage main-stage--single">
      <section className="pane" aria-label="Memory">
        <div className="pane-header">
          <div>
            <h1>Memory</h1>
          </div>
        </div>

        <div className="settings-page">
          <section className="settings-section">
            <div className="settings-aside">
              <h2>About you</h2>
              <p>
                One note every agent reads. Keep secrets, tokens and customer or personal data out: it is sent to each
                agent’s model provider.
              </p>
            </div>
            <div className="settings-body">
              <div className="field-group">
                <label className="field-label" htmlFor="memory-text">
                  Note
                </label>
                <textarea
                  id="memory-text"
                  className="input-field"
                  rows={12}
                  value={memory.text}
                  disabled={!loaded}
                  onChange={(e) => setMemory({ ...memory, text: e.target.value })}
                />
                <span className="field-help">
                  {loadError ? `Could not load the saved note: ${loadError}` : `${memory.text.length.toLocaleString("en-US")} characters`}
                </span>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-aside">
              <h2>Where it goes</h2>
              <p>Each agent gets the note in its own instruction file. Only a marked block is changed; the rest of the file stays yours.</p>
            </div>
            <div className="settings-body">
              <ul className="settings-body feature-list">
                {statuses.map((t) => (
                  <li key={t.id} className="feature-row">
                    <button
                      type="button"
                      role="switch"
                      className="switch"
                      aria-checked={enabled(t.id)}
                      aria-label={t.label}
                      onClick={() => setMemory({ ...memory, targets: { ...memory.targets, [t.id]: !enabled(t.id) } })}
                    />
                    <div className="feature-text">
                      <span className="feature-name">{t.label}</span>
                      <span className="memory-path">{t.path}</span>
                      <span className="feature-note">{stateText(t)}</span>
                    </div>
                    {t.written && (
                      <button
                        type="button"
                        className="btn memory-remove"
                        disabled={busy}
                        onClick={() =>
                          act(
                            () => memoryRemove(t.id).then(() => memoryStatus(memory.text)),
                            () => `Removed from ${t.label}`,
                          )
                        }
                      >
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              <div className="settings-save">
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={busy || !loaded || !memory.text.trim() || ids.length === 0}
                  onClick={() =>
                    act(
                      () => memorySync(memory.text, ids),
                      (list) => `Wrote to ${list.filter((t) => ids.includes(t.id) && t.state === "in_sync").length} of ${ids.length} agents`,
                    )
                  }
                >
                  Write to agents
                </button>
                <span className="measured" role="status">
                  {note}
                </span>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-aside">
              <h2>Handoffs</h2>
              <p>Pass work from one agent session to another. Start one here, or use Hand off on an agent.</p>
            </div>
            <div className="settings-body">
              {composer ? (
                <HandoffComposer
                  key={composer.n}
                  initial={composer.fields}
                  save={(h) => setHandoffs((all) => [h, ...all].slice(0, MAX_HANDOFFS))}
                  runIn={props.runIn}
                  showTerminal={props.showTerminal}
                  close={() => setComposer(null)}
                />
              ) : (
                <div>
                  <button type="button" className="btn" onClick={() => openComposer(BLANK)}>
                    New handoff
                  </button>
                </div>
              )}
              <div>
                <div className="ticket-group-head">
                  <h2>History</h2>
                  <span className="measured">{handoffs.length}</span>
                </div>
                {handoffsLoaded && handoffs.length === 0 && <p className="ticket-empty">No handoffs yet.</p>}
                <ul className="ticket-rows">
                  {handoffs.map((h) => (
                    <li key={h.id}>
                      <button type="button" className="ticket-row" onClick={() => openComposer(h)}>
                        <span className="ticket-row-top">
                          <span className="ticket-row-key">{folderName(h.folder)}</span>
                          <span className="measured">
                            {new Date(h.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })} to{" "}
                            {AGENTS.find((a) => a.id === h.agent)?.label ?? h.agent}
                          </span>
                        </span>
                        <span className="ticket-row-title">{firstLine(h.task) || "No task"}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}

/** Writes a handoff and starts it in another agent, in a terminal at the folder. */
function HandoffComposer(props: {
  initial: Fields;
  save: (h: Handoff) => void;
  runIn: (cwd: string, command: string) => void;
  showTerminal: () => void;
  close: () => void;
}) {
  const [f, setF] = useState<Fields>({ ...BLANK, ...props.initial });
  const [available, setAvailable] = useState<string[] | null>(null);
  const [agent, setAgent] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (change: Partial<Fields>) => setF((old) => ({ ...old, ...change }));

  useEffect(() => {
    agentClis().then((list) => {
      const ids = list.filter((a) => a.available).map((a) => a.id);
      setAvailable(ids);
      setAgent((cur) => cur || ids[0] || "");
    });
  }, []);

  async function start() {
    const folder = f.folder.trim();
    setBusy(true);
    try {
      const branch = (await spaceStatus([folder]).catch(() => []))[0]?.branch ?? null;
      let files: string[] | null = null;
      if (f.listFiles) {
        files = await folderChanges(folder).then(changedFiles).catch(() => null); // not a git folder: no list
      }
      const prompt = buildPrompt(f, branch, files);
      props.save({ ...f, folder, id: `${Date.now()}`, at: new Date().toISOString(), agent });
      if (agent === "hermes") {
        // Hermes cannot start with a prompt: copy it, open Hermes, and the user pastes.
        await navigator.clipboard.writeText(prompt);
        props.runIn(folder, "hermes");
        setNote("Handoff copied. Paste it into Hermes with ⌘V.");
        return;
      }
      const quoted = `'${prompt.replace(/'/g, "'\\''")}'`;
      props.runIn(folder, agent === "agy" ? `agy -i ${quoted}` : `${agent} ${quoted}`);
      props.showTerminal();
    } catch (err) {
      setNote(String(err));
    } finally {
      setBusy(false);
    }
  }

  const text = (id: keyof Fields, label: string, rows = 3) => (
    <div className="field-group">
      <label className="field-label" htmlFor={`handoff-${id}`}>
        {label}
      </label>
      <textarea id={`handoff-${id}`} className="input-field" rows={rows} value={f[id] as string} onChange={(e) => set({ [id]: e.target.value })} />
    </div>
  );

  return (
    <div className="settings-body">
      <div className="field-group">
        <label className="field-label" htmlFor="handoff-folder">
          Folder
        </label>
        <input id="handoff-folder" className="input-field" value={f.folder} placeholder="~/project/app" onChange={(e) => set({ folder: e.target.value })} />
      </div>
      {text("task", "Task")}
      {text("done", "Done so far")}
      {text("decisions", "Decisions")}
      {text("next", "Next step")}
      <label className="field-label">
        <input type="checkbox" checked={f.listFiles} onChange={(e) => set({ listFiles: e.target.checked })} /> List the changed files
      </label>
      <div className="field-group">
        <label className="field-label" htmlFor="handoff-agent">
          Start in
        </label>
        <select id="handoff-agent" className="input-field" value={agent} onChange={(e) => setAgent(e.target.value)}>
          {AGENTS.filter((a) => available?.includes(a.id)).map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
        <span className="field-help">{available && available.length === 0 ? "No agent found on this computer." : ""}</span>
      </div>
      <div className="settings-save">
        <button type="button" className="btn btn--primary" disabled={busy || !f.folder.trim() || !agent} onClick={start}>
          Start
        </button>
        <button type="button" className="btn" onClick={props.close}>
          Close
        </button>
        <span className="measured" role="status">
          {note}
        </span>
      </div>
    </div>
  );
}
