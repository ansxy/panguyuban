import React, { useEffect, useRef, useState } from "react";
import { HttpResponse, sendHttp } from "./api";
import { ImportedRequest, parseCollection, Row } from "./postman";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const CONTENT_TYPES = ["none", "application/json", "application/x-www-form-urlencoded", "text/plain", "application/xml"];
const STORE_KEY = "panguyuban.requests.v2";

interface RequestDraft {
  id: string;
  /** Set for requests imported from a collection; otherwise the tab shows the URL. */
  name?: string;
  method: string;
  url: string;
  /** Appended to the URL's query string when sending. */
  params: Row[];
  headers: Row[];
  /** "none" sends no body; otherwise sent as Content-Type unless a header sets one. */
  contentType: string;
  body: string;
}

type Outcome = { pending: true } | { response: HttpResponse } | { error: string };

function blankDraft(): RequestDraft {
  return { id: crypto.randomUUID(), method: "GET", url: "", params: [], headers: [], contentType: "none", body: "" };
}

function loadDrafts(): RequestDraft[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORE_KEY) ?? "[]");
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as RequestDraft[];
  } catch {
    /* unreadable store: start fresh */
  }
  return [blankDraft()];
}

function saveDrafts(drafts: RequestDraft[]): void {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(drafts));
  } catch {
    /* storage unavailable: the session still works, it just is not kept */
  }
}

function activeRows(rows: Row[]): Row[] {
  return rows.filter((r) => r.enabled && r.key.trim() !== "");
}

