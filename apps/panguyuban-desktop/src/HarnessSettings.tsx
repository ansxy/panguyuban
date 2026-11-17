import React, { useEffect, useState } from "react";
import { builderHarnessSettings, builderSaveHarnessSettings, installPangu, panguStatus, type HarnessSessionView } from "./api";

const LABELS: Record<string, string> = {
  read_file: "Read files",
  list_files: "List files",
  search: "Search",
  write_file: "Write whole file",
  edit_file: "Edit part of file",
  no_external_urls: "Warn about links the preview blocks",
};
const label = (name: string) => LABELS[name] ?? name;

/** Settings section: what the build agent may do. Only narrows; Rust enforces the ceiling. */
export function HarnessSection() {
  const [views, setViews] = useState<HarnessSessionView[]>([]);
  useEffect(() => {
    builderHarnessSettings().then(setViews).catch(() => setViews([]));
  }, []);

  const [linked, setLinked] = useState<string | null>(null);
  const [cliStatus, setCliStatus] = useState("");
  useEffect(() => {
    panguStatus().then(setLinked).catch(() => setLinked(null));
  }, []);
  async function install() {
    try {
      setLinked(await installPangu());
      setCliStatus("");
    } catch (err) {
      setCliStatus(`Could not install: ${String(err)}`);
    }
  }

  return (
    <section className="settings-section">
      <div className="settings-aside">
        <h2>Agent harness</h2>
        <p>What the agent may do while it builds. Engineering sets the most it may do; you can switch things off or lower the limits.</p>
      </div>
      <div className="settings-body">
        <fieldset className="field-group">
          <legend className="field-label">Command line</legend>
          <p className="measured">Use the agent from any terminal: run pangu, or pangu claude.</p>
          <div className="settings-save">
            <button type="button" className="btn" onClick={install}>
              {linked ? "Reinstall" : "Install `pangu` command"}
            </button>
            <span className="measured" role="status">
              {linked ? `Installed at ${linked}` : cliStatus}
            </span>
          </div>
          {linked && cliStatus && <p className="measured" role="status">{cliStatus}</p>}
        </fieldset>
        {views.map((v) => (
          <HarnessSession key={v.session.id} view={v} onChange={setViews} />
        ))}
      </div>
    </section>
  );
}

function HarnessSession({ view, onChange }: { view: HarnessSessionView; onChange: (v: HarnessSessionView[]) => void }) {
  const { session } = view;
  const [tools, setTools] = useState(view.tools);
  const [hooks, setHooks] = useState(view.hooks);
  const [maxSteps, setMaxSteps] = useState(view.maxSteps);
  const [minutes, setMinutes] = useState(view.timeoutMinutes);
  const [status, setStatus] = useState("");

  function adopt(next: HarnessSessionView[]) {
    const mine = next.find((n) => n.session.id === session.id);
    if (mine) {
      setTools(mine.tools);
      setHooks(mine.hooks);
      setMaxSteps(mine.maxSteps);
      setMinutes(mine.timeoutMinutes);
    }
    onChange(next);
  }

  async function save(settings: { tools: string[]; hooks: string[]; maxSteps: number; timeoutMinutes: number } | null) {
    try {
      adopt(await builderSaveHarnessSettings(session.id, settings));
      setStatus(settings ? "Saved." : "Back to the defaults.");
    } catch (err) {
      setStatus(`Could not save: ${String(err)}`);
    }
  }

  const toggle = (list: string[], set: (l: string[]) => void, name: string) =>
    set(list.includes(name) ? list.filter((n) => n !== name) : [...list, name]);
  const num = (set: (n: number) => void, max: number) => (e: React.ChangeEvent<HTMLInputElement>) =>
    set(Math.min(max, Math.max(1, Math.floor(Number(e.target.value)) || 1)));
  const writes = session.writePaths.includes("*") ? "Writes anywhere in the project folder" : `Writes only ${session.writePaths.join(", ")}`;

  return (
    <div className="settings-body">
      <h3>{session.labelEn}</h3>
      <fieldset className="field-group">
        <legend className="field-label">Tools</legend>
        {session.tools.map((n) => (
          <label key={n} className="field-label">
            <input type="checkbox" checked={tools.includes(n)} onChange={() => toggle(tools, setTools, n)} /> {label(n)}
          </label>
        ))}
      </fieldset>
      {session.hooks.length > 0 && (
        <fieldset className="field-group">
          <legend className="field-label">Checks</legend>
          {session.hooks.map((n) => (
            <label key={n} className="field-label">
              <input type="checkbox" checked={hooks.includes(n)} onChange={() => toggle(hooks, setHooks, n)} /> {label(n)}
            </label>
          ))}
        </fieldset>
      )}
      <fieldset className="field-group">
        <legend className="field-label">Limits</legend>
        <label className="field-label" htmlFor={`${session.id}-steps`}>
          Max steps (1–{session.maxSteps})
        </label>
        <input id={`${session.id}-steps`} type="number" className="input-field" min={1} max={session.maxSteps} value={maxSteps} onChange={num(setMaxSteps, session.maxSteps)} />
        <label className="field-label" htmlFor={`${session.id}-minutes`}>
          Timeout minutes (1–{session.timeoutMinutes})
        </label>
        <input id={`${session.id}-minutes`} type="number" className="input-field" min={1} max={session.timeoutMinutes} value={minutes} onChange={num(setMinutes, session.timeoutMinutes)} />
      </fieldset>
      <fieldset className="field-group">
        <legend className="field-label">Always on</legend>
        <p className="measured">Stays inside the project folder</p>
        <p className="measured">{writes}</p>
      </fieldset>
      <div className="settings-save">
        <button type="button" className="btn" onClick={() => save(null)}>
          Reset to defaults
        </button>
        <button type="button" className="btn btn--primary" onClick={() => save({ tools, hooks, maxSteps, timeoutMinutes: minutes })}>
          Save
        </button>
        <span className="measured" role="status">
          {status}
        </span>
      </div>
    </div>
  );
}
