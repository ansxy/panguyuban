//! Meetings from the Mac's Calendar app (every account it syncs, read through EventKit),
//! plus, on any OS, a calendar's iCal (ICS) link and an imported .ics file.

use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Duration;

use chrono::{NaiveDate, NaiveDateTime, TimeZone, Utc};
use rrule::{RRule, RRuleSet, Tz, Unvalidated};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct CalendarEvent {
    pub id: String,
    pub title: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub all_day: bool,
    pub calendar: String,
    pub location: Option<String>,
    /// Video call link found in the event's URL, location or notes.
    pub join_url: Option<String>,
}

/// First Google Meet / Zoom / Teams link in `fields`.
pub fn join_url(fields: &[Option<String>]) -> Option<String> {
    const HOSTS: [&str; 4] = ["meet.google.com/", "zoom.us/", "teams.microsoft.com/", "teams.live.com/"];
    fields
        .iter()
        .flatten()
        .flat_map(|s| s.split(|c: char| c.is_whitespace() || "<>\"'()".contains(c)))
        .find(|w| w.starts_with("https://") && HOSTS.iter().any(|h| w.contains(h)))
        .map(str::to_string)
}

/// Events from every source the user has, overlapping `from_ms..to_ms`, sorted by start.
/// A source that fails only shows its error when no source works.
pub async fn events(ics_url: Option<String>, from_ms: i64, to_ms: i64) -> Result<Vec<CalendarEvent>, String> {
    let mut out = Vec::new();
    let mut errors = Vec::new();
    let mut any_ok = false;
    let mut add = |r: Result<Vec<CalendarEvent>, String>| match r {
        Ok(list) => {
            any_ok = true;
            out.extend(list)
        }
        Err(e) => errors.push(e),
    };

    #[cfg(target_os = "macos")]
    add(tokio::task::spawn_blocking(move || mac_events(from_ms, to_ms))
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r));
    if let Some(url) = ics_url {
        add(fetch_ics(&url).await.map(|ics| ics_events(&ics, "Calendar link", from_ms, to_ms)));
    }
    if let Ok(ics) = std::fs::read_to_string(imported_path()) {
        add(Ok(ics_events(&ics, "Imported", from_ms, to_ms)));
    }

    if !any_ok {
        return Err(if errors.is_empty() {
            "Add a calendar link or import an .ics file in Settings to see meetings here.".into()
        } else {
            errors.join(" ")
        });
    }
    out.sort_by_key(|e| e.start_ms);
    Ok(out)
}

/// Where an imported .ics file is kept, next to the app's state.db.
pub fn imported_path() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("panguyuban")
        .join("calendar.ics")
}

/// Keeps a copy of an .ics file's text as the imported calendar. Returns its event count.
pub fn import(ics: &str) -> Result<usize, String> {
    let count = ics.matches("BEGIN:VEVENT").count();
    if count == 0 {
        return Err("No events in that file. Pick an .ics calendar export.".into());
    }
    let path = imported_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, ics).map_err(|e| e.to_string())?;
    Ok(count)
}

/// Downloads an iCal feed. The link is a secret, so errors never include it.
async fn fetch_ics(url: &str) -> Result<String, String> {
    let url = match url.strip_prefix("webcal://") {
        Some(rest) => format!("https://{rest}"),
        None => url.to_string(),
    };
    if !url.starts_with("https://") {
        return Err("The calendar link must start with https:// or webcal://.".into());
    }
    let res = reqwest::Client::new()
        .get(&url)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Calendar link: {}", e.without_url()))?;
    res.text().await.map_err(|e| format!("Calendar link: {}", e.without_url()))
}

