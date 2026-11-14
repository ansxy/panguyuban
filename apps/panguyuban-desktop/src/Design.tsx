// ponytail: spike. The board lives in memory only; save it as design.excalidraw beside the PRD if this sticks.
import { useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw, convertToExcalidrawElements, getCommonBounds } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import "@excalidraw/excalidraw/index.css";
import { type Builder, useAgentTurn } from "./Builder";
import { isLive, lockedDesign, userSays, type Project } from "./builder_flow";

// Embeds whose link starts with this render the prototype instead of a web page.
const PREFIX = "https://prototype.local/";
const FRAME_W = 420;
const FRAME_H = 300;
const GAP = 120;

const SAMPLE_HTML = `<!doctype html><html><body style="font:14px system-ui;margin:0;padding:16px;background:#fff;color:#222">
<section data-step="S1"><h3>Orders</h3><ul><li><button onclick="go()">Order #1042 · Waiting</button></li><li>Order #1043 · Approved</li></ul></section>
<section data-step="S2" hidden><h3>Order #1042</h3><p>3 items · Waiting for approval</p><button onclick="done()">Approve</button></section>
<section data-step="S3" hidden><h3>Approved</h3><p>Order #1042 was approved.</p></section>
<script>
const show = (s) => document.querySelectorAll("[data-step]").forEach((e) => (e.hidden = e.dataset.step !== s));
function go() { show("S2"); }
function done() { show("S3"); }
</script></body></html>`;

const SAMPLE_MERMAID = `flowchart LR
  A[Order placed] --> B{Over limit?}
  B -- yes --> C[Manager approves]
  B -- no --> D[Auto approved]
  C --> E[Ship]
  D --> E`;

/** The step ids the prototype marks with data-step, in page order. */
function stepsOf(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const ids = [...doc.querySelectorAll("[data-step]")].flatMap((e) => (e.getAttribute("data-step") ?? "").split(/\s+/));
  return [...new Set(ids.filter(Boolean))];
}

// Answers the board's "what is under this circle?": the element at its centre, or its parent if that is tiny.
const PICK = `<script>addEventListener("message",(e)=>{const d=e.data;if(!d||d.type!=="pick")return;const r=d.rect;
let el=document.elementFromPoint(r.x+r.w/2,r.y+r.h/2);
while(el&&el.parentElement&&el!==document.body){const b=el.getBoundingClientRect();if(b.width*b.height>=r.w*r.h*0.25)break;el=el.parentElement;}
const ok=el&&el!==document.body&&el!==document.documentElement;
parent.postMessage({type:"picked",id:d.id,html:ok?el.outerHTML.slice(0,400):"",text:ok?el.innerText.trim().slice(0,120):""},"*");});</script>`;

/** The prototype pinned to one screen: other steps hidden, this one forced visible. */
function oneStep(html: string, step: string): string {
  // ponytail: forces display:block, so a flex/grid screen may lay out differently than in the prototype.
  const pin = `<script>addEventListener("load",()=>document.querySelectorAll("[data-step]").forEach(e=>{
    const on=e.getAttribute("data-step").split(/\\s+/).includes(${JSON.stringify(step)});
    if(on){e.hidden=false;if(getComputedStyle(e).display==="none")e.style.setProperty("display","block","important");}
    else e.style.setProperty("display","none","important");}));</script>`;
  return lockedDesign(html + pin + PICK);
}

function boardFor(html: string) {
  const steps = stepsOf(html);
  const frames = [...steps.map((s) => ({ step: s, label: s })), { step: "", label: "Whole prototype (try it)" }];
  const skeleton = frames.flatMap((f, i) => {
    const x = i * (FRAME_W + GAP);
    return [
      { type: "text" as const, x, y: -36, text: f.label, fontSize: 20 },
      { type: "rectangle" as const, x, y: 0, width: FRAME_W, height: FRAME_H, link: PREFIX + f.step },
      ...(i < steps.length - 1
        ? [{ type: "arrow" as const, x: x + FRAME_W + 10, y: FRAME_H / 2, width: GAP - 20, height: 0 }]
        : []),
    ];
  });
  // ponytail: the skeleton API has no embeddable type, so frames are made as rectangles and retyped.
  return convertToExcalidrawElements(skeleton).map((e) =>
    e.link?.startsWith(PREFIX) ? ({ ...e, type: "embeddable" } as unknown as typeof e) : e,
  );
}

type Picked = { html: string; text: string };

