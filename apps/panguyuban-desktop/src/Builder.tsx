import React, { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  builderAgents,
  builderDesign,
  builderInterviewTurn,
  builderModels,
  builderPlan,
  builderSavePrd,
  HarnessStatus,
} from "./api";
import { modelsForHarness, useProviders } from "./providers";
import {
  agentById,
  agentModel,
  agentFailed,
  agentFor,
  AgentDef,
  allAgents,
  setAgentModel,
  answeredCount,
  applyAgentReply,
  applyDesign,
  applyPlan,
  approvePrd,
  askEngineer,
  AssignMode,
  assignStory,
  awaitingApproval,
  blockedStories,
  buildCurrentStory,
  canChooseBuild,
  canConfirmStory,
  canFinishPrototype,
  canStartSetup,
  canTick,
  canUndo,
  chooseBuild,
  canHandOver,
  clearStory,
  confirmStory,
  createProject,
  currentStory,
  DEMO_QUESTIONS,
  failedTask,
  finishPrototype,
  finishSetup,
  handOver,
  isLive,
  keepDesign,
  linesLeft,
  LEGACY_STORE_KEY,
  parseProjects,
  lockedDesign,
  looksLikePrd,
  moveStoryToLater,
  needsAgentTurn,
  needsDesign,
  needsPlan,
  planWithRules,
  prdMarkdown,
  Project,
  QUESTIONS,
  redoInterview,
  resolveChange,
  retryAgent,
  SETUP_STEPS,
  setAssignMode,
  sharePreview,
  stageIndex,
  stagesFor,
  startSetup,
  Story,
  toggleCriterion,
  transcriptFor,
  undoLastStep,
  userSays,
} from "./builder_flow";
import { usePersisted } from "./persisted";
import { FilterTabs } from "./ui";

type Tab = "steps" | "preview" | "prd" | "record";

const SETUP_STEP_MS = 700;

/** Prototypes kept on this machine, with the one being worked on. */
export function useBuilder(enabled = true) {
  const [projects, setProjects, loaded, loadError] = usePersisted<Project[]>("builder", LEGACY_STORE_KEY, parseProjects, []);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [harnesses, setHarnesses] = useState<HarnessStatus[]>([]);
  const providers = useProviders();

  // Models per harness, fetched once and kept; "error" means the tool could not list them.
  const [models, setModels] = useState<Record<string, { id: string; label: string }[] | "error">>({});
  const asked = useRef(new Set<string>());
  const [, bump] = useState(0);

  useEffect(() => {
    if (loaded) setSelectedId((id) => id ?? projects[0]?.id ?? null);
  }, [loaded]);

  useEffect(() => {
    if (!enabled) return;
    builderAgents()
      .then(setHarnesses)
      .catch(() => setHarnesses([]));
  }, [enabled]);

  const project = projects.find((p) => p.id === selectedId) ?? null;

  /** Models for a harness: undefined while loading, "error" if it could not be listed. */
  function modelsFor(harness: string) {
    const isProvider = harness.startsWith("provider:");
    // A provider's URL arrives with the saved list, so it cannot be asked about before then.
    if (!asked.current.has(harness) && (!isProvider || providers.some((p) => `provider:${p.id}` === harness))) {
      asked.current.add(harness);
      (isProvider ? modelsForHarness(harness) : builderModels(harness))
        .then((list) => setModels((m) => ({ ...m, [harness]: list })))
        .catch(() => setModels((m) => ({ ...m, [harness]: "error" })));
    }
    return models[harness];
  }

  function setModel(agentId: string, model: string | null) {
    setAgentModel(agentId, model);
    bump((n) => n + 1);
  }

  function updateById(id: string, change: (p: Project) => Project) {
    setProjects((all) => all.map((p) => (p.id === id ? change(p) : p)));
  }

  function update(change: (p: Project) => Project) {
    if (selectedId) updateById(selectedId, change);
  }

  function create(name: string, client: string, author: string, description: string, agentId: string | null) {
    const created = createProject(name, client, author, description, agentId);
    setProjects((all) => [created, ...all]);
    setSelectedId(created.id);
  }

  /** Removes a prototype from the app; its saved files in Documents/Panguyuban stay. */
  function remove(id: string) {
    const rest = projects.filter((p) => p.id !== id);
    setProjects(rest);
    if (selectedId === id) setSelectedId(rest[0]?.id ?? null);
  }

  /** Agents whose command-line tool is installed here, lead first, then saved providers (always available). */
  const liveAgents = allAgents()
    .filter((a) => a.harness.startsWith("provider:") || harnesses.some((h) => h.harness === a.harness && h.available))
    .map((a) => agentById(a.id) ?? a);

  return {
    loaded,
    loadError,
    projects,
    project,
    selectedId,
    select: setSelectedId,
    update,
    updateById,
    create,
    remove,
    liveAgents,
    modelsFor,
    setModel,
  };
}