function withParams(url: string, params: Row[]): string {
  const query = activeRows(params)
    .map((p) => `${encodeURIComponent(p.key.trim())}=${encodeURIComponent(p.value)}`)
    .join("&");
  if (!query) return url.trim();
  return `${url.trim()}${url.includes("?") ? "&" : "?"}${query}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Pretty-prints JSON bodies; anything else (or a cut-off body) is shown as-is. */
function displayBody(res: HttpResponse): string {
  if (res.truncated) return res.body;
  try {
    return JSON.stringify(JSON.parse(res.body), null, 2);
  } catch {
    return res.body;
  }
}

/** Request tabs live here (not in the view) so they survive switching sections. Only drafts are saved; responses stay in memory, one per tab. */
export function useRequests() {
  const [drafts, setDrafts] = useState<RequestDraft[]>(loadDrafts);
  const [currentId, setCurrentId] = useState<string>(() => drafts[0].id);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});

  useEffect(() => saveDrafts(drafts), [drafts]);

  const current = drafts.find((d) => d.id === currentId) ?? drafts[0];

  function update(change: Partial<RequestDraft>) {
    setDrafts((all) => all.map((d) => (d.id === current.id ? { ...d, ...change } : d)));
  }

  function open() {
    const draft = blankDraft();
    setDrafts((all) => [...all, draft]);
    setCurrentId(draft.id);
  }

  /** Opens each request as a tab, replacing tabs that are still blank. */
  function importMany(list: ImportedRequest[]) {
    if (list.length === 0) return;
    const added = list.map((r) => ({ ...r, id: crypto.randomUUID() }));
    setDrafts((all) => [...all.filter((d) => d.url.trim() !== ""), ...added]);
    setCurrentId(added[0].id);
  }

  function close(id: string) {
    const rest = drafts.filter((d) => d.id !== id);
    const next = rest.length > 0 ? rest : [blankDraft()];
    setDrafts(next);
    if (id === current.id) setCurrentId(next[Math.max(0, drafts.indexOf(current) - 1)]?.id ?? next[0].id);
    setOutcomes((all) => {
      const kept = { ...all };
      delete kept[id];
      return kept;
    });
  }

  async function send() {
    const draft = current;
    if (!draft.url.trim()) return;
    const headers = activeRows(draft.headers).map((h) => [h.key.trim(), h.value] as [string, string]);
    const hasBody = draft.contentType !== "none";
    if (hasBody && !headers.some(([name]) => name.toLowerCase() === "content-type")) {
      headers.push(["Content-Type", draft.contentType]);
    }
    setOutcomes((all) => ({ ...all, [draft.id]: { pending: true } }));
    let outcome: Outcome;
    try {
      outcome = {
        response: await sendHttp({
          method: draft.method,
          url: withParams(draft.url, draft.params),
          headers,
          body: hasBody ? draft.body : "",
        }),
      };
    } catch (err) {
      outcome = { error: String(err) };
    }
    setOutcomes((all) => ({ ...all, [draft.id]: outcome }));
  }

  return { drafts, current, outcome: outcomes[current.id], select: setCurrentId, update, open, importMany, close, send };
}

export type Requests = ReturnType<typeof useRequests>;

function tabName(draft: RequestDraft): string {
  return draft.name || draft.url.trim().replace(/^https?:\/\//, "") || "Untitled";
}

type RequestTab = "params" | "body" | "headers";

export function RequestsView({ requests }: { requests: Requests }) {
  const { current, outcome } = requests;
  const pending = outcome !== undefined && "pending" in outcome;
  const [tab, setTab] = useState<RequestTab>("params");
  const [importError, setImportError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const counts: Record<RequestTab, number> = {
    params: activeRows(current.params).length,
    body: current.contentType === "none" ? 0 : 1,
    headers: activeRows(current.headers).length,
  };

  return (
    <>
      <div className="tabbar" role="toolbar" aria-label="Request tabs">
        {requests.drafts.map((draft) => {
          const isCurrent = draft.id === current.id;
          return (
            <div key={draft.id} className="tab" data-current={isCurrent || undefined}>
              <button
                type="button"
                className="tab-main req-tab"
                aria-pressed={isCurrent}
                title={draft.url}
                onClick={() => requests.select(draft.id)}
              >
                <span className="req-method-label" data-method={draft.method}>
                  {draft.method}
                </span>
                {tabName(draft)}
              </button>
              <button
                type="button"
                className="tab-close"
                aria-label={`Close ${draft.method} ${tabName(draft)}`}
                onClick={() => requests.close(draft.id)}
              >
                ×
              </button>
            </div>
          );
        })}
        <button type="button" className="tab-add" aria-label="New request tab" title="New request" onClick={requests.open}>
          +
        </button>
        <span className="tabbar-spacer" />
        {importError && (
          <span className="req-error" role="alert">
            {importError}
          </span>
        )}
        <button
          type="button"
          className="tab-add tab-toggle"
          title="Import a Postman collection (.postman_collection.json)"
          onClick={() => fileInput.current?.click()}
        >
          <span aria-hidden="true">⇣</span>
          Import
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            try {
              const found = parseCollection(await file.text());
              if (found.length === 0) throw new Error("No requests in this collection");
              requests.importMany(found);
              setImportError(null);
            } catch (err) {
              setImportError(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }}
        />
      </div>

      <main className="main-stage main-stage--single">
        <section className="req-stage" aria-label="HTTP request">
          <form
            className="req-request"
            onSubmit={(e) => {
              e.preventDefault();
              requests.send();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.metaKey) {
                e.preventDefault();
                requests.send();
              }
            }}
          >
            <div className="req-line">
              <div className="req-target">
                <select
                  aria-label="Method"
                  data-method={current.method}
                  value={current.method}
                  onChange={(e) => requests.update({ method: e.target.value })}
                >
                  {METHODS.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
                <input
                  aria-label="URL"
                  placeholder="Enter a URL"
                  spellCheck={false}
                  value={current.url}
                  onChange={(e) => requests.update({ url: e.target.value })}
                />
              </div>
              <button type="submit" className="btn btn--primary req-send" disabled={pending || !current.url.trim()}>
                {pending ? "Sending…" : "Send"}
              </button>
            </div>

            <div className="req-subtabs" role="tablist" aria-label="Request parts">
              {(["params", "body", "headers"] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  className="req-subtab"
                  aria-selected={tab === key}
                  onClick={() => setTab(key)}
                >
                  {{ params: "Parameters", body: "Body", headers: "Headers" }[key]}
                  {counts[key] > 0 && <span className="req-subtab-count">{counts[key]}</span>}
                </button>
              ))}
            </div>

            <div className="req-panel" role="tabpanel">
              {tab === "params" && (
                <KeyValueEditor
                  title="Query Parameters"
                  noun="Parameter"
                  rows={current.params}
                  onChange={(params) => requests.update({ params })}
                />
              )}
              {tab === "headers" && (
                <KeyValueEditor
                  title="Header List"
                  noun="Header"
                  rows={current.headers}
                  onChange={(headers) => requests.update({ headers })}
                />
              )}
              {tab === "body" && (
                <>
                  <div className="req-section-head">
                    <label>
                      Content Type{" "}
                      <select
                        className="req-inline-select"
                        value={current.contentType}
                        onChange={(e) => requests.update({ contentType: e.target.value })}
                      >
                        {CONTENT_TYPES.map((t) => (
                          <option key={t}>{t}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {current.contentType === "none" ? (
                    <p className="req-note">This request does not have a body</p>
                  ) : (
                    <textarea
                      className="req-body"
                      aria-label="Raw request body"
                      spellCheck={false}
                      placeholder="Raw request body (⌘↵ to send)"
                      value={current.body}
                      onChange={(e) => requests.update({ body: e.target.value })}
                    />
                  )}
                </>
              )}
            </div>
          </form>

          <ResponseView outcome={outcome} />
        </section>
      </main>
    </>
  );
}

/** Rows plus one trailing blank row; typing into the blank row adds it. */
function KeyValueEditor(props: { title: string; noun: string; rows: Row[]; onChange: (rows: Row[]) => void }) {
  const { rows, onChange } = props;
  const shown = [...rows, { key: "", value: "", enabled: true }];
  const set = (i: number, change: Partial<Row>) =>
    onChange(i === rows.length ? [...rows, { ...shown[i], ...change }] : rows.map((r, j) => (j === i ? { ...r, ...change } : r)));

  return (
    <>
      <div className="req-section-head">
        <span>{props.title}</span>
        <button type="button" className="refresh-btn" disabled={rows.length === 0} onClick={() => onChange([])}>
          Clear all
        </button>
      </div>
      {shown.map((row, i) => {
        const blank = i === rows.length;
        return (
          <div className="req-kv" key={i} data-disabled={!row.enabled || undefined}>
            <input
              type="checkbox"
              aria-label={`Enable ${props.noun.toLowerCase()} ${i + 1}`}
              checked={row.enabled}
              disabled={blank}
              onChange={(e) => set(i, { enabled: e.target.checked })}
            />
            <input
              className="req-cell"
              aria-label={`${props.noun} ${i + 1} name`}
              placeholder={`${props.noun} ${i + 1}`}
              spellCheck={false}
              value={row.key}
              onChange={(e) => set(i, { key: e.target.value })}
            />
            <input
              className="req-cell"
              aria-label={`${props.noun} ${i + 1} value`}
              placeholder={`Value ${i + 1}`}
              spellCheck={false}
              value={row.value}
              onChange={(e) => set(i, { value: e.target.value })}
            />
            {blank ? (
              <span />
            ) : (
              <button
                type="button"
                className="refresh-btn"
                aria-label={`Remove ${props.noun.toLowerCase()} ${i + 1}`}
                onClick={() => onChange(rows.filter((_, j) => j !== i))}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
    </>
  );
}

function ResponseView({ outcome }: { outcome: Outcome | undefined }) {
  const [tab, setTab] = useState<"body" | "headers">("body");

  if (!outcome || "pending" in outcome) {
    return (
      <div className="req-response req-empty" aria-live="polite">
        {outcome ? (
          <p>Sending request…</p>
        ) : (
          <dl className="req-shortcuts">
            <dt>Send request</dt>
            <dd>
              <kbd>⌘</kbd>
              <kbd>↵</kbd>
            </dd>
            <dt>New terminal tab</dt>
            <dd>
              <kbd>⌘</kbd>
              <kbd>T</kbd>
            </dd>
          </dl>
        )}
      </div>
    );
  }
  if ("error" in outcome) {
    return (
      <div className="req-response req-empty" aria-live="polite">
        <strong>Could not send request</strong>
        <p className="req-error">{outcome.error}</p>
      </div>
    );
  }

  const res = outcome.response;
  const tone = res.status < 300 ? "ok" : res.status < 400 ? "redirect" : "bad";
  return (
    <div className="req-response" aria-live="polite">
      <div className="req-status">
        <span>
          Status: <strong data-tone={tone}>{res.status} • {res.status_text || "—"}</strong>
        </span>
        <span>
          Time: <strong data-tone={tone}>{res.elapsed_ms} ms</strong>
        </span>
        <span>
          Size: <strong data-tone={tone}>{formatSize(res.size)}</strong>
        </span>
        {res.truncated && <span>Body cut off at 2 MB</span>}
      </div>
      <div className="req-subtabs" role="tablist" aria-label="Response parts">
        <button type="button" role="tab" className="req-subtab" aria-selected={tab === "body"} onClick={() => setTab("body")}>
          Response Body
        </button>
        <button
          type="button"
          role="tab"
          className="req-subtab"
          aria-selected={tab === "headers"}
          onClick={() => setTab("headers")}
        >
          Headers<span className="req-subtab-count">{res.headers.length}</span>
        </button>
      </div>
      {tab === "body" ? (
        <CodeView text={displayBody(res)} />
      ) : (
        <div className="req-panel" role="tabpanel">
          {res.headers.map(([name, value], i) => (
            <div className="req-kv req-kv--read" key={i}>
              <span className="req-cell">{name}</span>
              <span className="req-cell">{value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Line numbers are one text node beside the body, so even a 2 MB body stays two DOM nodes. */
function CodeView({ text }: { text: string }) {
  const lineCount = text.split("\n").length;
  const gutter = Array.from({ length: lineCount }, (_, i) => i + 1).join("\n");
  return (
    <div className="req-code" role="tabpanel">
      <pre className="req-gutter" aria-hidden="true">
        {gutter}
      </pre>
      <pre className="req-code-text">{text}</pre>
    </div>
  );
}