/// Events in ICS text overlapping `from_ms..to_ms`, recurring ones expanded.
/// `fallback_name` names the calendar when the file has no X-WR-CALNAME.
pub fn ics_events(ics: &str, fallback_name: &str, from_ms: i64, to_ms: i64) -> Vec<CalendarEvent> {
    // Unfold: a line starting with a space or tab continues the previous one.
    let text = ics.replace("\r\n", "\n").replace("\n ", "").replace("\n\t", "");
    let mut calendar = fallback_name.to_string();
    let mut vevents: Vec<Vec<Prop>> = Vec::new();
    let mut current: Option<Vec<Prop>> = None;
    for line in text.lines() {
        match line {
            "BEGIN:VEVENT" => current = Some(Vec::new()),
            "END:VEVENT" => vevents.extend(current.take()),
            _ => {
                let Some(prop) = Prop::parse(line) else { continue };
                match &mut current {
                    Some(props) => props.push(prop),
                    None if prop.name == "X-WR-CALNAME" => calendar = unescape(&prop.value),
                    None => {}
                }
            }
        }
    }

    // A changed or cancelled instance of a recurring event comes as its own VEVENT
    // carrying RECURRENCE-ID; the series must skip that instance.
    let replaced: HashSet<(String, i64)> = vevents
        .iter()
        .filter_map(|ev| {
            let id = find(ev, "RECURRENCE-ID")?;
            Some((find(ev, "UID")?.value.clone(), parse_time(id)?.0.timestamp_millis()))
        })
        .collect();

    let window_start = ms_to_tz(from_ms);
    let window_end = ms_to_tz(to_ms);
    let mut out = Vec::new();
    for ev in &vevents {
        if find(ev, "STATUS").is_some_and(|p| p.value.eq_ignore_ascii_case("CANCELLED")) {
            continue;
        }
        let Some((start, all_day)) = find(ev, "DTSTART").and_then(parse_time) else { continue };
        let end = find(ev, "DTEND")
            .and_then(parse_time)
            .map(|(t, _)| t)
            .or_else(|| find(ev, "DURATION").and_then(|p| parse_duration(&p.value)).map(|d| start + d))
            .unwrap_or(start + if all_day { chrono::Duration::days(1) } else { chrono::Duration::zero() });
        let length = end - start;
        let uid = find(ev, "UID").map(|p| p.value.clone()).unwrap_or_default();

        let starts = match find(ev, "RRULE") {
            Some(rule) if find(ev, "RECURRENCE-ID").is_none() => {
                expand(rule, ev, start, window_start - length, window_end).unwrap_or(vec![start])
            }
            _ => vec![start],
        };
        let text_of = |name: &str| find(ev, name).map(|p| unescape(&p.value));
        let location = text_of("LOCATION").filter(|s| !s.is_empty());
        let link = join_url(&[text_of("URL"), location.clone(), text_of("DESCRIPTION")]);
        for s in starts {
            let (start_ms, end_ms) = (s.timestamp_millis(), (s + length).timestamp_millis());
            let is_series = find(ev, "RRULE").is_some();
            if end_ms.max(start_ms + 1) <= from_ms
                || start_ms >= to_ms
                || (is_series && replaced.contains(&(uid.clone(), start_ms)))
            {
                continue;
            }
            out.push(CalendarEvent {
                id: format!("{uid}@{start_ms}"),
                title: text_of("SUMMARY").unwrap_or_default(),
                start_ms,
                end_ms,
                all_day,
                calendar: calendar.clone(),
                location: location.clone(),
                join_url: link.clone(),
            });
        }
    }
    out
}

/// Starts of a recurring event between `after` and `before`, minus its EXDATEs.
fn expand(
    rule: &Prop,
    ev: &[Prop],
    start: chrono::DateTime<Tz>,
    after: chrono::DateTime<Tz>,
    before: chrono::DateTime<Tz>,
) -> Option<Vec<chrono::DateTime<Tz>>> {
    let rule = rule.value.parse::<RRule<Unvalidated>>().ok()?.validate(start).ok()?;
    let mut set = RRuleSet::new(start).rrule(rule).after(after).before(before);
    for ex in ev.iter().filter(|p| p.name == "EXDATE") {
        for value in ex.value.split(',') {
            let one = Prop { name: ex.name.clone(), params: ex.params.clone(), value: value.to_string() };
            if let Some((t, _)) = parse_time(&one) {
                set = set.exdate(t);
            }
        }
    }
    // ponytail: 1000 instances per series per window; a month view never gets near it.
    Some(set.all(1000).dates)
}

/// One ICS content line: `NAME;PARAM=x;PARAM="y":value`.
struct Prop {
    name: String,
    params: String,
    value: String,
}

impl Prop {
    fn parse(line: &str) -> Option<Prop> {
        // The value starts at the first colon outside a quoted parameter.
        let mut quoted = false;
        let colon = line.char_indices().find_map(|(i, c)| {
            if c == '"' {
                quoted = !quoted;
            }
            (c == ':' && !quoted).then_some(i)
        })?;
        let (head, value) = (&line[..colon], &line[colon + 1..]);
        let (name, params) = head.split_once(';').unwrap_or((head, ""));
        Some(Prop { name: name.to_ascii_uppercase(), params: params.to_string(), value: value.to_string() })
    }

    fn param(&self, key: &str) -> Option<&str> {
        self.params.split(';').find_map(|kv| {
            let (k, v) = kv.split_once('=')?;
            k.eq_ignore_ascii_case(key).then(|| v.trim_matches('"'))
        })
    }
}