/** Prototypes with an agent turn running. Module-level so a re-mount cannot start a second one. */
const turnsInFlight = new Set<string>();

/**
 * Runs the agent whenever the prototype is waiting on it: an interview turn, or
 * the plan after the PRD is approved. Returns what it is doing, if anything.
 */
function useAgentTurn(builder: Builder, project: Project): "interview" | "plan" | "design" | null {
  const [, rerender] = useState(0);
  const waiting = needsAgentTurn(project);
  const planning = needsPlan(project);
  const designing = needsDesign(project);

  useEffect(() => {
    const agent = agentById(project.interviewAgent);
    if (!designing || !agent || turnsInFlight.has(project.id)) return;
    const id = project.id;
    turnsInFlight.add(id);
    rerender((n) => n + 1);
    builderDesign({
      projectId: id,
      projectName: project.name,
      harness: agent.harness,
      model: agent.model,
      prd: prdMarkdown(project),
      current: project.designHtml,
      changes: project.designChanges,
    })
      .then((design) => builder.updateById(id, (p) => applyDesign(p, design.message, design.html, design.path)))
      .catch((err) => builder.updateById(id, (p) => agentFailed(p, String(err))))
      .finally(() => {
        turnsInFlight.delete(id);
        rerender((n) => n + 1);
      });
  }, [project.id, designing, project.designChanges.length]);

  useEffect(() => {
    const agent = agentById(project.interviewAgent);
    if (!planning || !agent || turnsInFlight.has(project.id)) return;
    const id = project.id;
    turnsInFlight.add(id);
    rerender((n) => n + 1);
    builderPlan({
      projectId: id,
      projectName: project.name,
      harness: agent.harness,
      model: agent.model,
      prd: prdMarkdown(project),
    })
      .then((plan) => builder.updateById(id, (p) => applyPlan(p, plan.summary, plan.steps)))
      .catch((err) => builder.updateById(id, (p) => agentFailed(p, String(err))))
      .finally(() => {
        turnsInFlight.delete(id);
        rerender((n) => n + 1);
      });
  }, [project.id, planning]);

  useEffect(() => {
    const agent = agentById(project.interviewAgent);
    if (!waiting || !agent || turnsInFlight.has(project.id)) return;
    const id = project.id;
    turnsInFlight.add(id);
    rerender((n) => n + 1);
    builderInterviewTurn({
      projectId: id,
      projectName: project.name,
      client: project.client,
      author: project.author,
      harness: agent.harness,
      model: agent.model,
      transcript: transcriptFor(project),
    })
      .then((reply) => builder.updateById(id, (p) => applyAgentReply(p, reply.message, reply.prd, reply.prd_path)))
      .catch((err) => builder.updateById(id, (p) => agentFailed(p, String(err))))
      .finally(() => {
        turnsInFlight.delete(id);
        rerender((n) => n + 1);
      });
  }, [project.id, waiting, project.messages.length]);

  if (!turnsInFlight.has(project.id)) return null;
  if (project.stage === "prototype") return "design";
  return project.stage === "plan" ? "plan" : "interview";
}

export type Builder = ReturnType<typeof useBuilder>;

export function BuilderView({ builder }: { builder: Builder }) {
  const { project, loaded, loadError } = builder;
  const [creating, setCreating] = useState(false);

  if (!loaded)
    return (
      <p className="req-empty" role={loadError ? "alert" : undefined}>
        {loadError ? `Could not read saved prototypes: ${loadError}` : "Loading prototypes…"}
      </p>
    );

  if (!project || creating) {
    return (
      <NewPrototype
        canCancel={!!project}
        onCancel={() => setCreating(false)}
        builder={builder}
        liveAgents={builder.liveAgents}
        onCreate={(name, client, author, description, agentId) => {
          builder.create(name, client, author, description, agentId);
          setCreating(false);
        }}
      />
    );
  }

  return (
    <>
      <SessionPane builder={builder} project={project} onNew={() => setCreating(true)} />
      <InspectorPane key={project.id} builder={builder} project={project} />
    </>
  );
}

