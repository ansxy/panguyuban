/**
 * Guided builder: the flow a non-technical user follows from an idea to a
 * handed-over prototype. See docs/superpowers/specs/…-guided-builder-design.md.
 *
 * This file owns the flow rules (stages and their gates) and the record.
 * The agent is a scripted stand-in: it asks the interview questions and walks
 * the stages, but generates no code. The functions here are pure so the same
 * rules can move into panguyuban-core once an agent runtime is connected.
 */

export type Stage =
  | "interview"
  | "prototype"
  | "show"
  | "handover"
  | "plan"
  | "setup"
  | "build"
  | "done";

/** Every prototype goes through these. */
const BASE_STAGES: { key: Stage; label: string }[] = [
  { key: "interview", label: "Interview" },
  { key: "prototype", label: "Prototype" },
  { key: "show", label: "Show" },
];
/** Only when someone chooses to build the real app here. */
const BUILD_STAGES: { key: Stage; label: string }[] = [
  { key: "plan", label: "Plan" },
  { key: "setup", label: "Set up" },
  { key: "build", label: "Build" },
];
const HANDOVER_STAGE = { key: "handover" as Stage, label: "Hand over" };

/** The stages this prototype goes through, in order. Hand over is always last. */
export function stagesFor(p: Project): { key: Stage; label: string }[] {
  return [...BASE_STAGES, ...(p.building ? BUILD_STAGES : []), HANDOVER_STAGE];
}

/** Position of the current stage in `stagesFor`, or one past the end when handed over. */
export function stageIndex(p: Project): number {
  const stages = stagesFor(p);
  if (p.stage === "done") return stages.length;
  // Before the build is chosen, Hand over follows Show; once it is, it comes after Build.
  if (p.stage === "handover" && p.building && !p.built) return BASE_STAGES.length;
  return stages.findIndex((s) => s.key === p.stage);
}

export interface Message {
  from: "agent" | "user" | "system";
  text: string;
  at: number;
  /** The PRD the agent sent with this message, if any. */
  prd?: string;
}

export interface Criterion {
  text: string;
  done: boolean;
}

export type StoryStatus = "todo" | "built" | "confirmed";

export type Tier = "lead" | "worker";

/** One agent the orchestrator can hand work to. Mirrors [[agent]] in skills/registry.toml. */
export interface AgentDef {
  id: string;
  label: string;
  harness: "claude" | "antigravity";
  model: string | null;
  tier: Tier;
}

export const AGENTS: AgentDef[] = [
  { id: "claude-lead", label: "Claude lead", harness: "claude", model: "claude-opus-5-5", tier: "lead" },
  { id: "claude-worker", label: "Claude worker", harness: "claude", model: "claude-sonnet-5-5", tier: "worker" },
  { id: "antigravity-worker", label: "Antigravity worker", harness: "antigravity", model: null, tier: "worker" },
];

/** Plans, splits, hands off and reviews. Mirrors [orchestrator] in skills/registry.toml. */
export const ORCHESTRATOR_ID = "claude-lead";

/** Autopilot: the orchestrator picks an agent per step. Manual: the user picks. */
export type AssignMode = "autopilot" | "manual";

export type StorySize = "hard" | "small";

export interface Story {
  id: string;
  title: string;
  criteria: Criterion[];
  status: StoryStatus;
  /** Touches something an engineer must agree to (real system, sign-in, real data). */
  needsEngineer: boolean;
  engineerCleared: boolean;
  /** The orchestrator's estimate; decides lead or worker on autopilot. */
  size: StorySize;
  /** Agent id chosen by hand, or null to leave it to the orchestrator. */
  assignedTo: string | null;
  /** Agent id that last built this step. */
  builtBy: string | null;
  /** Why the planner sized or flagged the step this way, in the user's terms. */
  note: string;
}

export interface LogEntry {
  at: number;
  kind: "start" | "prd" | "scope" | "build" | "undo" | "engineer" | "show" | "handover" | "agents" | "design";
  text: string;
}

export interface PendingChange {
  text: string;
}

export interface Project {
  id: string;
  name: string;
  client: string;
  author: string;
  createdAt: number;
  stage: Stage;
  assignMode: AssignMode;
  messages: Message[];
  /** What the user wrote when starting, if anything. The PRD is drafted from it first. */
  description: string;
  /** Agent id running the interview for real, or null for the scripted stand-in. */
  interviewAgent: string | null;
  /** The PRD as the agent wrote it (live interviews only). */
  prdText: string | null;
  /** Where prd.md was saved on this machine. */
  prdPath: string | null;
  /** Why the last agent turn failed, until the user retries. */
  agentError: string | null;
  /** How the steps were sized: not yet, by the agent, or by the built-in keyword rules. */
  planned: "no" | "agent" | "rules";
  /** The HTML mock-up of the screens, once proposed. */
  designHtml: string | null;
  /** Where design.html was saved on this machine. */
  designPath: string | null;
  /** Changes the user asked for on the design, oldest first. */
  designChanges: string[];
  /** The agent owes a design: the first proposal, or a revision after a change request. */
  designPending: boolean;
  /** "approved" by the user, "skipped" when the agent could not produce one, or "no" before either. */
  designStatus: "no" | "approved" | "skipped";
  /** Index of the interview question being asked; QUESTIONS.length = all answered. */
  interviewStep: number;
  answers: Record<string, string>;
  prdApproved: boolean;
  stories: Story[];
  later: string[];
  openQuestions: string[];
  checksPassing: boolean;
  previewShared: boolean;
  /** Index of the after-demo question being asked; DEMO_QUESTIONS.length = all answered. */
  demoStep: number;
  demoAnswers: Record<string, string>;
  pendingChange: PendingChange | null;
  /** Someone chose to build the real app here, instead of only handing the prototype over. */
  building: boolean;
  /** Every step of the real app is built and confirmed. */
  built: boolean;
  log: LogEntry[];
  handover: string | null;
}

export const LIBRARY_VERSION = "0.2.0";

interface Question {
  key: string;
  /** How the agent refers to this topic when saying what it already has. */
  topic: string;
  ask: (p: Project) => string;
}