/** Asks the frame showing `frameId` what sits under `rect` (in the frame's own pixels). */
function pick(frameId: string, rect: { x: number; y: number; w: number; h: number }): Promise<Picked> {
  const frame = document.querySelector<HTMLIFrameElement>(`iframe[data-frame="${frameId}"]`);
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve) => {
    const done = (p: Picked) => {
      removeEventListener("message", onMessage);
      resolve(p);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source === frame?.contentWindow && e.data?.type === "picked" && e.data.id === id) done(e.data);
    };
    addEventListener("message", onMessage);
    // A frame that never answers (still loading, or scrolled away) just means no element hint.
    setTimeout(() => done({ html: "", text: "" }), 1000);
    frame?.contentWindow?.postMessage({ type: "pick", id, rect }, "*");
  });
}

/** Where an element really sits. A pen stroke's x/y is where drawing started, not its top-left. */
function boundsOf(e: ExcalidrawElement) {
  const [x1, y1, x2, y2] = getCommonBounds([e]);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** The prototype frame a drawn shape overlaps most, if any. */
function frameUnder(elements: readonly ExcalidrawElement[], shape: ExcalidrawElement) {
  const s = boundsOf(shape);
  let best: ExcalidrawElement | undefined;
  let bestArea = 0;
  for (const f of elements) {
    if (f.type !== "embeddable" || !f.link?.startsWith(PREFIX)) continue;
    const w = Math.min(s.x + s.w, f.x + f.width) - Math.max(s.x, f.x);
    const h = Math.min(s.y + s.h, f.y + f.height) - Math.max(s.y, f.y);
    if (w > 0 && h > 0 && w * h > bestArea) [best, bestArea] = [f, w * h];
  }
  return best;
}

/** A change can go back into the prototype only while it is still being shaped. */
function canChange(p: Project | undefined): p is Project {
  return !!p && isLive(p) && (p.stage === "prototype" || (p.stage === "show" && !p.previewShared));
}

/** Runs the prototype's agent from here too; the turn guard in Builder stops a second run. */
function AgentTurn({ builder, project }: { builder: Builder; project: Project }) {
  useAgentTurn(builder, project);
  return null;
}

export function DesignView({ builder }: { builder: Builder }) {
  const withDesign = builder.projects.filter((p) => p.designHtml);
  const [projectId, setProjectId] = useState(withDesign[0]?.id ?? "");
  const project = withDesign.find((p) => p.id === projectId);
  const html = project?.designHtml ?? SAMPLE_HTML;
  // The drawn shape over a screen that "Ask the agent" is about, and where its box sits on the board.
  const [circled, setCircled] = useState<{ id: string; x: number; y: number } | null>(null);
  const circledId = useRef("");
  // Elements already seen, so a shape that just appeared counts as freshly drawn.
  const known = useRef(new Set<string>());
  const [request, setRequest] = useState("");
  const [sent, setSent] = useState("");
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [mermaid, setMermaid] = useState(SAMPLE_MERMAID);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Excalidraw keeps live frames above the drawing, so "draw" drops them beneath it to sketch on top.
  const [mode, setMode] = useState<"draw" | "try">("draw");
  // Only the first version lays out the board; later versions refresh the frames and keep the drawings.
  const elements = useMemo(() => boardFor(html), [projectId]);
  useEffect(() => {
    known.current = new Set(elements.map((e) => e.id));
    dismiss();
  }, [elements]);

  function dismiss() {
    circledId.current = "";
    setCircled(null);
  }

  async function askAgent() {
    const scene = api?.getSceneElements() ?? [];
    const shape = scene.find((e) => e.id === circled?.id);
    const frame = shape && frameUnder(scene, shape);
    if (!shape || !frame || !canChange(project) || !request.trim()) return;
    const step = frame.link!.slice(PREFIX.length);
    const b = boundsOf(shape);
    const picked = await pick(frame.id, { x: b.x - frame.x, y: b.y - frame.y, w: b.w, h: b.h });
    const where = step ? `screen ${step}` : "the prototype";
    const text =
      `On ${where}, the part I circled${picked.text ? ` ("${picked.text}")` : ""}: ${request.trim()}` +
      (picked.html ? `\n\nThe circled element:\n${picked.html}` : "");
    builder.updateById(project.id, (p) => userSays(p, text));
    setSent(request.trim());
    setRequest("");
    dismiss();
  }

  async function addDiagram() {
    if (!api) return;
    setBusy(true);
    setError("");
    try {
      // Mermaid is only loaded the first time someone adds a diagram.
      const { parseMermaidToExcalidraw } = await import("@excalidraw/mermaid-to-excalidraw");
      const { elements: parsed, files } = await parseMermaidToExcalidraw(mermaid);
      const scene = api.getSceneElements();
      const bottom = Math.max(FRAME_H, ...scene.map((e) => e.y + e.height)) + 120;
      const added = convertToExcalidrawElements(parsed, { regenerateIds: true }).map((e) => ({ ...e, y: e.y + bottom }));
      if (files) api.addFiles(Object.values(files));
      api.updateScene({ elements: [...scene, ...added] });
      api.scrollToContent(added, { fitToContent: true, animate: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="design-view">
      <div className="design-bar">
        <label>
          Prototype{" "}
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {withDesign.length === 0 && <option value="">Sample (no prototypes yet)</option>}
            {withDesign.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="filter-tabs" role="group" aria-label="Board mode">
          <button type="button" className="filter-tab" aria-pressed={mode === "draw"} onClick={() => setMode("draw")}>
            Draw on screens
          </button>
          <button type="button" className="filter-tab" aria-pressed={mode === "try"} onClick={() => setMode("try")}>
            Try screens
          </button>
        </div>
        <textarea value={mermaid} onChange={(e) => setMermaid(e.target.value)} rows={3} spellCheck={false} />
        <button type="button" onClick={addDiagram} disabled={busy || !api}>
          {busy ? "Drawing…" : "Add Mermaid diagram"}
        </button>
        {error && <span className="design-error">{error}</span>}
      </div>
      {project?.designPending ? (
        <span className="field-help design-status">The agent is changing the prototype{sent ? `: ${sent}` : ""}…</span>
      ) : project?.agentError ? (
        <span className="design-error design-status">{project.agentError}</span>
      ) : null}
      {project && <AgentTurn builder={builder} project={project} />}
      <div className={`design-canvas design-canvas--${mode}`}>
        {circled && (
          <form
            className="design-ask"
            // Kept inside the board when the shape sits near its right or bottom edge.
            style={{
              left: `clamp(8px, ${circled.x}px, calc(100% - min(440px, 90%) - 8px))`,
              top: `min(${circled.y}px, calc(100% - 64px))`,
            }}
            onSubmit={(e) => {
              e.preventDefault();
              void askAgent();
            }}
          >
            {canChange(project) ? (
              <>
                <input
                  autoFocus
                  value={request}
                  onChange={(e) => setRequest(e.target.value)}
                  placeholder="What should change in the circled part?"
                  disabled={project.designPending}
                />
                <button type="submit" disabled={!request.trim() || project.designPending}>
                  Ask the agent
                </button>
              </>
            ) : (
              <span className="field-help">
                {!project
                  ? "This is the sample. Pick one of your prototypes to send changes to its agent."
                  : !isLive(project)
                    ? "This prototype has no agent connected, so it cannot be changed from here."
                    : "The client has seen this prototype and it is now being built, so changes go to the real app. Ask for them in Prototypes."}
              </span>
            )}
            <button type="button" className="design-ask-close" aria-label="Close" onClick={dismiss}>
              ×
            </button>
          </form>
        )}
        <Excalidraw
          key={projectId}
          theme="dark"
          excalidrawAPI={setApi}
          // ponytail: a transparent canvas lets the frames show through; picking a canvas colour in the menu hides them again.
          initialData={{ elements, scrollToContent: true, appState: { viewBackgroundColor: "transparent" } }}
          onChange={(els, appState) => {
            const live = els.filter((e) => !e.isDeleted);
            const overScreen = (e?: ExcalidrawElement) =>
              e && e.type !== "embeddable" && frameUnder(live, e) ? e : undefined;
            let shape: ExcalidrawElement | undefined = live.find((e) => e.id === circledId.current);
            // A shape just finished over a screen. A pen stroke is never selected afterwards, so selection alone misses it.
            if (!appState.newElement && !appState.multiElement) {
              const fresh = live.filter((e) => !known.current.has(e.id));
              fresh.forEach((e) => known.current.add(e.id));
              shape = overScreen(fresh[fresh.length - 1]) ?? shape;
            }
            const ids = Object.keys(appState.selectedElementIds).filter((id) => appState.selectedElementIds[id]);
            if (ids.length === 1) shape = overScreen(live.find((e) => e.id === ids[0])) ?? shape;
            circledId.current = shape?.id ?? "";
            const zoom = appState.zoom.value;
            const b = shape && boundsOf(shape);
            const next = shape &&
              b && {
                id: shape.id,
                x: Math.round((b.x + appState.scrollX) * zoom),
                y: Math.round((b.y + b.h + appState.scrollY) * zoom + 8),
              };
            setCircled((prev) =>
              prev?.id === next?.id && prev?.x === next?.x && prev?.y === next?.y ? prev : (next ?? null),
            );
          }}
          validateEmbeddable={(link) => link.startsWith(PREFIX) || undefined}
          renderEmbeddable={(el) =>
            el.link?.startsWith(PREFIX) ? (
              <iframe
                title="Prototype screen"
                data-frame={el.id}
                sandbox="allow-scripts allow-forms"
                srcDoc={el.link === PREFIX ? lockedDesign(html + PICK) : oneStep(html, el.link.slice(PREFIX.length))}
                style={{ width: "100%", height: "100%", border: 0, background: "#fff" }}
              />
            ) : null
          }
        />
      </div>
    </div>
  );
}