/** Which model an agent runs. "" keeps the agent's default. Per agent, not per prototype. */
function ModelPick(props: { builder: Builder; agentId: string; className?: string }) {
  const base = agentById(props.agentId);
  const list = base ? props.builder.modelsFor(base.harness) : undefined;
  const chosen = base ? agentModel(base.id) ?? "" : "";
  // A provider has no default model, so the first one is picked until the user chooses.
  const needsModel = !!base?.harness.startsWith("provider:");
  const first = Array.isArray(list) ? list[0]?.id : undefined;
  useEffect(() => {
    if (base && needsModel && !chosen && first) props.builder.setModel(base.id, first);
  }, [base?.id, needsModel, chosen, first]);
  if (!base) return null;
  return (
    <>
      <select
        className={`input-field ${props.className ?? ""}`}
        aria-label={`Model for ${base.label}`}
        value={chosen}
        onChange={(e) => props.builder.setModel(base.id, e.target.value || null)}
      >
        {!needsModel && <option value="">Default ({base.model ?? "tool default"})</option>}
        {list === undefined && <option disabled>Loading models…</option>}
        {list === "error" && <option disabled>Could not list models</option>}
        {Array.isArray(list) &&
          list.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        {/* A saved choice the tool no longer lists stays visible instead of silently resetting. */}
        {chosen && !(Array.isArray(list) && list.some((m) => m.id === chosen)) && (
          <option value={chosen}>{chosen}</option>
        )}
      </select>
      {needsModel && Array.isArray(list) && !list.length && (
        <span className="field-help">This provider lists no models. Check it in Settings.</span>
      )}
      {needsModel && list === "error" && (
        <span className="field-help">Could not list this provider's models. Test it in Settings.</span>
      )}
      {needsModel && chosen && chosen === first && (
        <span className="field-help">Using the first model in the list; pick another if you want.</span>
      )}
    </>
  );
}

function NewPrototype(props: {
  builder: Builder;
  canCancel: boolean;
  onCancel: () => void;
  liveAgents: AgentDef[];
  onCreate: (name: string, client: string, author: string, description: string, agentId: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [client, setClient] = useState("");
  const [author, setAuthor] = useState("");
  const [description, setDescription] = useState("");
  // null = not chosen yet: use the first installed agent, or the stand-in if there is none.
  const [picked, setPicked] = useState<string | null>(null);
  const agentId = picked ?? props.liveAgents[0]?.id ?? "";
  const isPrd = looksLikePrd(description);
  const [fileError, setFileError] = useState<string | null>(null);

  function loadFile(file: File | undefined) {
    if (!file) return;
    file
      .text()
      .then((text) => {
        setDescription(text);
        setFileError(null);
      })
      .catch(() => setFileError(`Could not read ${file.name}`));
  }

  const ready = name.trim() !== "" && client.trim() !== "";

  return (
    <section className="pane builder-new" aria-label="New prototype">
      <div className="pane-header">
        <h1 className="builder-title">New prototype</h1>
      </div>
      <p className="builder-lead">
        Tell me what you want to show and who it is for. If you already know the details,
        write them below and I will only ask about what is missing. Nothing is built until
        you approve the plan, and engineering is told that this prototype exists.
      </p>
      <form
        className="settings-page"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) props.onCreate(name, client, author, description, agentId || null);
        }}
      >
        <section className="settings-section">
          <div className="settings-aside">
            <h2>What it is</h2>
            <p>The name in the list, and who the prototype is for.</p>
          </div>
          <div className="settings-body">
            <label className="field-group">
              <span className="field-label">What is it called?</span>
              <input
                className="input-field"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Orders tracking demo"
                autoFocus
              />
            </label>
            <label className="field-group">
              <span className="field-label">Which client is it for?</span>
              <input
                className="input-field"
                value={client}
                onChange={(e) => setClient(e.target.value)}
                placeholder="Client name"
              />
            </label>
            <label className="field-group">
              <span className="field-label">Your name and team</span>
              <input
                className="input-field"
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                placeholder="Optional"
              />
            </label>
          </div>
        </section>
        <section className="settings-section">
          <div className="settings-aside">
            <h2>What you know</h2>
            <p>Anything you already have. Leave it empty and the interview starts from nothing.</p>
          </div>
          <div className="settings-body">
            <label className="field-group">
              <span className="field-label">What do you want to build?</span>
              <textarea
                className="input-field chat-box builder-describe"
                rows={8}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={"Optional. Paste what you already know, or a PRD you already have: the problem, who uses it, the steps you will show (one per line), when the demo is."}
              />
              <span className="field-help" role="status">
                {fileError ??
                  (isPrd
                    ? "This is already a PRD in our format. It will be used as it is, with no interview, and you approve it before anything is built."
                    : description.trim()
                      ? "I will work from this and only ask about what is missing."
                      : "Leave it empty and I will ask one question at a time.")}
              </span>
            </label>
            <label className="btn builder-file">
              Load a PRD or notes from a file
              <input
                type="file"
                accept=".md,.markdown,.txt,text/markdown,text/plain"
                onChange={(e) => {
                  loadFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        </section>
        <section className="settings-section">
          <div className="settings-aside">
            <h2>Who interviews</h2>
            <p>The agent that asks the questions and writes the PRD.</p>
          </div>
          <div className="settings-body">
            <label className="field-group">
              <span className="field-label">Who runs the interview?</span>
              <select className="input-field" value={agentId} onChange={(e) => setPicked(e.target.value)}>
                {props.liveAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                    {a.model ? `, ${a.model}` : ""}
                    {a.harness === "antigravity" ? " (untested)" : ""}
                  </option>
                ))}
                <option value="">Scripted stand-in (no agent)</option>
              </select>
              {agentId && (
                <>
                  <span className="field-label">Model</span>
                  <ModelPick builder={props.builder} agentId={agentId} />
                  <span className="field-help">The model applies to this agent in every prototype.</span>
                </>
              )}
              <span className="field-help">
                {props.liveAgents.length
                  ? "A real agent asks the questions and writes the PRD. It cannot run commands or touch your files."
                  : "No agent was found on this machine, so the interview uses scripted questions."}
              </span>
            </label>
          </div>
        </section>
        <div className="action-bar builder-submit">
          <div className="action-group">
            <button type="submit" className="btn btn--primary" disabled={!ready}>
              {isPrd ? "Use this PRD" : description.trim() ? "Start from this description" : "Start the interview"}
            </button>
            {props.canCancel && (
              <button type="button" className="btn" onClick={props.onCancel}>
                Cancel
              </button>
            )}
          </div>
        </div>
      </form>
    </section>
  );
}

