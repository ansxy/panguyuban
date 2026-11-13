import React, { useEffect, useRef, useState } from "react";
import { AgentSession, CalendarEvent, calendarEvents, folderList, openMeeting, PullRequest, Ticket } from "./api";
import { duration, useNow } from "./Agents";
import type { FeatureKey } from "./features";

const DAY_MS = 86_400_000;
const CALENDAR_POLL_MS = 5 * 60_000;

/** Home: today's meetings and calendar beside what needs you across tickets, PRs and agents. */
export function OverviewView(props: {
  features: Record<FeatureKey, boolean>;
  myActiveTickets: Ticket[];
  reviewPrs: PullRequest[];
  mergePrs: PullRequest[];
  agents: AgentSession[];
  /** `~`-relative folders the user works in (spaces, agents, configured repo). */
  knownFolders: string[];
  onOpenInTerminal: (folder: string) => void;
  onOpenTicket: (key: string) => void;
  onOpenPr: (pr: PullRequest, view: "review" | "merge") => void;
  onOpenAgent: (sessionId: string) => void;
}) {
  const { myActiveTickets, reviewPrs, mergePrs } = props;
  const now = useNow(30_000);
  const { features } = props;
  const cal = useCalendar(features.meetings);
  const folders = useProjectFolders(props.knownFolders);
  const [ticketFolders, setTicketFolder] = useTicketFolders();
  // Waiting first: those are the ones blocked on you.
  const liveAgents = props.agents
    .filter((a) => a.status !== "idle")
    .sort((a, b) => Number(b.status === "waiting") - Number(a.status === "waiting"));
  const waiting = liveAgents.filter((a) => a.status === "waiting").length;
  const anyCard = features.agents || features.prs || features.tickets;
  const meetingsLeft = (cal.byDay.get(dayKey(new Date(now))) ?? []).filter((e) => !e.all_day && e.end_ms > now).length;

  return (
    <section className="pane overview" aria-label="Overview">
      <div className="pane-header">
        <div>
          <span className="measured">
            {new Date(now).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
          </span>
          <h1>{greeting(now)}</h1>
        </div>
        {features.meetings && (
          <span className="lead overview-summary">
            {meetingsLeft ? `${meetingsLeft} meeting${meetingsLeft === 1 ? "" : "s"} left today` : "No more meetings today"}
          </span>
        )}
      </div>

      <div className="overview-layout" data-no-rail={!features.meetings || undefined}>
        <div className="overview-main">
          {features.meetings && <MeetingNow events={cal.events} error={cal.error} now={now} />}

          {anyCard && (
          <div className="overview-grid">
            {features.agents && (
            <Card title="Agents" alert={waiting > 0} empty="No agents working">
              {liveAgents.map((a) => (
                <Row
                  key={a.session_id}
                  id={a.name}
                  chip={a.status === "waiting" ? "Needs you" : undefined}
                  bad={a.status === "waiting"}
                  title={a.cwd}
                  onOpen={() => props.onOpenAgent(a.session_id)}
                />
              ))}
            </Card>
            )}
            {features.prs && (
            <Card title="Review requested" empty="No reviews waiting">
              {reviewPrs.map((p) => (
                <PrRow key={`${p.repo}#${p.number}`} pr={p} onOpen={() => props.onOpenPr(p, "review")} />
              ))}
            </Card>
            )}
            {features.tickets && (
            <Card title="My tickets in progress" empty="Nothing in progress">
              {myActiveTickets.map((t) => {
                const folder = ticketFolders[t.key] ?? ticketFolders[LAST_FOLDER] ?? "";
                return (
                  <Row key={t.key} id={t.key} chip={t.state === "InReview" ? "In review" : undefined} title={t.title} onOpen={() => props.onOpenTicket(t.key)}>
                    <div className="ticket-terminal">
                      <FolderPicker
                        id={`project-${t.key}`}
                        label={`Project for ${t.key}`}
                        value={folder}
                        options={[...new Set([folder, ...folders])].filter(Boolean)}
                        onChange={(f) => setTicketFolder(t.key, f)}
                      />
                      <button
                        type="button"
                        className="btn"
                        disabled={!folder}
                        onClick={() => {
                          setTicketFolder(t.key, folder);
                          props.onOpenInTerminal(folder);
                        }}
                      >
                        Open in terminal
                      </button>
                    </div>
                  </Row>
                );
              })}
            </Card>
            )}
            {features.prs && (
            <Card title="Ready to merge" empty="Nothing approved yet">
              {mergePrs.map((p) => (
                <PrRow key={`${p.repo}#${p.number}`} pr={p} onOpen={() => props.onOpenPr(p, "merge")} />
              ))}
            </Card>
            )}
          </div>
          )}
        </div>

        {features.meetings && (
          <aside className="overview-rail" aria-label="Calendar">
            <MonthCalendar cal={cal} now={now} />
            <Agenda day={cal.selected} events={cal.byDay.get(dayKey(cal.selected)) ?? []} now={now} />
          </aside>
        )}
      </div>
    </section>
  );
}

/** The shown month's events (plus today's, for the meeting card), refreshed every few minutes. */
function useCalendar(enabled: boolean) {
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [selected, setSelected] = useState(() => startOfDay(new Date()));
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const days = monthGrid(month);
  const today = startOfDay(new Date()).getTime();
  const from = Math.min(days[0].getTime(), today);
  const to = Math.max(days[days.length - 1].getTime() + DAY_MS, today + DAY_MS);

  useEffect(() => {
    if (!enabled) return;
    const load = () =>
      calendarEvents(from, to)
        .then((list) => {
          setEvents(list);
          setError(null);
        })
        .catch((err) => setError(String(err)));
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, CALENDAR_POLL_MS);
    return () => clearInterval(timer);
  }, [from, to, enabled]);

  // Day key -> events touching that day; an all-day or overnight event lands on each of its days.
  const byDay = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    for (let d = startOfDay(new Date(e.start_ms)); d.getTime() < Math.max(e.end_ms, e.start_ms + 1); d = addDays(d, 1)) {
      const k = dayKey(d);
      byDay.set(k, [...(byDay.get(k) ?? []), e]);
    }
  }

  function showMonth(next: Date) {
    setMonth(startOfMonth(next));
  }
  function select(day: Date) {
    setSelected(day);
    if (day.getMonth() !== month.getMonth()) showMonth(day);
  }
  return { month, days, selected, events, byDay, error, showMonth, select };
}