export const QUESTIONS: Question[] = [
  {
    key: "occasion",
    topic: "the occasion",
    ask: (p) =>
      `Let's work out what to show ${p.client}. First: what is the meeting or demo, and when is it?`,
  },
  {
    key: "problem",
    topic: "the problem",
    ask: (p) => `What is ${p.client} trying to do, decide or fix? Why now?`,
  },
  {
    key: "people",
    topic: "who uses it",
    ask: () =>
      "Who will use this? Give me their roles, not names, and what each one is trying to get done.",
  },
  {
    key: "walkthrough",
    topic: "the steps to show",
    ask: () =>
      "Walk me through what you will click in front of the client, from start to end. One step per line.",
  },
  {
    key: "information",
    topic: "the information shown",
    ask: () =>
      "What information appears on those screens? Lists, numbers, statuses, forms.",
  },
  {
    key: "real",
    topic: "what is real or pretend",
    ask: () =>
      "Which parts must really work in the demo, and which only need to look like they work?",
  },
  {
    key: "later",
    topic: "what to leave for later",
    ask: () =>
      "Is there anything you'd like eventually that this demo does not need? One per line. I'll park it under “later” so it isn't built now.",
  },
  {
    key: "promises",
    topic: "promises already made",
    ask: (p) => `Has anything already been promised to ${p.client} about this?`,
  },
];

export const DEMO_QUESTIONS: Question[] = [
  { key: "reaction",
    topic: "the reaction", ask: (p) => `How did it go? What did ${p.client} react to most?` },
  { key: "promised",
    topic: "what was promised", ask: () => "What was promised in the room, including dates?" },
  { key: "next",
    topic: "what comes next", ask: () => "What did they ask for next?" },
];

const ENGINEER_HINTS =
  /\b(real|live|production|integrat\w*|api|sign[- ]?in|log[- ]?in|login|sso|payment|pay|e-?mail|sms|whatsapp|upload|import|export|bpjs)\b/i;
const HARD_HINTS =
  /\b(history|timeline|report|dashboard|chart|graph|calculat\w*|approv\w*|workflow|rules?|search|compare|schedule|notif\w*|permission\w*|roles?)\b/i;
const REAL_DATA_HINTS =
  /\b(real|actual|live|production|asli)\b[^.\n]{0,24}\b(data|records?|patients?|members?|claims?|policy\w*)\b/i;

const now = () => Date.now();

function say(p: Project, from: Message["from"], text: string): Project {
  return { ...p, messages: [...p.messages, { from, text, at: now() }] };
}

function record(p: Project, kind: LogEntry["kind"], text: string): Project {
  return { ...p, log: [...p.log, { at: now(), kind, text }] };
}

function splitLines(text: string): string[] {
  const rough = text.includes("\n") ? text.split("\n") : text.split(/;|\bthen\b|→|->/i);
  return rough
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
}

const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)])\s+/;
const LABELS: [RegExp, string][] = [
  [/^(occasion|demo|meeting|when|date|deadline)$/i, "occasion"],
  [/^(problem|why|goal|background|context)$/i, "problem"],
  [/^(users?|people|roles?|who|audience)$/i, "people"],
  [/^(steps?|flow|walkthrough|screens?|pages?|features?|must[- ]haves?)$/i, "walkthrough"],
  [/^(data|information|info|fields?)$/i, "information"],
  [/^(real|pretend|mock(ed)?|fake|real or pretend)$/i, "real"],
  [/^(later|not now|out of scope|nice to have|phase 2)$/i, "later"],
  [/^(promises?|promised|commitments?)$/i, "promises"],
];
const OCCASION_WORD = /\b(demo|meeting|presentation|pitch|review|workshop)\b/i;
const DATE_WORD =
  /\b(\d{1,2}\s*(jan|feb|mar|apr|may|mei|jun|jul|aug|agu|sep|oct|okt|nov|dec|des)\w*|(mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|next week|next month|besok|minggu depan|bulan depan)\b/i;

/**
 * Reads what it can from a free-text description: labelled lines ("Users: …"),
 * a list of steps, and the rest as the problem. Stand-in for the agent reading
 * the description; it only takes what is plainly there and asks for the rest.
 */
export function readDescription(text: string): Record<string, string> {
  const found: Record<string, string[]> = {};
  const prose: string[] = [];
  const add = (key: string, value: string) => {
    if (value.trim()) (found[key] ??= []).push(value.trim());
  };
  let current: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      current = null;
      continue;
    }
    const colon = line.indexOf(":");
    const label = colon > 0 && colon <= 30 ? line.slice(0, colon).replace(LIST_ITEM, "").trim() : "";
    const key = label ? LABELS.find(([re]) => re.test(label))?.[1] : undefined;
    if (key) {
      current = key;
      add(key, line.slice(colon + 1));
    } else if (LIST_ITEM.test(line)) {
      add(current && current !== "problem" ? current : "walkthrough", line.replace(LIST_ITEM, ""));
    } else if (current) {
      add(current, line);
    } else {
      prose.push(line.trim());
    }
  }
  const answers: Record<string, string> = {};
  for (const [key, lines] of Object.entries(found)) answers[key] = lines.join("\n");
  if (!answers.problem && prose.length) answers.problem = prose.join(" ");
  if (!answers.occasion) {
    const sentence = prose
      .join(" ")
      .split(/(?<=[.!?])\s+/)
      .find((part) => OCCASION_WORD.test(part) && DATE_WORD.test(part));
    if (sentence) answers.occasion = sentence;
  }
  return answers;
}

/** Index of the first interview question that has no answer yet. */
function nextUnanswered(answers: Record<string, string>): number {
  const index = QUESTIONS.findIndex((q) => !answers[q.key]);
  return index === -1 ? QUESTIONS.length : index;
}

export function answeredCount(p: Project): number {
  return QUESTIONS.filter((q) => p.answers[q.key]).length;
}

function toStory(index: number, title: string): Story {
  return {
    id: `S${index + 1}`,
    title,
    criteria: [
      { text: `The client can see: ${title}`, done: false },
      { text: "It shows made-up sample data only", done: false },
    ],
    status: "todo",
    needsEngineer: ENGINEER_HINTS.test(title),
    engineerCleared: false,
    size: ENGINEER_HINTS.test(title) || HARD_HINTS.test(title) ? "hard" : "small",
    assignedTo: null,
    builtBy: null,
    note: "",
  };
}