fn find<'a>(ev: &'a [Prop], name: &str) -> Option<&'a Prop> {
    ev.iter().find(|p| p.name == name)
}

/// A DATE or DATE-TIME value in its zone, and whether it was a whole day.
fn parse_time(p: &Prop) -> Option<(chrono::DateTime<Tz>, bool)> {
    let v = p.value.trim();
    if v.len() == 8 {
        let day = NaiveDate::parse_from_str(v, "%Y%m%d").ok()?.and_hms_opt(0, 0, 0)?;
        return Some((Tz::LOCAL.from_local_datetime(&day).earliest()?, true));
    }
    if let Some(utc) = v.strip_suffix('Z') {
        let t = NaiveDateTime::parse_from_str(utc, "%Y%m%dT%H%M%S").ok()?;
        return Some((Utc.from_utc_datetime(&t).with_timezone(&Tz::Tz(chrono_tz::UTC)), false));
    }
    let t = NaiveDateTime::parse_from_str(v, "%Y%m%dT%H%M%S").ok()?;
    // ponytail: TZIDs that aren't IANA names (Outlook's "SE Asia Standard Time") are read
    // as local time; map Windows names or read VTIMEZONE if those feeds come out shifted.
    let tz = p.param("TZID").and_then(|id| id.parse::<chrono_tz::Tz>().ok()).map_or(Tz::LOCAL, Tz::Tz);
    Some((tz.from_local_datetime(&t).earliest()?, false))
}

/// An ICS DURATION such as `PT1H30M`, `P1D` or `P2W`.
fn parse_duration(v: &str) -> Option<chrono::Duration> {
    let v = v.strip_prefix('+').unwrap_or(v).strip_prefix('P')?;
    let mut total = chrono::Duration::zero();
    let mut num = String::new();
    for c in v.chars() {
        match c {
            '0'..='9' => num.push(c),
            'T' => {}
            unit => {
                let n: i64 = std::mem::take(&mut num).parse().ok()?;
                total += match unit {
                    'W' => chrono::Duration::weeks(n),
                    'D' => chrono::Duration::days(n),
                    'H' => chrono::Duration::hours(n),
                    'M' => chrono::Duration::minutes(n),
                    'S' => chrono::Duration::seconds(n),
                    _ => return None,
                };
            }
        }
    }
    Some(total)
}

fn unescape(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    let mut chars = v.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n' | 'N') => out.push('\n'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

fn ms_to_tz(ms: i64) -> chrono::DateTime<Tz> {
    Utc.timestamp_millis_opt(ms).single().unwrap_or_default().with_timezone(&Tz::Tz(chrono_tz::UTC))
}

/// Events overlapping `from_ms..to_ms` in the Mac's Calendar app, recurring ones expanded.
/// Asks for Calendar access the first time.
#[cfg(target_os = "macos")]
fn mac_events(from_ms: i64, to_ms: i64) -> Result<Vec<CalendarEvent>, String> {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_event_kit::{EKAuthorizationStatus, EKEntityType, EKEventStore};
    use objc2_foundation::{NSDate, NSError};
    use std::sync::mpsc;

    let ms = |d: &NSDate| (d.timeIntervalSince1970() * 1000.0) as i64;
    unsafe {
        if EKEventStore::authorizationStatusForEntityType(EKEntityType::Event)
            != EKAuthorizationStatus::FullAccess
        {
            let (tx, rx) = mpsc::channel();
            let done = RcBlock::new(move |granted: Bool, _: *mut NSError| {
                let _ = tx.send(granted.as_bool());
            });
            // ponytail: macOS 14+ API; older macOS would need requestAccessToEntityType.
            EKEventStore::new().requestFullAccessToEventsWithCompletion(RcBlock::as_ptr(&done));
            if !rx.recv().unwrap_or(false) {
                return Err("Calendar access is off. Allow Panguyuban in System Settings → Privacy & Security → Calendars.".into());
            }
        }

        // ponytail: a fresh store per call (cheap enough at one call a minute); keep one if polling gets faster.
        let store = EKEventStore::new();
        let start = NSDate::dateWithTimeIntervalSince1970(from_ms as f64 / 1000.0);
        let end = NSDate::dateWithTimeIntervalSince1970(to_ms as f64 / 1000.0);
        let predicate = store.predicateForEventsWithStartDate_endDate_calendars(&start, &end, None);
        let mut out: Vec<CalendarEvent> = store
            .eventsMatchingPredicate(&predicate)
            .iter()
            .map(|e| {
                let location = e.location().map(|s| s.to_string());
                let url = e.URL().and_then(|u| u.absoluteString()).map(|s| s.to_string());
                let notes = e.notes().map(|s| s.to_string());
                CalendarEvent {
                    id: format!("{}@{}", e.calendarItemIdentifier(), ms(&e.startDate())),
                    title: e.title().to_string(),
                    start_ms: ms(&e.startDate()),
                    end_ms: ms(&e.endDate()),
                    all_day: e.isAllDay(),
                    calendar: e.calendar().map(|c| c.title().to_string()).unwrap_or_default(),
                    join_url: join_url(&[url, location.clone(), notes]),
                    location,
                }
            })
            .collect();
        out.sort_by_key(|e| e.start_ms);
        Ok(out)
    }
}

/// Opens a meeting link in the default browser (or the Zoom/Teams app that claims it).
pub fn open_url(url: &str) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err(format!("Not an https link: {url}"));
    }
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    // rundll32 rather than `cmd /c start`, so `&` in a link isn't read by the shell.
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler");
        c
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut cmd = std::process::Command::new("xdg-open");
    cmd.arg(url)
        .status()
        .map_err(|e| e.to_string())
        .and_then(|s| if s.success() { Ok(()) } else { Err(format!("open exited with {s}")) })
}

