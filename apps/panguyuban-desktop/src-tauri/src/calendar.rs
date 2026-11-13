//! Meetings from the Mac's Calendar app (every account it syncs), read through EventKit.

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

/// Events overlapping `from_ms..to_ms`, recurring ones expanded, sorted by start.
/// Asks for Calendar access the first time.
#[cfg(target_os = "macos")]
pub fn events(from_ms: i64, to_ms: i64) -> Result<Vec<CalendarEvent>, String> {
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

#[cfg(not(target_os = "macos"))]
pub fn events(_from_ms: i64, _to_ms: i64) -> Result<Vec<CalendarEvent>, String> {
    Err("Meetings come from the macOS Calendar app, so they only show on a Mac.".into())
}

/// Opens a meeting link in the default browser (or the Zoom/Teams app that claims it).
pub fn open_url(url: &str) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err(format!("Not an https link: {url}"));
    }
    std::process::Command::new("open")
        .arg(url)
        .status()
        .map_err(|e| e.to_string())
        .and_then(|s| if s.success() { Ok(()) } else { Err(format!("open exited with {s}")) })
}

#[cfg(test)]
mod tests {
    use super::join_url;

    #[test]
    fn finds_meeting_links() {
        let s = |v: &str| Some(v.to_string());
        assert_eq!(
            join_url(&[None, s("Room 3"), s("Join: <https://meet.google.com/abc-defg-hij>\nDial-in ...")]),
            s("https://meet.google.com/abc-defg-hij")
        );
        assert_eq!(join_url(&[s("https://rey.zoom.us/j/123?pwd=x")]), s("https://rey.zoom.us/j/123?pwd=x"));
        assert_eq!(join_url(&[s("https://example.com/agenda"), s("Room 3")]), None);
        assert_eq!(join_url(&[s("http://meet.google.com/insecure")]), None);
    }
}