export function createProject(
  name: string,
  client: string,
  author: string,
  description = "",
  interviewAgent: string | null = null
): Project {
  const base: Project = {
    id: `p${now().toString(36)}`,
    name: name.trim(),
    client: client.trim(),
    author: author.trim() || "you",
    createdAt: now(),
    stage: "interview",
    assignMode: "autopilot",
    messages: [],
    description: description.trim(),
    interviewAgent: agentById(interviewAgent) ? interviewAgent : null,
    prdText: null,
    prdPath: null,
    agentError: null,
    planned: "no",
    designHtml: null,
    designPath: null,
    designChanges: [],
    designPending: false,
    designStatus: "no",
    interviewStep: 0,
    answers: {},
    prdApproved: false,
    stories: [],
    later: [],
    openQuestions: [],
    checksPassing: false,
    previewShared: false,
    demoStep: 0,
    demoAnswers: {},
    pendingChange: null,
    building: false,
    built: false,
    log: [],
    handover: null,
  };
  const started = record(
    base,
    "start",
    `Prototype “${base.name}” for ${base.client} started by ${base.author}. Engineering notified.`
  );
  const told = say(
    started,
    "system",
    "Engineering has been told this prototype exists. They only need to act if a step needs them."
  );
  // The user brought a finished PRD: use it as it is. No interview, but it still needs approving.
  if (looksLikePrd(told.description)) {
    const prd = told.description.replace(/^Status:.*$/m, "Status: Draft");
    let next: Project = {
      ...told,
      interviewStep: QUESTIONS.length,
      messages: [...told.messages, { from: "user", text: "I already have a PRD for this prototype.", at: now(), prd }],
    };
    next = applyPrd(next, prd, null);
    const steps = `${next.stories.length} step${next.stories.length === 1 ? "" : "s"}`;
    next = record(next, "prd", `PRD provided by ${next.author} (${steps}).`);
    return say(
      next,
      "system",
      `Using the PRD you provided: ${steps}. Check it in the PRD tab, then approve it or say what should change.`
    );
  }

  // A real agent runs the interview: it speaks first, after reading the description if there is one.
  if (told.interviewAgent) return told.description ? say(told, "user", told.description) : told;

  if (!told.description) return say(told, "agent", QUESTIONS[0].ask(told));

  // The user wrote a description up front: draft from it and ask only for the gaps.
  const answers = readDescription(told.description);
  const step = nextUnanswered(answers);
  let next: Project = say({ ...told, answers, interviewStep: step }, "user", told.description);
  const have = QUESTIONS.filter((q) => answers[q.key]).map((q) => q.topic);
  const missing = QUESTIONS.length - have.length;
  if (missing === 0) {
    return draftPrd(say(next, "agent", "Thanks, that covers everything I need. I have written the PRD from it."));
  }
  next = say(
    next,
    "agent",
    have.length
      ? `Thanks. From what you wrote I have ${have.join(", ")}. I still need ${missing} more thing${missing === 1 ? "" : "s"}.`
      : "Thanks. I could not pick the details out of that, so I will ask a few questions."
  );
  return say(next, "agent", QUESTIONS[step].ask(next));
}

/** The interview is run by a real agent, not the scripted stand-in. */
export function isLive(p: Project): boolean {
  return p.interviewAgent !== null;
}

/** It is the agent's turn to speak in a live interview. */
export function needsAgentTurn(p: Project): boolean {
  if (!isLive(p) || p.stage !== "interview" || p.agentError) return false;
  const spoken = p.messages.filter((m) => m.from !== "system");
  const last = spoken[spoken.length - 1];
  // A PRD the user brought needs no reply; the agent only joins if they ask for a change.
  return !last || (last.from === "user" && !last.prd);
}

/** The conversation as the agent receives it. Only the latest PRD is sent back in full. */
export function transcriptFor(p: Project): { from: "agent" | "user"; text: string }[] {
  const spoken = p.messages.filter((m) => m.from !== "system");
  const lastPrd = spoken.map((m) => !!m.prd).lastIndexOf(true);
  return spoken.map((m, i) => ({
    from: m.from as "agent" | "user",
    text: !m.prd
      ? m.text
      : i === lastPrd
        ? `${m.text}\n\n<prd>\n${m.prd}\n</prd>`
        : `${m.text}\n\n[An earlier PRD draft was here.]`,
  }));
}