type CalendarState = ReturnType<typeof useCalendar>;

/** The meeting on now (with time elapsed and Join), else today's next one. */
function MeetingNow({ events, error, now }: { events: CalendarEvent[]; error: string | null; now: number }) {
  const today = dayKey(new Date(now));
  const timed = events.filter((e) => !e.all_day && dayKey(new Date(e.start_ms)) === today);
  const current = timed.find((e) => e.start_ms <= now && now < e.end_ms);
  const next = timed.find((e) => e.start_ms > now);
  const later = current && timed.find((e) => e.start_ms >= current.end_ms);
  const shown = current ?? next;

  if (error) {
    return (
      <div className="meeting-card" data-state="empty">
        <span className="meeting-eyebrow">Meetings</span>
        <p className="lead">{error}</p>
      </div>
    );
  }
  if (!shown) {
    return (
      <div className="meeting-card" data-state="empty">
        <span className="meeting-eyebrow">Meetings</span>
        <h2>No more meetings today</h2>
        <p className="lead">The rest of the day is clear for focus work.</p>
      </div>
    );
  }
  return (
    <div className="meeting-card" data-state={current ? "now" : "next"}>
      <div className="meeting-top">
        <span className="meeting-eyebrow">
          {current
            ? `Now · ${duration(current.end_ms - now)} left`
            : `Up next · in ${duration(shown.start_ms - now)}`}
        </span>
        {shown.join_url && (
          <button type="button" className="btn btn--primary" onClick={() => void openMeeting(shown.join_url!)}>
            Join
          </button>
        )}
      </div>
      <h2>{shown.title}</h2>
      <span className="measured-ink">
        {timeRange(shown)}
        {shown.location && !shown.location.startsWith("http") ? ` · ${shown.location}` : ""}
        {shown.calendar ? ` · ${shown.calendar}` : ""}
      </span>
      {current && (
        <progress
          className="meeting-progress"
          aria-label="Meeting time elapsed"
          max={current.end_ms - current.start_ms}
          value={now - current.start_ms}
        />
      )}
      {later && (
        <span className="record-meta">
          Then {later.title} at {clock(later.start_ms)}
        </span>
      )}
    </div>
  );
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function MonthCalendar({ cal, now }: { cal: CalendarState; now: number }) {
  const today = dayKey(new Date(now));
  return (
    <div className="month-cal">
      <div className="month-cal-head">
        <h2>{cal.month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h2>
        <div className="pane-tools">
          <button type="button" className="collapse-btn" aria-label="Previous month" onClick={() => cal.showMonth(addMonths(cal.month, -1))}>
            ‹
          </button>
          <button type="button" className="btn month-cal-today" onClick={() => cal.select(startOfDay(new Date(now)))}>
            Today
          </button>
          <button type="button" className="collapse-btn" aria-label="Next month" onClick={() => cal.showMonth(addMonths(cal.month, 1))}>
            ›
          </button>
        </div>
      </div>
      <div className="month-cal-grid" role="grid">
        {WEEKDAYS.map((w) => (
          <span key={w} className="month-cal-weekday" aria-hidden="true">
            {w[0]}
          </span>
        ))}
        {cal.days.map((d) => {
          const k = dayKey(d);
          const count = cal.byDay.get(k)?.length ?? 0;
          return (
            <button
              key={k}
              type="button"
              className="month-cal-day"
              data-today={k === today || undefined}
              data-selected={k === dayKey(cal.selected) || undefined}
              data-outside={d.getMonth() !== cal.month.getMonth() || undefined}
              aria-label={`${d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}, ${count} event${count === 1 ? "" : "s"}`}
              onClick={() => cal.select(d)}
            >
              {d.getDate()}
              <span className="month-cal-dots" aria-hidden="true">
                {Array.from({ length: Math.min(count, 3) }, (_, i) => (
                  <i key={i} />
                ))}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Agenda({ day, events, now }: { day: Date; events: CalendarEvent[]; now: number }) {
  return (
    <div className="agenda">
      <h2>{dayLabel(day.getTime(), now)}</h2>
      {events.length === 0 && <p className="record-meta">No meetings</p>}
      <ol className="agenda-list">
        {events.map((e) => {
          const state = e.end_ms <= now ? "past" : e.start_ms <= now ? "now" : "later";
          return (
            <li key={e.id} className="agenda-item" data-state={e.all_day ? "allday" : state}>
              <span className="agenda-time measured">{e.all_day ? "All day" : clock(e.start_ms)}</span>
              <span className="agenda-body">
                <span className="agenda-title">{e.title}</span>
                {!e.all_day && <span className="agenda-meta">{duration(e.end_ms - e.start_ms)}</span>}
              </span>
              {e.join_url && state !== "past" && (
                <button type="button" className="agenda-join" onClick={() => void openMeeting(e.join_url!)}>
                  Join
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Card(props: { title: string; empty: string; alert?: boolean; children: React.ReactNode[] }) {
  const count = props.children.length;
  if (!count) {
    return (
      <div className="overview-card" data-empty>
        <h2>{props.title}</h2>
        <span className="overview-card-empty">{props.empty}</span>
      </div>
    );
  }
  return (
    <div className="overview-card">
      <h2>
        {props.title} <span className="measured overview-count" data-alert={props.alert || undefined}>{count}</span>
      </h2>
      <ul className="record-list">{props.children}</ul>
    </div>
  );
}

function PrRow({ pr, onOpen }: { pr: PullRequest; onOpen: () => void }) {
  const failing = typeof pr.ci_state === "object" && "Failing" in pr.ci_state;
  return (
    <Row
      id={`${pr.repo.split("/").pop()}#${pr.number}`}
      chip={failing ? "CI failing" : undefined}
      bad={failing}
      title={pr.title}
      onOpen={onOpen}
    />
  );
}

function Row(props: {
  id: string;
  /** Only when it adds to the section heading (a failing check, a different state). */
  chip?: string;
  bad?: boolean;
  title: string;
  onOpen: () => void;
  children?: React.ReactNode;
}) {
  return (
    <li className="record-item">
      <div className="record-top">
        <button type="button" className="record-select-btn" onClick={props.onOpen}>
          {props.id}
        </button>
        <span className="record-title" title={props.title}>{props.title}</span>
        {props.chip && <span className={props.bad ? "chip chip--bad" : "chip"}>{props.chip}</span>}
      </div>
      {props.children}
    </li>
  );
}

/** Type-to-filter folder picker (ARIA combobox); the matches open in place under the field. */
function FolderPicker(props: {
  id: string;
  label: string;
  value: string;
  options: string[];
  onChange: (folder: string) => void;
}) {
  // null while closed; otherwise what's typed so far.
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const name = (f: string) => f.replace(/^~\//, "");
  const matches = props.options.filter((f) => name(f).toLowerCase().includes((query ?? "").toLowerCase()));
  const listId = `${props.id}-list`;

  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function pick(folder: string | undefined, input: HTMLElement | null) {
    if (folder) props.onChange(folder);
    input?.blur();
  }

  return (
    <div className="folder-picker">
      <input
        id={props.id}
        type="text"
        role="combobox"
        className="input-field"
        aria-label={props.label}
        aria-expanded={query !== null}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={query !== null && matches[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={props.value ? name(props.value) : "Search projects…"}
        value={query ?? (props.value ? name(props.value) : "")}
        onFocus={() => {
          setQuery("");
          setActive(0);
        }}
        onBlur={() => setQuery(null)}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          const n = matches.length;
          if ((e.key === "ArrowDown" || e.key === "ArrowUp") && n) {
            e.preventDefault();
            setActive((a) => (a + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
          } else if (e.key === "Enter") {
            e.preventDefault();
            pick(matches[active], e.currentTarget);
          } else if (e.key === "Escape") {
            e.currentTarget.blur();
          }
        }}
      />
      {query !== null && (
        <ul id={listId} ref={listRef} role="listbox" aria-label={props.label} className="folder-picker-list">
          {matches.map((f, i) => (
            <li
              key={f}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              data-current={f === props.value || undefined}
              // mousedown, so the pick lands before the field loses focus and closes the list
              onMouseDown={(e) => {
                e.preventDefault();
                pick(f, document.getElementById(props.id));
              }}
              onMouseEnter={() => setActive(i)}
            >
              {name(f)}
            </li>
          ))}
          {matches.length === 0 && <li className="folder-picker-empty">No matching folder</li>}
        </ul>
      )}
    </div>
  );
}

/**
 * Folders to pick a ticket's project from: the known ones plus their siblings
 * (a known ~/project/a also offers everything else in ~/project).
 */
function useProjectFolders(known: string[]): string[] {
  const [found, setFound] = useState<string[]>([]);
  const ok = known.filter((f) => f.startsWith("~/"));
  const parents = parentFolders(ok);
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    void listSubfolders(parents).then(setFound);
  }, [parents.join("\n")]);
  return [...new Set([...ok, ...found])].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** The distinct parent folders of `~/` paths, leaving out `~` itself. */
function parentFolders(paths: string[]): string[] {
  return [...new Set(paths.map((f) => f.slice(0, f.lastIndexOf("/"))))].filter((p) => p !== "~");
}

/** The sub-folders (no dot-folders) of each of `parents`. */
async function listSubfolders(parents: string[]): Promise<string[]> {
  const lists = await Promise.all(
    parents.map((p) =>
      folderList(p)
        .then((entries) => entries.filter((e) => e.is_dir && !e.name.startsWith(".")).map((e) => `${p}/${e.name}`))
        .catch(() => [])
    )
  );
  return lists.flat();
}

/** `known` plus the sub-folders of their parents: where sibling projects live. */
export async function withSiblingFolders(known: string[]): Promise<string[]> {
  const ok = known.filter((f) => f.startsWith("~/"));
  return [...new Set([...ok, ...(await listSubfolders(parentFolders(ok)))])];
}

const TICKET_FOLDERS_KEY = "panguyuban.ticketFolders";
/** Stands in for "the folder picked most recently", the default for tickets not yet picked. */
const LAST_FOLDER = "";

/** Ticket key -> the project folder picked for it, remembered on this machine. */
function useTicketFolders(): [Record<string, string>, (ticketKey: string, folder: string) => void] {
  const [map, setMap] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem(TICKET_FOLDERS_KEY) ?? "{}");
    } catch {
      return {};
    }
  });
  function set(ticketKey: string, folder: string) {
    const next = { ...map, [ticketKey]: folder, [LAST_FOLDER]: folder };
    setMap(next);
    try {
      localStorage.setItem(TICKET_FOLDERS_KEY, JSON.stringify(next));
    } catch {
      // storage unavailable: the pick lasts until the app closes
    }
  }
  return [map, set];
}

function greeting(now: number): string {
  const h = new Date(now).getHours();
  return h < 11 ? "Good morning" : h < 15 ? "Good afternoon" : "Good evening";
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const timeRange = (e: CalendarEvent) => (e.all_day ? "All day" : `${clock(e.start_ms)} – ${clock(e.end_ms)}`);

function dayLabel(ms: number, now = Date.now()): string {
  const diff = Math.round((startOfDay(new Date(ms)).getTime() - startOfDay(new Date(now)).getTime()) / DAY_MS);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return new Date(ms).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, 1);

/** Six Monday-first weeks covering `month`. */
function monthGrid(month: Date): Date[] {
  const first = addDays(month, -((month.getDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}