#[cfg(test)]
mod tests {
    use super::{ics_events, join_url};

    const ICS: &str = "BEGIN:VCALENDAR\r
X-WR-CALNAME:Team\r
BEGIN:VEVENT\r
UID:standup\r
DTSTART;TZID=Asia/Jakarta:20261102T093000\r
DTEND;TZID=Asia/Jakarta:20261102T094500\r
RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261231T000000Z\r
EXDATE;TZID=Asia/Jakarta:20261104T093000\r
SUMMARY:Daily standup\r
DESCRIPTION:Join: https://meet.google.com/abc-defg-hij\\nDial-in\\, \r
 more text\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:standup\r
RECURRENCE-ID;TZID=Asia/Jakarta:20261109T093000\r
DTSTART;TZID=Asia/Jakarta:20261109T110000\r
DURATION:PT30M\r
SUMMARY:Standup (moved)\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:holiday\r
DTSTART;VALUE=DATE:20261105\r
DTEND;VALUE=DATE:20261106\r
SUMMARY:Holiday\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:gone\r
DTSTART:20261103T020000Z\r
DTEND:20261103T030000Z\r
STATUS:CANCELLED\r
SUMMARY:Cancelled\r
END:VEVENT\r
END:VCALENDAR\r
";

    #[test]
    fn reads_ics_feeds() {
        // 2026-11-02 00:00 UTC to 2026-11-12 00:00 UTC.
        let (from, to) = (1_793_577_600_000, 1_794_441_600_000);
        let mut evs = ics_events(ICS, "Calendar link", from, to);
        evs.sort_by_key(|e| e.start_ms);
        let list: Vec<(&str, i64)> = evs.iter().map(|e| (e.title.as_str(), e.start_ms)).collect();
        // 09:30 Jakarta (UTC+7) = 02:30 UTC. Wed 4th is excluded, Mon 9th moved to 11:00.
        let at = |day: i64, h: i64, m: i64| from + (day - 2) * 86_400_000 + (h * 60 + m) * 60_000;
        let holiday = evs.iter().find(|e| e.title == "Holiday").unwrap();
        assert!(holiday.all_day);
        let timed: Vec<_> = list.iter().filter(|(t, _)| *t != "Holiday").cloned().collect();
        assert_eq!(
            timed,
            vec![
                ("Daily standup", at(2, 2, 30)),
                ("Standup (moved)", at(9, 4, 0)),
                ("Daily standup", at(11, 2, 30)),
            ]
        );
        assert_eq!(evs[0].end_ms - evs[0].start_ms, 15 * 60_000);
        assert_eq!(evs[0].calendar, "Team");
        assert_eq!(evs[0].join_url.as_deref(), Some("https://meet.google.com/abc-defg-hij"));
    }

    #[test]
    fn finds_meeting_links() {
        let s = |v: &str| Some(v.to_string());
        assert_eq!(
            join_url(&[None, s("Room 3"), s("Join: <https://meet.google.com/abc-defg-hij>\nDial-in ...")]),
            s("https://meet.google.com/abc-defg-hij")
        );
        assert_eq!(join_url(&[s("https://acme.zoom.us/j/123?pwd=x")]), s("https://acme.zoom.us/j/123?pwd=x"));
        assert_eq!(join_url(&[s("https://example.com/agenda"), s("Room 3")]), None);
        assert_eq!(join_url(&[s("http://meet.google.com/insecure")]), None);
    }
}