/** Body of each numbered `## N. Title` section of a PRD. */
function prdSections(markdown: string): Record<string, string> {
  const out: Record<string, string> = {};
  const parts = markdown.split(/^## +(\d+)\.[^\n]*$/m);
  for (let i = 1; i < parts.length; i += 2) out[parts[i]] = (parts[i + 1] ?? "").trim();
  return out;
}

function bulletsUnder(section: string, heading: RegExp): string[] {
  const start = section.search(heading);
  if (start === -1) return [];
  const body = section.slice(start).split("\n").slice(1);
  const end = body.findIndex((line) => /^#{2,4} /.test(line));
  return (end === -1 ? body : body.slice(0, end))
    .map((line) => line.match(/^\s*[-*]\s+(.*\S)\s*$/)?.[1] ?? "")
    .filter((item) => item && !/^(none|nothing|-)\.?$/i.test(item));
}

/** Whether a pasted text is already a PRD in the library's format (numbered sections, S1/S2 steps). */
export function looksLikePrd(text: string): boolean {
  return storiesFromPrd(text).length > 0;
}

/** Reads the steps and their acceptance lines out of a PRD. */
export function storiesFromPrd(markdown: string): Story[] {
  const section = prdSections(markdown)["4"] ?? "";
  const parts = section.split(/^### +S\d+[.:]?\s*(.*)$/m);
  const stories: Story[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const title = parts[i].trim();
    const criteria = [...(parts[i + 1] ?? "").matchAll(/^\s*[-*]\s+\[[ xX]\]\s+(.*\S)\s*$/gm)].map((m) => ({
      text: m[1],
      done: false,
    }));
    if (!title) continue;
    const story = toStory(stories.length, title);
    stories.push(criteria.length ? { ...story, criteria } : story);
  }
  return stories;
}

function applyPrd(p: Project, markdown: string, path: string | null): Project {
  const sections = prdSections(markdown);
  const clean = (text: string | undefined) => (text ?? "").replace(/^<[^>\n]*>$/gm, "").trim();
  return {
    ...p,
    prdText: markdown,
    prdPath: path ?? p.prdPath,
    stories: storiesFromPrd(markdown),
    later: bulletsUnder(sections["5"] ?? "", /^### +Later\b/m),
    answers: {
      occasion: clean(sections["1"]),
      problem: clean(sections["2"]),
      people: clean(sections["3"]),
      real: clean(sections["6"]),
      promises: clean(sections["8"]),
    },
  };
}

/** The agent's reply to a live interview turn, with the PRD if it wrote or revised one. */
export function applyAgentReply(p: Project, message: string, prd: string | null, prdPath: string | null): Project {
  if (!isLive(p) || p.stage !== "interview") return p;
  const text = message.trim() || (prd ? "I have written the PRD. Is it right?" : "");
  let next: Project = {
    ...p,
    agentError: null,
    messages: [...p.messages, { from: "agent", text, at: now(), ...(prd ? { prd } : {}) }],
  };
  if (!prd) return next;
  next = applyPrd(next, prd, prdPath);
  return next.stories.length
    ? next
    : say(next, "system", "The PRD has no steps I can read. Ask the agent to list them as S1, S2 and so on.");
}

export function agentFailed(p: Project, error: string): Project {
  return { ...p, agentError: error.trim() || "The agent did not answer." };
}

/** What the agent was doing when it failed, for the error shown to the user. */
export function failedTask(p: Project): string {
  if (p.stage === "plan") return "plan the steps";
  return p.stage === "prototype" ? "make the prototype" : "answer";
}

export function retryAgent(p: Project): Project {
  return p.agentError ? { ...p, agentError: null } : p;
}

/** Everything the PRD needs is there and the user can approve it. */
export function awaitingApproval(p: Project): boolean {
  if (p.stage !== "interview" || p.prdApproved) return false;
  if (isLive(p)) return !!p.prdText && p.stories.length > 0 && !p.agentError && !needsAgentTurn(p);
  return p.interviewStep >= QUESTIONS.length;
}

function draftPrd(p: Project): Project {
  const stories = splitLines(p.answers.walkthrough ?? "").map((t, i) => toStory(i, t));
  const later = splitLines(p.answers.later ?? "").filter((l) => !/^(no|none|nothing|-)\.?$/i.test(l));
  let next: Project = { ...p, stories, later };
  const lines = [
    `Here is what I have. ${p.name} is for ${p.client}: ${p.answers.problem}`,
    `Must have for the demo (${stories.length} step${stories.length === 1 ? "" : "s"}): ${stories
      .map((s) => `${s.id} ${s.title}`)
      .join("; ")}.`,
    later.length ? `Later, not built now: ${later.join("; ")}.` : "Nothing parked for later.",
    "Everything runs on made-up sample data.",
  ];
  if (stories.length > 5) {
    lines.push(
      `That is ${stories.length} steps. A demo that does three things well beats one that does many half-way, so consider moving some to later in the Steps tab.`
    );
  }
  lines.push("The full document is in the PRD tab. If this is right, approve it. If not, tell me what is wrong and I will note it.");
  next = say(next, "agent", lines.join("\n\n"));
  return next;
}

/** A message typed by the user. Where it goes depends on the stage. */
export function userSays(p: Project, raw: string): Project {
  const text = raw.trim();
  if (!text || p.stage === "done") return p;
  let next = say(p, "user", text);

  if (next.stage === "interview" && isLive(next)) {
    // The real agent answers; the caller runs its turn.
    return { ...next, agentError: null };
  }

  if (next.stage === "interview") {
    if (next.interviewStep < QUESTIONS.length) {
      const q = QUESTIONS[next.interviewStep];
      const answers = { ...next.answers, [q.key]: text };
      const asked = next.interviewStep;
      next = { ...next, answers, interviewStep: nextUnanswered(answers) };
      if (REAL_DATA_HINTS.test(text)) {
        next = say(
          next,
          "agent",
          "One note: prototypes use made-up sample data only, never real client, patient or policyholder records. I'll plan for realistic samples."
        );
      }
      if (q.key === "walkthrough" && splitLines(text).length === 0) {
        const { walkthrough: _dropped, ...kept } = answers;
        return say({ ...next, answers: kept, interviewStep: asked }, "agent", "I need at least one step. What is the first thing you will show?");
      }
      return next.interviewStep < QUESTIONS.length
        ? say(next, "agent", QUESTIONS[next.interviewStep].ask(next))
        : draftPrd(next);
    }
    next = { ...next, openQuestions: [...next.openQuestions, text] };
    return say(
      next,
      "agent",
      next.prdText
        ? "Noted at the end of the PRD. No agent is connected for this prototype, so I cannot rewrite the PRD itself."
        : "Noted under open questions in the PRD. You can redo the interview if the answers themselves need to change."
    );
  }

  if (next.stage === "show" && next.previewShared && next.demoStep < DEMO_QUESTIONS.length) {
    const q = DEMO_QUESTIONS[next.demoStep];
    next = { ...next, demoAnswers: { ...next.demoAnswers, [q.key]: text }, demoStep: next.demoStep + 1 };
    if (next.demoStep < DEMO_QUESTIONS.length) {
      return say(next, "agent", DEMO_QUESTIONS[next.demoStep].ask(next));
    }
    next = record(next, "show", "After-demo notes recorded.");
    next = { ...next, stage: "handover" };
    return say(
      next,
      "agent",
      "Thanks, that is recorded. You can hand it over to engineering now, or build the real app here."
    );
  }

  // A change before the client has seen it goes back into the prototype.
  if (next.stage === "prototype" || (next.stage === "show" && !next.previewShared)) {
    if (!isLive(next)) {
      next = { ...next, openQuestions: [...next.openQuestions, `Prototype: ${text}`] };
      return say(next, "agent", "Noted for engineering. No agent is connected for this prototype, so I cannot change it.");
    }
    next = {
      ...next,
      stage: "prototype",
      designChanges: [...next.designChanges, text],
      designPending: true,
      agentError: null,
    };
    return record(next, "design", `Change asked for: ${text}`);
  }

  if (next.stage === "build") {
    next = { ...next, pendingChange: { text } };
    return say(
      next,
      "agent",
      "Is this a small fix to a step we already agreed, or something new that is outside the PRD? Choose below."
    );
  }

  next = { ...next, openQuestions: [...next.openQuestions, text] };
  return say(next, "agent", "Noted as an open question for engineering.");
}

export function redoInterview(p: Project): Project {
  if (p.stage !== "interview" || isLive(p)) return p;
  const reset: Project = { ...p, interviewStep: 0, answers: {}, stories: [], later: [], openQuestions: [] };
  return say(say(reset, "system", "Interview restarted."), "agent", QUESTIONS[0].ask(reset));
}

/** The approved PRD is waiting for the agent to size its steps. */
export function needsPlan(p: Project): boolean {
  return isLive(p) && p.stage === "plan" && p.planned === "no" && !p.agentError;
}

export interface PlannedStep {
  id: string;
  size: StorySize;
  needs_engineer: boolean;
  reason: string;
}

/** Applies the agent's plan: size, engineer flag and reason per step. Steps it left out keep the defaults. */
export function applyPlan(p: Project, summary: string, steps: PlannedStep[]): Project {
  if (p.stage !== "plan" || p.planned !== "no") return p;
  const byId = new Map(steps.map((s) => [s.id.toUpperCase(), s]));
  let next: Project = {
    ...p,
    planned: "agent",
    agentError: null,
    stories: p.stories.map((story) => {
      const plan = byId.get(story.id);
      return plan
        ? { ...story, size: plan.size, needsEngineer: plan.needs_engineer, engineerCleared: false, note: plan.reason }
        : story;
    }),
  };
  const hard = next.stories.filter((s) => s.size === "hard").length;
  const flagged = next.stories.filter((s) => s.needsEngineer);
  const planner = agentById(p.interviewAgent)?.label ?? "the agent";
  next = record(
    next,
    "agents",
    `Plan by ${planner}: ${next.stories.length} step(s), ${hard} hard, ${flagged.length} needing an engineer${
      flagged.length ? ` (${flagged.map((s) => s.id).join(", ")})` : ""
    }.`
  );
  const tail = flagged.length
    ? `${flagged.map((s) => s.id).join(", ")} must be cleared by an engineer or moved to later before set up.`
    : "Start set up when you are ready.";
  return say(next, "agent", `${summary || `I planned ${next.stories.length} steps.`}\n\n${tail}`);
}

/** Carries on with the built-in keyword sizing when the agent could not plan. */
export function planWithRules(p: Project): Project {
  if (p.stage !== "plan" || p.planned !== "no") return p;
  const next = record({ ...p, planned: "rules", agentError: null }, "agents", "Steps sized by the built-in rules; the agent's plan was skipped.");
  return say(next, "system", "Steps sized by the built-in rules.");
}

/** Approving the PRD starts the prototype: a real agent builds it, otherwise a plain outline is drawn. */
export function approvePrd(p: Project): Project {
  if (!awaitingApproval(p)) return p;
  let next: Project = { ...p, prdApproved: true, stage: "prototype" };
  next = record(next, "prd", `PRD approved with ${next.stories.length} step(s).`);
  if (isLive(next)) return say({ ...next, designPending: true }, "system", "PRD approved.");
  next = { ...next, designHtml: standInDesign(next) };
  next = record(next, "design", "Outline prototype drawn from the steps (no agent connected).");
  return say(
    next,
    "agent",
    "Approved. Here is a plain outline of the screens, one per step. No agent is connected, so it shows the steps and what each must do, not a working prototype. Look at it in the Preview tab and tick each line in the Steps tab."
  );
}

export function blockedStories(p: Project): Story[] {
  return p.stories.filter((s) => s.needsEngineer && !s.engineerCleared);
}

export function clearStory(p: Project, id: string): Project {
  const story = p.stories.find((s) => s.id === id);
  if (!story || !story.needsEngineer || story.engineerCleared) return p;
  const next = {
    ...p,
    stories: p.stories.map((s) => (s.id === id ? { ...s, engineerCleared: true } : s)),
  };
  return record(next, "engineer", `${id} cleared by engineering: ${story.title}`);
}

export function moveStoryToLater(p: Project, id: string): Project {
  const story = p.stories.find((s) => s.id === id);
  if (!story || story.status === "confirmed" || p.stories.length <= 1) return p;
  const next = {
    ...p,
    stories: p.stories.filter((s) => s.id !== id),
    later: [...p.later, story.title],
  };
  const logged = record(next, "scope", `Scope change: ${id} “${story.title}” moved to later.`);
  return logged.stage === "build" && !currentStory(logged) ? { ...logged, stage: "handover", built: true } : logged;
}

export function canStartSetup(p: Project): boolean {
  return p.stage === "plan" && p.planned !== "no" && p.stories.length > 0 && blockedStories(p).length === 0;
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A plain mock-up built from the steps, for prototypes with no agent connected. */
export function standInDesign(p: Project): string {
  const radios = p.stories
    .map((s, i) => `<input type="radio" name="screen" id="go-${s.id}"${i === 0 ? " checked" : ""}>`)
    .join("\n");
  const tabs = p.stories.map((s) => `<label for="go-${s.id}">${s.id}</label>`).join("\n");
  const screens = p.stories
    .map(
      (s) =>
        `<section class="screen" id="screen-${s.id}" data-step="${s.id}">\n<h2>${escapeHtml(s.title)}</h2>\n<ul>\n${s.criteria
          .map((c) => `<li>${escapeHtml(c.text)}</li>`)
          .join("\n")}\n</ul>\n</section>`
    )
    .join("\n");
  const show = p.stories
    .map((s) => `#go-${s.id}:checked ~ main #screen-${s.id}{display:block}#go-${s.id}:checked ~ nav label[for="go-${s.id}"]{background:var(--color-accent);color:#fff}`)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(p.name)}</title>
<style>
:root{--color-surface:#f6f7f9;--color-card:#fff;--color-ink:#1c2230;--color-muted:#5b6474;--color-accent:#2f6fde;--space-md:16px;--radius:8px}
body{margin:0;padding:24px;font:16px/1.5 system-ui,sans-serif;background:var(--color-surface);color:var(--color-ink)}
input[name=screen]{position:absolute;opacity:0;pointer-events:none}
nav{display:flex;gap:8px;margin-bottom:var(--space-md)}
nav label{padding:6px 12px;border:1px solid #cfd5df;border-radius:var(--radius);background:var(--color-card);cursor:pointer}
.screen{display:none;padding:24px;border:1px solid #dde2ea;border-radius:var(--radius);background:var(--color-card)}
h1{font-size:20px;margin:0 0 var(--space-md)}h2{font-size:18px;margin:0 0 8px}ul{margin:0;padding-left:20px;color:var(--color-muted)}
${show}
</style>
</head>
<body>
${radios}
<h1>${escapeHtml(p.name)}</h1>
<nav>
${tabs}
</nav>
<main>
${screens}
</main>
</body>
</html>`;
}

/** The prototype stage is waiting on the agent for a first version or a revision. */
export function needsDesign(p: Project): boolean {
  return isLive(p) && p.stage === "prototype" && p.designPending && !p.agentError;
}

const unticked = (stories: Story[]): Story[] =>
  stories.map((s) => ({ ...s, criteria: s.criteria.map((c) => ({ ...c, done: false })) }));

/** The agent's prototype, new or revised. A revision has to be checked again from the start. */
export function applyDesign(p: Project, message: string, html: string, path: string | null): Project {
  if (p.stage !== "prototype" || !p.designPending) return p;
  const revised = p.designHtml !== null;
  const maker = agentById(p.interviewAgent)?.label ?? "the agent";
  let next: Project = {
    ...p,
    designHtml: html,
    designPath: path ?? p.designPath,
    designPending: false,
    agentError: null,
    stories: unticked(p.stories),
  };
  next = record(next, "design", revised ? `Prototype revised by ${maker}.` : `Prototype made by ${maker}.`);
  return say(
    next,
    "agent",
    `${message.trim() || "Here is the prototype."}\n\nIt is in the Preview tab. Try each step, tick the lines that are true in the Steps tab, or tell me what to change.`
  );
}

/** Lines of the acceptance criteria the user has not ticked against the prototype yet. */
export function linesLeft(p: Project): number {
  return p.stories.reduce((n, s) => n + s.criteria.filter((c) => !c.done).length, 0);
}

/** The prototype exists, is not being changed, and every line has been checked against it. */
export function canFinishPrototype(p: Project): boolean {
  return p.stage === "prototype" && !!p.designHtml && !p.designPending && !p.agentError && linesLeft(p) === 0;
}

/** The user has checked the prototype; it can go to the client. */
export function finishPrototype(p: Project): Project {
  if (!canFinishPrototype(p)) return p;
  const next = record(
    { ...p, stage: "show", designStatus: "approved" },
    "design",
    `Prototype checked by ${p.author}: every line ticked.`
  );
  return say(next, "agent", `The prototype is ready to show ${p.client}. It is one file that opens in any browser.`);
}

/** Drops a change the agent could not make and keeps the prototype as it is. */
export function keepDesign(p: Project): Project {
  if (p.stage !== "prototype" || !p.designHtml || !p.designPending) return p;
  const dropped = p.designChanges[p.designChanges.length - 1];
  const next = record(
    { ...p, designPending: false, agentError: null, designChanges: p.designChanges.slice(0, -1) },
    "design",
    `Change not made, prototype kept as it was: ${dropped ?? "-"}`
  );
  return say(next, "system", "The prototype was left as it is.");
}

/** Whether the real app can be built here: after the client has seen the prototype, once. */
export function canChooseBuild(p: Project): boolean {
  return !p.building && (p.stage === "handover" || p.stage === "done");
}

/**
 * Carries on in the same prototype to build the real app, instead of (or after)
 * handing it over. The steps are sized first, then set up, then built one by one.
 */
export function chooseBuild(p: Project): Project {
  if (!canChooseBuild(p)) return p;
  const reopened = p.stage === "done";
  let next: Project = {
    ...p,
    stage: "plan",
    building: true,
    built: false,
    handover: null,
    planned: isLive(p) ? "no" : "rules",
    stories: unticked(p.stories).map((s) => ({ ...s, status: "todo" as const, builtBy: null })),
  };
  next = record(
    next,
    "build",
    reopened ? `Reopened after handover to build the real app here, by ${p.author}.` : `Building the real app here, chosen by ${p.author}.`
  );
  if (isLive(next)) return say(next, "system", "Building the real app from the approved PRD and prototype.");
  const flagged = next.stories.filter((s) => s.needsEngineer);
  return say(
    next,
    "agent",
    flagged.length
      ? `I will build the real app from the PRD and the prototype, in ${next.stories.length} steps. ${flagged
          .map((s) => s.id)
          .join(", ")} may touch a real system, so an engineer has to clear ${flagged.length === 1 ? "it" : "them"} first, or you can move ${flagged.length === 1 ? "it" : "them"} to later.`
      : `I will build the real app from the PRD and the prototype, in ${next.stories.length} steps. Nothing needs an engineer. Start set up when you are ready.`
  );
}

export function startSetup(p: Project): Project {
  if (!canStartSetup(p)) return p;
  return say({ ...p, stage: "setup", checksPassing: false }, "agent", "Setting up. This takes a moment.");
}

/**
 * The prototype as it is shown. It may run its own scripts, but nothing may load
 * from or send to anywhere. The frame it sits in has no access to the app.
 */
export function lockedDesign(html: string): string {
  return (
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'">` +
    html
  );
}

export const SETUP_STEPS = [
  "Create the project from the project template",
  "Add made-up sample data",
  "Start the preview",
  "Run the standards checks",
];

export function finishSetup(p: Project): Project {
  if (p.stage !== "setup") return p;
  let next: Project = { ...p, stage: "build", checksPassing: true };
  next = record(next, "build", "Project set up from the project template. Standards checks passing.");
  const first = currentStory(next);
  return say(next, "agent", `Ready. Next step: ${first?.id} ${first?.title}.`);
}

export function agentById(id: string | null): AgentDef | null {
  return AGENTS.find((a) => a.id === id) ?? null;
}

/** What the orchestrator would pick: hard steps to the lead, small ones to the first worker. */
export function routedAgent(story: Story): AgentDef {
  const tier: Tier = story.size === "hard" ? "lead" : "worker";
  return AGENTS.find((a) => a.tier === tier) ?? AGENTS[0];
}

/** The agent that will build this step, and whether a person chose it. */
export function agentFor(p: Project, story: Story): { agent: AgentDef; byHand: boolean } {
  const picked = p.assignMode === "manual" ? agentById(story.assignedTo) : null;
  return picked ? { agent: picked, byHand: true } : { agent: routedAgent(story), byHand: false };
}

export function setAssignMode(p: Project, mode: AssignMode): Project {
  if (p.assignMode === mode || p.stage === "done") return p;
  return record(
    { ...p, assignMode: mode },
    "agents",
    mode === "autopilot"
      ? "Agents on autopilot: the orchestrator picks an agent for each step."
      : "Agents assigned by hand. Steps left unassigned still follow the orchestrator."
  );
}

/** Picks the agent for one step by hand; null hands the choice back to the orchestrator. */
export function assignStory(p: Project, id: string, agentId: string | null): Project {
  const story = p.stories.find((s) => s.id === id);
  if (!story || story.status === "confirmed" || p.stage === "done") return p;
  if (agentId !== null && !agentById(agentId)) return p;
  if (story.assignedTo === agentId) return p;
  const next = {
    ...p,
    stories: p.stories.map((s) => (s.id === id ? { ...s, assignedTo: agentId } : s)),
  };
  return record(
    next,
    "agents",
    agentId ? `${id} assigned to ${agentById(agentId)?.label} by ${p.author}.` : `${id} handed back to the orchestrator.`
  );
}

/** The story being worked on: the first one the user has not confirmed. */
export function currentStory(p: Project): Story | null {
  return p.stories.find((s) => s.status !== "confirmed") ?? null;
}

export function buildCurrentStory(p: Project): Project {
  const story = currentStory(p);
  if (p.stage !== "build" || !story || story.status !== "todo" || p.pendingChange) return p;
  if (story.needsEngineer && !story.engineerCleared) return p;
  const { agent, byHand } = agentFor(p, story);
  const orchestrator = agentById(ORCHESTRATOR_ID);
  let next: Project = {
    ...p,
    checksPassing: true,
    stories: p.stories.map((s) =>
      s.id === story.id ? { ...s, status: "built" as const, builtBy: agent.id } : s
    ),
  };
  next = record(
    next,
    "build",
    `${story.id} built by ${agent.label} (${byHand ? `assigned by ${p.author}` : `autopilot, ${story.size} step`}). Standards checks passing.`
  );
  const how =
    agent.id === ORCHESTRATOR_ID
      ? `${agent.label} built ${story.id} itself`
      : `${orchestrator?.label ?? "The orchestrator"} handed ${story.id} to ${agent.label} and waited for it to finish`;
  return say(next, "agent", `${how}. The checks pass. Look at the preview and tick each line that is true.`);
}

/** Lines can be ticked against the prototype once it exists, and against a step once it is built. */
export function canTick(p: Project, story: Story): boolean {
  if (p.stage === "prototype") return !!p.designHtml && !p.designPending;
  return p.stage === "build" && story.status === "built";
}

export function toggleCriterion(p: Project, storyId: string, index: number): Project {
  return {
    ...p,
    stories: p.stories.map((s) =>
      s.id === storyId && canTick(p, s)
        ? { ...s, criteria: s.criteria.map((c, i) => (i === index ? { ...c, done: !c.done } : c)) }
        : s
    ),
  };
}

export function canConfirmStory(p: Project): boolean {
  const story = currentStory(p);
  return (
    p.stage === "build" &&
    !!story &&
    story.status === "built" &&
    p.checksPassing &&
    story.criteria.every((c) => c.done)
  );
}

export function confirmStory(p: Project): Project {
  const story = currentStory(p);
  if (!story || !canConfirmStory(p)) return p;
  let next: Project = {
    ...p,
    stories: p.stories.map((s) => (s.id === story.id ? { ...s, status: "confirmed" as const } : s)),
  };
  next = record(next, "build", `${story.id} confirmed by ${p.author}.`);
  const upcoming = currentStory(next);
  if (upcoming) return say(next, "agent", `Saved. Next step: ${upcoming.id} ${upcoming.title}.`);
  next = { ...next, stage: "handover", built: true };
  return say(next, "agent", "All steps are built and confirmed. Hand it over when you are ready.");
}

/** A built step can be undone until the app is handed over. */
export function canUndo(p: Project): boolean {
  const building = p.stage === "build" || (p.stage === "handover" && p.built);
  return building && p.stories.some((s) => s.status === "confirmed");
}

/** Goes back to how things were before the last confirmed step. */
export function undoLastStep(p: Project): Project {
  if (!canUndo(p)) return p;
  const confirmed = p.stories.filter((s) => s.status === "confirmed");
  const last = confirmed[confirmed.length - 1];
  let next: Project = {
    ...p,
    stage: "build",
    built: false,
    stories: p.stories.map((s) =>
      s.id === last.id || s.status === "built"
        ? { ...s, status: "todo" as const, criteria: s.criteria.map((c) => ({ ...c, done: false })) }
        : s
    ),
  };
  next = record(next, "undo", `${last.id} undone. Back to how it was before that step.`);
  return say(next, "system", `${last.id} undone.`);
}

export type ChangeKind = "tweak" | "new" | "later";

export function resolveChange(p: Project, kind: ChangeKind): Project {
  const change = p.pendingChange;
  if (!change) return p;
  let next: Project = { ...p, pendingChange: null };
  if (kind === "later") {
    next = { ...next, later: [...next.later, change.text] };
    next = record(next, "scope", `Parked for later: ${change.text}`);
    return say(next, "agent", "Parked under later. It will be in the handover.");
  }
  if (kind === "new") {
    const number = Math.max(0, ...next.stories.map((s) => Number(s.id.slice(1)))) + 1;
    const story = toStory(number - 1, change.text);
    next = { ...next, stage: "build", stories: [...next.stories, story] };
    next = record(next, "scope", `Scope change: added ${story.id} “${change.text}”.`);
    return say(
      next,
      "agent",
      story.needsEngineer
        ? `Added as ${story.id} and recorded as a scope change. It may touch a real system, so an engineer has to clear it before it is built.`
        : `Added as ${story.id} and recorded as a scope change. It will be built after the current steps.`
    );
  }
  const target =
    currentStory(next) ?? next.stories.filter((s) => s.status === "confirmed").slice(-1)[0];
  if (!target) return next;
  next = {
    ...next,
    stage: "build",
    stories: next.stories.map((s) =>
      s.id === target.id
        ? { ...s, status: "todo" as const, criteria: s.criteria.map((c) => ({ ...c, done: false })) }
        : s
    ),
  };
  next = record(next, "build", `Fix requested on ${target.id}: ${change.text}`);
  return say(next, "agent", `Noted against ${target.id}. Build it again and check it.`);
}

export function askEngineer(p: Project): Project {
  const story = currentStory(p);
  const about = story ? `${story.id} ${story.title}` : stagesFor(p).find((s) => s.key === p.stage)?.label ?? p.stage;
  const next = record(p, "engineer", `Help requested from engineering on: ${about}.`);
  return say(next, "system", `Engineering has been asked to look at: ${about}. They get the PRD and the record so far.`);
}

export function sharePreview(p: Project): Project {
  if (p.stage !== "show" || p.previewShared) return p;
  let next: Project = { ...p, previewShared: true };
  next = record(next, "show", `Prototype shown to ${p.client}.`);
  return say(next, "agent", `Recorded. Now tell me how it went: ${DEMO_QUESTIONS[0].ask(next)}`);
}

export function canHandOver(p: Project): boolean {
  // A built app must pass its checks; a prototype on its own has none to pass.
  return p.stage === "handover" && !p.pendingChange && (!p.building || (p.built && p.checksPassing));
}

export function handOver(p: Project): Project {
  if (!canHandOver(p)) return p;
  let next = record(p, "handover", `Handed over to engineering by ${p.author}.`);
  next = { ...next, stage: "done", handover: handoverMarkdown(next) };
  return say(
    next,
    "system",
    p.built
      ? "Handed over with the built app. This prototype is now read-only."
      : "Handed over. This prototype is now read-only. An engineer can still build it here later."
  );
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const bullets = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "- None");

/** prd.md, using the fixed section headings from skills/product/prd-interview/templates/prd.md. */
export function prdMarkdown(p: Project): string {
  if (p.prdText) {
    const text = p.prdApproved
      ? p.prdText
          .replace(/^Status:.*$/m, "Status: Approved")
          .replace(/^Approved on:.*$/m, `Approved on: ${day(p.log.find((l) => l.kind === "prd")?.at ?? now())}`)
      : p.prdText;
    const changes = p.log.filter((l) => l.kind === "scope");
    return [
      text,
      changes.length
        ? `## Scope changes since approval\n\n${bullets(changes.map((l) => `${day(l.at)}: ${l.text}`))}`
        : "",
      p.openQuestions.length ? `## Notes added in the app\n\n${bullets(p.openQuestions)}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  const a = p.answers;
  const stories = p.stories
    .map(
      (s) =>
        `### ${s.id}. ${s.title}\n\nAcceptance criteria:\n${s.criteria
          .map((c) => `- [${c.done ? "x" : " "}] ${c.text}`)
          .join("\n")}`
    )
    .join("\n\n");
  const scope = p.log.filter((l) => l.kind === "scope");
  return [
    `# PRD: ${p.name}`,
    `Status: ${p.prdApproved ? "Approved" : "Draft"}\nAuthor: ${p.author}\nSkill library version: ${LIBRARY_VERSION}`,
    `## 1. Client and occasion\n\n- Client: ${p.client}\n- Shown at: ${a.occasion ?? "-"}`,
    `## 2. Problem\n\n${a.problem ?? "-"}`,
    `## 3. People\n\n${a.people ?? "-"}`,
    `## 4. Stories\n\n${stories || "-"}`,
    `## 5. Scope\n\n### Must have for the demo\n${bullets(p.stories.map((s) => `${s.id} ${s.title}`))}\n\n### Later\n${bullets(p.later)}`,
    `## 6. Real or pretend\n\n${a.real ?? "-"}\n\nInformation shown: ${a.information ?? "-"}\n\nAll data is made-up sample data. No real client, patient or policyholder records.`,
    `## 8. Promises already made to the client\n\n${a.promises ?? "-"}`,
    `## 10. Open questions\n\n${bullets(p.openQuestions)}`,
    `## 11. Decisions and scope changes\n\n${bullets(scope.map((l) => `${day(l.at)}: ${l.text}`))}`,
  ].join("\n\n");
}

export function handoverMarkdown(p: Project): string {
  const d = p.demoAnswers;
  return [
    `# Handover: ${p.name}`,
    `Client: ${p.client}\nBuilt by: ${p.author}\nStarted: ${day(p.createdAt)}\nSkill library version: ${LIBRARY_VERSION}\nReal app built here: ${p.built ? "yes" : "no, prototype only"}\nStandards checks: ${
      p.built ? (p.checksPassing ? "passing" : "blocked") : "not applicable to a prototype"
    }`,
    `## What it is\n\n${p.answers.problem ?? "-"}`,
    `## What was built\n\n${bullets(
      p.stories.map(
        (s) => `${s.id} ${s.title} (${s.status}${s.builtBy ? `, built by ${agentById(s.builtBy)?.label ?? s.builtBy}` : ""})`
      )
    )}`,
    `## Real or pretend\n\n${p.answers.real ?? "-"}\n\nAll data is made-up sample data.`,
    `## Prototype\n\nA working HTML prototype on made-up data${p.designPath ? `: ${p.designPath}` : " (design.html)"}. ${
      p.designStatus === "approved" ? `Every acceptance line was checked against it by ${p.author}.` : "It was not fully checked."
    } It is the visual and behavioural reference for the real app, not code to reuse.${
      p.designChanges.length ? `\n\nChanges asked for along the way:\n\n${bullets(p.designChanges)}` : ""
    }`,
    `## Needs an engineer when built for real\n\n${bullets(
      p.stories.filter((st) => st.needsEngineer).map((st) => `${st.id} ${st.title}${st.note ? `: ${st.note}` : ""}`)
    )}`,
    `## Not built\n\n${bullets(p.later)}`,
    `## Promised to the client\n\nBefore the demo: ${p.answers.promises ?? "-"}\n\nIn the room: ${d.promised ?? "-"}`,
    `## After the demo\n\nReaction: ${d.reaction ?? "-"}\n\nAsked for next: ${d.next ?? "-"}`,
    `## Open questions\n\n${bullets(p.openQuestions)}`,
    `## Record\n\n${bullets(p.log.map((l) => `${day(l.at)}: ${l.text}`))}`,
  ].join("\n\n");
}

const STORE_KEY = "panguyuban.builder.v1";

export function loadProjects(): Project[] {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Project[]) : [];
    if (!Array.isArray(parsed)) return [];
    // Projects saved by an earlier version get the defaults for newer fields.
    return parsed.map((p) => ({
      ...p,
      description: p.description ?? "",
      interviewAgent: p.interviewAgent ?? null,
      prdText: p.prdText ?? null,
      prdPath: p.prdPath ?? null,
      agentError: p.agentError ?? null,
      planned: p.planned ?? (p.prdApproved ? "rules" : "no"),
      designHtml: p.designHtml ?? null,
      designPath: p.designPath ?? null,
      designChanges: p.designChanges ?? [],
      designPending: p.designPending ?? false,
      designStatus: p.designStatus ?? "no",
      building: p.building ?? false,
      built: p.built ?? false,
      assignMode: p.assignMode ?? "autopilot",
      stories: p.stories.map((s) => ({
        ...s,
        size: s.size ?? "small",
        assignedTo: s.assignedTo ?? null,
        builtBy: s.builtBy ?? null,
        note: s.note ?? "",
      })),
    }));
  } catch {
    return [];
  }
}

export function saveProjects(projects: Project[]): void {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(projects));
  } catch {
    /* storage unavailable: the session still works, it just is not kept */
  }
}
