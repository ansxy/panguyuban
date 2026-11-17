//! Session types from the skill registry, and what Settings may narrow.

use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::REGISTRY;

/// One kind of session the user can start, as listed in `skills/registry.toml`.
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct SessionType {
    pub id: String,
    pub label_en: String,
    pub skill: String,
    pub engineering_skills: Vec<String>,
    pub phase: String,
    pub write_paths: Vec<String>,
    pub shell: bool,
    pub status: String,
    /// The most the agent may use. Empty = the session does not use the harness.
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub hooks: Vec<String>,
    #[serde(default)]
    pub max_steps: u32,
    #[serde(default)]
    pub timeout_minutes: u32,
}

#[derive(Deserialize)]
struct Registry {
    session_type: Vec<SessionType>,
}

fn all() -> &'static [SessionType] {
    static PARSED: OnceLock<Registry> = OnceLock::new();
    &PARSED
        .get_or_init(|| toml::from_str(REGISTRY).unwrap_or_else(|e| panic!("skills/registry.toml is invalid: {e}")))
        .session_type
}

pub fn session_type(id: &str) -> Option<SessionType> {
    all().iter().find(|s| s.id == id).cloned()
}

/// The sessions that run through the harness, those with tools.
pub fn harness_sessions() -> Vec<SessionType> {
    all().iter().filter(|s| !s.tools.is_empty()).cloned().collect()
}

/// What the user saved in Settings. `None` = the registry value.
#[derive(Deserialize, Serialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HarnessSettings {
    pub tools: Option<Vec<String>>,
    pub hooks: Option<Vec<String>>,
    pub max_steps: Option<u32>,
    pub timeout_minutes: Option<u32>,
}

/// What one run may use: the registry ceiling, narrowed by Settings.
#[derive(Debug, Clone)]
pub struct Effective {
    pub tools: Vec<String>,
    pub hooks: Vec<String>,
    pub max_steps: u32,
    pub timeout: Duration,
}

/// Settings can only switch things off or lower limits. Unknown names are ignored.
pub fn effective(session: &SessionType, saved: Option<&HarnessSettings>) -> Effective {
    let narrow = |ceiling: &[String], saved: Option<&Vec<String>>| -> Vec<String> {
        ceiling.iter().filter(|name| saved.is_none_or(|s| s.contains(name))).cloned().collect()
    };
    let clamp = |ceiling: u32, saved: Option<u32>| saved.map_or(ceiling, |v| v.clamp(1, ceiling.max(1)));
    let minutes = clamp(session.timeout_minutes, saved.and_then(|s| s.timeout_minutes));
    Effective {
        tools: narrow(&session.tools, saved.and_then(|s| s.tools.as_ref())),
        hooks: narrow(&session.hooks, saved.and_then(|s| s.hooks.as_ref())),
        max_steps: clamp(session.max_steps, saved.and_then(|s| s.max_steps)),
        timeout: Duration::from_secs(u64::from(minutes) * 60),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_session_is_one_file_and_no_shell() {
        let s = session_type("build-next-story").unwrap();
        assert_eq!(s.write_paths, ["app/index.html"]);
        assert!(!s.shell);
        assert!(s.engineering_skills.is_empty());
    }

    #[test]
    fn interview_session_writes_only_the_prd() {
        assert_eq!(session_type("start-new-app").unwrap().write_paths, ["prd.md"]);
    }

    #[test]
    fn unknown_sessions_are_none() {
        assert!(session_type("nope").is_none());
    }

    #[test]
    fn nothing_saved_means_the_registry_ceiling() {
        let e = effective(&session_type("build-next-story").unwrap(), None);
        assert_eq!(e.tools, ["read_file", "list_files", "search", "write_file", "edit_file"]);
        assert_eq!(e.hooks, ["no_external_urls"]);
        assert_eq!((e.max_steps, e.timeout), (40, Duration::from_secs(15 * 60)));
    }

    #[test]
    fn settings_only_narrow() {
        let s = session_type("build-next-story").unwrap();
        let saved = HarnessSettings {
            tools: Some(vec!["edit_file".into(), "read_file".into(), "run_command".into()]),
            hooks: Some(vec![]),
            max_steps: Some(500),
            timeout_minutes: Some(0),
        };
        let e = effective(&s, Some(&saved));
        assert_eq!(e.tools, ["read_file", "edit_file"]); // registry order, run_command dropped
        assert!(e.hooks.is_empty());
        assert_eq!((e.max_steps, e.timeout), (40, Duration::from_secs(60))); // clamped to 1..=ceiling
    }

    #[test]
    fn only_sessions_with_tools_use_the_harness() {
        assert_eq!(harness_sessions().iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["build-next-story"]);
    }
}