function StageRail({ project }: { project: Project }) {
  const at = stageIndex(project);
  const stages = stagesFor(project);
  return (
    <ol className="ticket-track" aria-label="Progress" style={{ "--steps": stages.length } as CSSProperties}>
      {stages.map((s, i) => (
        <li
          key={s.key}
          data-step={i < at ? "past" : i === at ? "current" : "later"}
          aria-current={i === at ? "step" : undefined}
        >
          <span className="measured">{i + 1}</span>
          <span>{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

function inputHint(p: Project, agentBusy: boolean): string | null {
  if (agentBusy) return "Waiting for the agent…";
  if (needsPlan(p) || needsDesign(p)) return "Waiting for the agent…";
  if (p.stage === "done") return "Handed over. This prototype is read-only.";
  if (p.stage === "setup") return "Setting up…";
  if (p.pendingChange) return "Choose what kind of change this is first.";
  return null;
}

function inputPlaceholder(p: Project): string {
  if (p.stage === "interview") {
    if (isLive(p)) return p.prdText ? "Anything wrong with the PRD?" : "Your answer";
    return p.interviewStep < QUESTIONS.length ? "Your answer" : "Anything wrong with the summary?";
  }
  if (p.stage === "show" && p.previewShared && p.demoStep < DEMO_QUESTIONS.length) return "Your answer";
  if (p.stage === "build") return "Ask for a change";
  if (p.stage === "prototype") return "Ask for a change to the prototype";
  if (p.stage === "show") return "Ask for a change before you show it";
  return "Leave a note for engineering";
}

function SessionPane(props: { builder: Builder; project: Project; onNew: () => void }) {
  const { builder, project } = props;
  const [draft, setDraft] = useState("");
  // Deleting cannot be undone in the app, so it takes a second click.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const agentTask = useAgentTurn(builder, project);
  const agentBusy = agentTask !== null;
  const blockedReason = inputHint(project, agentBusy);
  const interviewer = agentById(project.interviewAgent);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [project.id, project.messages.length, agentBusy, project.agentError]);

  function send() {
    if (!draft.trim() || blockedReason) return;
    builder.update((p) => userSays(p, draft));
    setDraft("");
  }

  return (
    <section className="pane pane--list builder-session" aria-label="Session">
      <div className="pane-header">
        <h1>Prototypes</h1>
        <div className="action-group">
          {confirmDelete ? (
            <>
              <button type="button" className="btn btn--danger" onClick={() => builder.remove(project.id)}>
                Delete {project.name}
              </button>
              <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn" onClick={() => setConfirmDelete(true)}>
                Delete
              </button>
              <button type="button" className="btn" onClick={props.onNew}>
                New
              </button>
            </>
          )}
        </div>
      </div>

      <ul className="builder-projects" aria-label="Prototypes">
        {builder.projects.map((p) => {
          const current = p.id === project.id;
          return (
            <li key={p.id}>
              <button
                type="button"
                className="ticket-row"
                data-selected={current || undefined}
                aria-current={current || undefined}
                onClick={() => builder.select(p.id)}
              >
                <span className="ticket-row-top">
                  <span className="agents-name">{p.name}</span>
                  <span className="builder-project-stage">
                    {p.stage === "done" ? "Handed over" : stagesFor(p)[stageIndex(p)]?.label}
                  </span>
                </span>
                <span className="ticket-row-title">For {p.client}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <p className="builder-standin" role="note">
        {interviewer
          ? `Interview and prototype by ${interviewer.label}. Building the real app here is still simulated.`
          : "Stand-in agent: scripted replies, no code is generated yet."}
      </p>

      <div className="chat-log" role="log" aria-live="polite">
        {project.messages.map((m, i) => (
          <div key={i} className="chat-msg" data-from={m.from}>
            {/* Notes are events in the log, not a speaker: no name on them. */}
            {m.from !== "system" && (
              <span className="chat-who">{m.from === "user" ? "You" : (interviewer?.label ?? "Agent")}</span>
            )}
            <p className="chat-text">{m.text}</p>
          </div>
        ))}
        {agentBusy && (
          <div className="chat-msg" data-from="system" role="status">
            <p className="chat-text">
              {interviewer?.label ?? "The agent"} is{" "}
              {agentTask === "plan" ? "planning the steps" : agentTask === "design" ? "making the prototype" : "thinking"}…
            </p>
          </div>
        )}
        {project.agentError && !agentBusy && (
          <div className="chat-error" role="alert">
            <p className="chat-text">
              The agent could not {failedTask(project)}: {project.agentError}
            </p>
            <div className="action-group">
              <button type="button" className="btn" onClick={() => builder.update(retryAgent)}>
                Try again
              </button>
              {project.stage === "plan" && (
                <button type="button" className="btn" onClick={() => builder.update(planWithRules)}>
                  Continue without the agent’s plan
                </button>
              )}
              {project.stage === "prototype" && project.designHtml && (
                <button type="button" className="btn" onClick={() => builder.update(keepDesign)}>
                  Keep the prototype as it is
                </button>
              )}
            </div>
          </div>
        )}
        {project.pendingChange && (
          <div className="chat-choice" role="group" aria-label="Kind of change">
            <button type="button" className="btn" onClick={() => builder.update((p) => resolveChange(p, "tweak"))}>
              Small fix
            </button>
            <button type="button" className="btn" onClick={() => builder.update((p) => resolveChange(p, "new"))}>
              Something new
            </button>
            <button type="button" className="btn" onClick={() => builder.update((p) => resolveChange(p, "later"))}>
              Save for later
            </button>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <div className="chat-composer">
        <textarea
          className="chat-box"
          rows={2}
          value={draft}
          disabled={!!blockedReason}
          placeholder={blockedReason ?? inputPlaceholder(project)}
          aria-label="Message"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="chat-composer-foot">
          <span className="chat-composer-hint">⌘ Enter to send</span>
          <button type="submit" className="btn btn--primary" disabled={!!blockedReason || !draft.trim()}>
            Send
          </button>
        </div>
        </div>
      </form>
    </section>
  );
}

interface PrimaryAction {
  label: string;
  run?: (p: Project) => Project;
  /** Why the button is disabled, in the user's terms. */
  blocked?: string;
}

/** The single primary action for the current stage, and what is holding it back. */
function primaryAction(p: Project): PrimaryAction | null {
  const story = currentStory(p);
  switch (p.stage) {
    case "interview":
      return awaitingApproval(p)
        ? { label: "Approve PRD", run: approvePrd }
        : {
            label: "Approve PRD",
            blocked: isLive(p)
              ? p.prdText
                ? "Wait for the agent to finish the PRD"
                : "The agent writes the PRD once it has what it needs"
              : `Answer the questions first (${answeredCount(p)} of ${QUESTIONS.length})`,
          };
    case "prototype": {
      if (canFinishPrototype(p)) return { label: "Ready to show the client", run: finishPrototype };
      const left = linesLeft(p);
      return {
        label: "Ready to show the client",
        blocked: p.agentError
          ? "The agent could not make the prototype. Try again in the chat."
          : !p.designHtml
            ? "The agent is making the prototype"
            : p.designPending
              ? "The agent is changing the prototype"
              : `Try each step and tick what is true (${left} line${left === 1 ? "" : "s"} left)`,
      };
    }
    case "plan": {
      const blocked = blockedStories(p);
      if (p.planned === "no") {
        return {
          label: "Start set up",
          blocked: p.agentError ? "The agent could not plan the steps. Try again in the chat." : "The agent is planning the steps",
        };
      }
      return canStartSetup(p)
        ? { label: "Start set up", run: startSetup }
        : { label: "Start set up", blocked: `${blocked.map((s) => s.id).join(", ")} must be cleared by an engineer or moved to later` };
    }
    case "setup":
      return { label: "Setting up…", blocked: "Wait for set up to finish" };
    case "build":
      if (!story) return null;
      if (p.pendingChange) return { label: `Build ${story.id}`, blocked: "Choose what kind of change this is first" };
      if (story.status === "todo") {
        return story.needsEngineer && !story.engineerCleared
          ? { label: `Build ${story.id}`, blocked: `${story.id} must be cleared by an engineer or moved to later` }
          : { label: `Build ${story.id}`, run: buildCurrentStory };
      }
      return canConfirmStory(p)
        ? { label: `Confirm ${story.id}`, run: confirmStory }
        : { label: `Confirm ${story.id}`, blocked: "Tick each line that is true in the preview" };
    case "show":
      return p.previewShared
        ? { label: "Hand over to engineering", blocked: "Answer the after-demo questions first" }
        : { label: "I have shown it to the client", run: sharePreview };
    case "handover":
      return canHandOver(p)
        ? { label: "Hand over to engineering", run: handOver }
        : { label: "Hand over to engineering", blocked: "Standards checks must pass first" };
    case "done":
      return null;
  }
}

function InspectorPane({ builder, project }: { builder: Builder; project: Project }) {
  const [tab, setTab] = useState<Tab>("steps");

  // A new or revised design is the thing to look at, so bring it forward.
  const hadDesign = useRef(project.designHtml);
  useEffect(() => {
    if (project.designHtml && project.designHtml !== hadDesign.current && project.stage === "prototype") setTab("preview");
    hadDesign.current = project.designHtml;
  }, [project.designHtml, project.stage]);
  const [setupAt, setSetupAt] = useState(0);
  const action = primaryAction(project);
  const confirmedCount = project.stories.filter((s) => s.status === "confirmed").length;

  // Set up runs by itself once started; the gate to Build is the checks passing.
  useEffect(() => {
    if (project.stage !== "setup") {
      setSetupAt(0);
      return;
    }
    if (setupAt >= SETUP_STEPS.length) {
      builder.update(finishSetup);
      return;
    }
    const timer = setTimeout(() => setSetupAt((n) => n + 1), SETUP_STEP_MS);
    return () => clearTimeout(timer);
  }, [project.stage, setupAt]);

  return (
    <section className="pane pane--detail ticket-detail builder-inspector" aria-label="Prototype">
      {/* One quiet line of text: who it is for and what it runs on. No boxes. */}
      <div className="ticket-head builder-head">
        <span>For {project.client}</span>
        <div className="builder-head-tools">
          {project.building ? (
            <span role="status" data-ok={project.checksPassing || undefined}>
              Standards {project.checksPassing ? "passing" : "not run yet"}
            </span>
          ) : (
            <span role="status">Made-up data only</span>
          )}
        </div>
      </div>
      <h2 className="ticket-title">{project.name}</h2>

      <div className="builder-gates">
        <StageRail project={project} />
        <div className="builder-primary">
          {action && (
            <button
              type="button"
              className="btn btn--primary"
              disabled={!action.run}
              onClick={() => {
                if (!action.run) return;
                const next = action.run(project);
                builder.update(action.run);
                // Approval changes the document, so the saved prd.md is brought in line.
                if (project.prdText && !project.prdApproved && next.prdApproved) {
                  const id = project.id;
                  builderSavePrd({ projectId: id, projectName: project.name, content: prdMarkdown(next) })
                    .then((path) => builder.updateById(id, (p) => ({ ...p, prdPath: path })))
                    .catch(() => undefined);
                }
                // The handover goes in the prototype's folder, beside the PRD and the prototype.
                if (!project.handover && next.handover) {
                  void builderSavePrd({
                    projectId: project.id,
                    projectName: project.name,
                    content: next.handover,
                    file: "handover.md",
                  }).catch(() => undefined);
                }
              }}
            >
              {action.label}
            </button>
          )}
          {action?.blocked && <span className="field-help">{action.blocked}</span>}
          {project.stage === "done" && <span className="chip chip--ok">Handed over</span>}
        </div>
      </div>

      <FilterTabs<Tab>
        label="Inspector"
        value={tab}
        onChange={setTab}
        options={[
          { value: "steps", label: "Steps", count: project.stories.length },
          { value: "preview", label: "Preview", count: confirmedCount },
          { value: "prd", label: "PRD", count: project.openQuestions.length },
          { value: "record", label: "Record", count: project.log.length },
        ]}
      />

      <div className="builder-body">
        {tab === "steps" && <StepsTab builder={builder} project={project} setupAt={setupAt} />}
        {tab === "preview" && <PreviewTab project={project} />}
        {tab === "prd" && <PrdTab builder={builder} project={project} />}
        {tab === "record" && <RecordTab project={project} />}
      </div>

      {(canChooseBuild(project) || canUndo(project) || project.stage !== "done") && (
        <div className="action-bar builder-actions">
          <div className="action-group">
            {canChooseBuild(project) && (
              <button
                type="button"
                className="btn"
                title="For engineers: build the real app from the PRD and the prototype, in this same prototype"
                onClick={() => {
                  builder.update(chooseBuild);
                  setTab("steps");
                }}
              >
                Build it here
              </button>
            )}
            {canUndo(project) && (
              <button type="button" className="btn" onClick={() => builder.update(undoLastStep)}>
                Undo last step
              </button>
            )}
            {project.stage !== "done" && (
              <button type="button" className="btn" onClick={() => builder.update(askEngineer)}>
                Ask an engineer
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function StepsTab(props: { builder: Builder; project: Project; setupAt: number }) {
  const { builder, project } = props;
  const current = currentStory(project);

  if (project.stories.length === 0) {
    return (
      <div className="builder-empty">
        <strong>No steps yet</strong>
        <p className="builder-lead">
          The steps come from your walkthrough. Answer the interview questions and they will
          appear here.
        </p>
      </div>
    );
  }

  return (
    <>
      {project.stage === "setup" && (
        <ul className="builder-rows" aria-label="Set up">
          {SETUP_STEPS.map((step, i) => (
            <li key={step} className="builder-row">
              <span className={`chip ${i < props.setupAt ? "chip--ok" : ""}`}>
                {i < props.setupAt ? "done" : i === props.setupAt ? "working" : "waiting"}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ul>
      )}

      {project.building && (
        <div className="assign-bar">
          <div className="filter-tabs" role="group" aria-label="Who picks the agent">
            {(["autopilot", "manual"] as AssignMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                className="filter-tab"
                aria-pressed={project.assignMode === mode}
                disabled={project.stage === "done"}
                onClick={() => builder.update((p) => setAssignMode(p, mode))}
              >
                {mode === "autopilot" ? "Autopilot" : "Assign by hand"}
              </button>
            ))}
          </div>
          <span className="field-help">
            {project.assignMode === "autopilot"
              ? "The orchestrator gives hard steps to the lead agent and small ones to a worker."
              : "Pick an agent per step. Steps left on Auto follow the orchestrator."}
          </span>
        </div>
      )}

      <ul className="builder-rows" aria-label="Steps">
        {project.stories.map((story) => (
          <StoryRow
            key={story.id}
            builder={builder}
            story={story}
            project={project}
            onAssign={(agentId) => builder.update((p) => assignStory(p, story.id, agentId))}
            isCurrent={project.stage === "build" && story.id === current?.id}
            canMove={
              (project.stage === "plan" || project.stage === "build") &&
              story.status !== "confirmed" &&
              project.stories.length > 1
            }
            canClear={project.building && project.stage !== "done"}
            onToggle={(i) => builder.update((p) => toggleCriterion(p, story.id, i))}
            onClear={() => builder.update((p) => clearStory(p, story.id))}
            onLater={() => builder.update((p) => moveStoryToLater(p, story.id))}
          />
        ))}
      </ul>

      {project.later.length > 0 && (
        <div className="builder-later">
          <span className="field-label">Later, not part of this prototype</span>
          <ul className="builder-plain-list">
            {project.later.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function StoryRow(props: {
  builder: Builder;
  story: Story;
  project: Project;
  onAssign: (agentId: string | null) => void;
  isCurrent: boolean;
  canMove: boolean;
  canClear: boolean;
  onToggle: (index: number) => void;
  onClear: () => void;
  onLater: () => void;
}) {
  const { story, project } = props;
  const planned = agentFor(project, story);
  const builtBy = story.status === "todo" ? null : agentById(story.builtBy);
  const canAssign =
    project.assignMode === "manual" && story.status !== "confirmed" && project.stage !== "done";
  const flagged = project.building && story.needsEngineer && !story.engineerCleared;
  const tickable = canTick(project, story);
  const allTicked = story.criteria.every((c) => c.done);
  // Before the real build, a step is something to check against the prototype.
  const label = !project.building
    ? project.stage === "interview"
      ? "planned"
      : allTicked
        ? "checked"
        : "to check"
    : story.status === "confirmed"
      ? "confirmed"
      : story.status === "built"
        ? "check it"
        : flagged
          ? "needs engineer"
          : "to do";
  const tone = !project.building
    ? allTicked && project.stage !== "interview"
      ? "chip--ok"
      : ""
    : story.status === "confirmed"
      ? "chip--ok"
      : flagged
        ? "chip--bad"
        : story.status === "built"
          ? "chip--person"
          : "";
  const showLines = project.building ? story.status !== "todo" : project.stage !== "interview";

  return (
    <li className="story-item" data-current={props.isCurrent || undefined}>
      <div className="record-top">
        <span className="measured-ink">{story.id}</span>
        <span className={`chip ${tone}`}>{label}</span>
      </div>
      <span className="record-title">{story.title}</span>

      {project.building && (
      <div className="story-agent">
        <span className="chip">{story.size === "hard" ? "hard step" : "small step"}</span>
        {canAssign ? (
          <>
            <select
              className="input-field story-agent-pick"
              aria-label={`Agent for ${story.id}`}
              value={story.assignedTo ?? ""}
              onChange={(e) => props.onAssign(e.target.value || null)}
            >
              <option value="">Auto</option>
              {allAgents().map((a) => agentById(a.id) ?? a).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                  {a.model ? `, ${a.model}` : ""}
                </option>
              ))}
            </select>
            {story.assignedTo && (
              <ModelPick builder={props.builder} agentId={story.assignedTo} className="story-agent-pick" />
            )}
          </>
        ) : (
          <span className="chip chip--instrument">
            {builtBy ? `built by ${builtBy.label}` : planned.agent.label}
          </span>
        )}
        {!builtBy && (
          <span className="field-help">{planned.byHand ? "assigned by hand" : "picked by the orchestrator"}</span>
        )}
      </div>
      )}
      {story.note && <p className="story-note">{story.note}</p>}

      {showLines && (
        <ul className="criteria-list">
          {story.criteria.map((c, i) => (
            <li key={i}>
              <label className="criterion">
                <input
                  type="checkbox"
                  checked={c.done}
                  disabled={!tickable}
                  onChange={() => props.onToggle(i)}
                />
                <span>{c.text}</span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {(flagged || props.canMove) && (
        <div className="action-group">
          {flagged && props.canClear && (
            <button
              type="button"
              className="btn"
              title="Stand-in: in the connected app this comes from an engineer, not from you"
              onClick={props.onClear}
            >
              Engineer cleared it
            </button>
          )}
          {props.canMove && (
            <button type="button" className="btn" onClick={props.onLater}>
              Move to later
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function PreviewTab({ project }: { project: Project }) {
  const shown = project.stories.filter((s) => s.status !== "todo");
  if (project.designHtml) {
    return (
      <>
        <span className="field-help">
          {project.stage === "prototype"
            ? "Your prototype. It works on made-up data and resets when reopened. Try each step, then tick it in the Steps tab."
            : "The prototype the client was shown. It is one file that opens in any browser."}
          {project.designPath ? ` Saved to ${project.designPath}` : ""}
        </span>
        {/*
          Scripts and form events only. Without same-origin the frame cannot reach the app or
          any storage, and the policy added by lockedDesign blocks the network and real submits.
        */}
        <iframe
          className="design-frame"
          title="Prototype"
          sandbox="allow-scripts allow-forms"
          srcDoc={lockedDesign(project.designHtml)}
        />
      </>
    );
  }
  return (
    <div className="builder-empty">
      <strong>The prototype appears here</strong>
      <p className="builder-lead">
        It is made once you approve the PRD: one working page on made-up data that you can try
        step by step and then show to the client.
      </p>
      {shown.length > 0 && (
        <ul className="builder-plain-list">
          {shown.map((s) => (
            <li key={s.id}>
              <span className="measured-ink">{s.id}</span> {s.title}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PrdTab({ builder, project }: { builder: Builder; project: Project }) {
  if (isLive(project) ? !project.prdText : answeredCount(project) === 0) {
    return (
      <div className="builder-empty">
        <strong>No PRD yet</strong>
        <p className="builder-lead">It is written from your answers to the interview.</p>
      </div>
    );
  }
  return (
    <>
      {project.prdPath && <span className="field-help">Saved to {project.prdPath}</span>}
      <pre className="doc-view">{prdMarkdown(project)}</pre>
      {project.stage === "interview" && !isLive(project) && !project.prdText && (
        <div className="action-group">
          <button type="button" className="btn" onClick={() => builder.update(redoInterview)}>
            Redo the interview
          </button>
        </div>
      )}
    </>
  );
}

function RecordTab({ project }: { project: Project }) {
  return (
    <>
      <div className="trail-list">
        {project.log.map((entry, i) => (
          <div key={i} className="trail-row builder-trail">
            <span className="measured">{new Date(entry.at).toLocaleString()}</span>
            <span className="chip">{entry.kind}</span>
            <span>{entry.text}</span>
          </div>
        ))}
      </div>
      {project.handover && <pre className="doc-view">{project.handover}</pre>}
    </>
  );
}
