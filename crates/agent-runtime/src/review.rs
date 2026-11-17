//! Team review of a draft PRD: one call per role, the leader last.

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::{strip_frontmatter, AgentRuntime, RuntimeError};

const REVIEW_SKILL: &str = include_str!("../../../skills/product/prd-review/SKILL.md");
const REVIEW_OPEN: &str = "<review>";
const REVIEW_CLOSE: &str = "</review>";
const REVIEW_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_FINDINGS: usize = 5;
const MAX_TEXT_CHARS: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewRole {
    Engineer,
    Ux,
    Qa,
    Contrarian,
    Leader,
}

impl ReviewRole {
    fn label(self) -> &'static str {
        match self {
            Self::Engineer => "Engineer",
            Self::Ux => "UX",
            Self::Qa => "QA",
            Self::Contrarian => "Contrarian",
            Self::Leader => "Leader",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Blocker,
    Suggestion,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Finding {
    pub severity: Severity,
    pub step: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoleReview {
    pub role: ReviewRole,
    pub findings: Vec<Finding>,
    #[serde(default)]
    pub verdict: String,
    #[serde(default)]
    pub fixes: String,
}

#[derive(Deserialize)]
struct RawFinding {
    #[serde(default)]
    severity: String,
    #[serde(default)]
    step: serde_json::Value,
    text: String,
}

#[derive(Deserialize)]
struct RawReview {
    findings: Vec<RawFinding>,
    #[serde(default)]
    verdict: String,
    #[serde(default)]
    fixes: serde_json::Value,
}

pub fn review_system_prompt(role: ReviewRole) -> String {
    format!(
        "{}\n\n---\n\nYou are the {}. Follow the shared rules and your section only.\nYou have no tools. You cannot read, write or run anything.",
        strip_frontmatter(REVIEW_SKILL).trim(),
        role.label()
    )
}

pub fn review_prompt(prd: &str, earlier: &[RoleReview]) -> String {
    let mut prompt = format!("Draft PRD:\n\n{}\n\n", prd.trim());
    if !earlier.is_empty() {
        let json = serde_json::to_string_pretty(earlier).unwrap_or_default();
        prompt.push_str(&format!("Findings so far:\n\n{json}\n\n"));
    }
    prompt.push_str("Send your review.");
    prompt
}

/// Step ids from `### S<n>. …` headings, in order.
pub fn prd_step_ids(prd: &str) -> Vec<String> {
    prd.lines()
        .filter_map(|line| {
            let rest = line.trim().strip_prefix("### S")?;
            let digits = rest.split('.').next()?;
            (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
                .then(|| format!("S{digits}"))
        })
        .collect()
}

/// Reads a review from between the tags, or from the whole reply if the tags are missing.
/// Unknown severities become suggestions and unknown steps become `None`.
pub fn parse_review(
    role: ReviewRole,
    raw: &str,
    step_ids: &[String],
) -> Result<RoleReview, String> {
    let text = raw.trim();
    let body = match text.find(REVIEW_OPEN) {
        Some(start) => {
            let after = &text[start + REVIEW_OPEN.len()..];
            after.find(REVIEW_CLOSE).map_or(after, |end| &after[..end])
        }
        None => text,
    };
    let json = match (body.find('{'), body.rfind('}')) {
        (Some(start), Some(end)) if start < end => &body[start..=end],
        _ => return Err("no review in the reply".into()),
    };
    let parsed: RawReview = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let findings = parsed
        .findings
        .into_iter()
        .take(MAX_FINDINGS)
        .map(|f| {
            let step = match &f.step {
                serde_json::Value::String(s) => Some(s.trim().to_uppercase()),
                serde_json::Value::Number(n) => Some(format!("S{n}")),
                _ => None,
            }
            .filter(|s| step_ids.contains(s));
            Finding {
                severity: if f.severity.trim().eq_ignore_ascii_case("blocker") {
                    Severity::Blocker
                } else {
                    Severity::Suggestion
                },
                step,
                text: f.text.trim().chars().take(MAX_TEXT_CHARS).collect(),
            }
        })
        .collect();
    Ok(RoleReview {
        role,
        findings,
        verdict: parsed.verdict.trim().to_string(),
        fixes: match parsed.fixes {
            serde_json::Value::String(s) => s.trim().to_string(),
            serde_json::Value::Array(a) => a
                .iter()
                .filter_map(|v| v.as_str())
                .map(str::trim)
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        },
    })
}

/// Runs one role's review of the draft PRD.
pub fn review_turn(
    runtime: &dyn AgentRuntime,
    role: ReviewRole,
    prd: &str,
    earlier: &[RoleReview],
    model: Option<&str>,
    work_dir: &Path,
) -> Result<RoleReview, RuntimeError> {
    let raw = runtime.complete(
        &review_system_prompt(role),
        &review_prompt(prd, earlier),
        model,
        work_dir,
        REVIEW_TIMEOUT,
    )?;
    parse_review(role, &raw, &prd_step_ids(prd)).map_err(|detail| RuntimeError::Failed {
        harness: runtime.harness(),
        detail: format!("its review could not be read ({detail})"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRD: &str = "# Orders\n\n## 4. Steps\n\n### S1. Place an order\nAcme customer submits ORD-2041.\n\n### S2. Track an order\nStatus page.\n";
    const ROLES: [ReviewRole; 5] = [
        ReviewRole::Engineer,
        ReviewRole::Ux,
        ReviewRole::Qa,
        ReviewRole::Contrarian,
        ReviewRole::Leader,
    ];

    fn ids() -> Vec<String> {
        vec!["S1".into(), "S2".into()]
    }

    #[test]
    fn parses_tagged_json() {
        let raw = r#"<review>{"findings":[{"severity":"blocker","step":"S1","text":"No payment provider"}]}</review>"#;
        let r = parse_review(ReviewRole::Engineer, raw, &ids()).unwrap();
        assert_eq!(r.findings.len(), 1);
        assert_eq!(r.findings[0].severity, Severity::Blocker);
        assert_eq!(r.findings[0].step.as_deref(), Some("S1"));
    }

    #[test]
    fn tolerates_fence_and_missing_tags() {
        let raw = "Here:\n```json\n{\"findings\":[]}\n```";
        let r = parse_review(ReviewRole::Qa, raw, &ids()).unwrap();
        assert!(r.findings.is_empty());
    }

    #[test]
    fn no_json_is_an_error() {
        assert!(parse_review(ReviewRole::Ux, "Looks fine to me.", &ids()).is_err());
    }

    #[test]
    fn coerces_unknown_severity_and_step() {
        let raw = r#"{"findings":[{"severity":"critical","step":"S9","text":"a"},{"severity":"suggestion","step":"s2","text":"b"}]}"#;
        let r = parse_review(ReviewRole::Ux, raw, &ids()).unwrap();
        assert_eq!(r.findings[0].severity, Severity::Suggestion);
        assert_eq!(r.findings[0].step, None);
        assert_eq!(r.findings[1].step.as_deref(), Some("S2"));
    }

    #[test]
    fn caps_count_and_length() {
        let long = "x".repeat(400);
        let mut items = vec![format!(r#"{{"severity":"suggestion","step":null,"text":"{long}"}}"#)];
        for i in 0..6 {
            items.push(format!(r#"{{"severity":"suggestion","step":null,"text":"f{i}"}}"#));
        }
        let raw = format!(r#"{{"findings":[{}]}}"#, items.join(","));
        let r = parse_review(ReviewRole::Qa, &raw, &ids()).unwrap();
        assert_eq!(r.findings.len(), 5);
        assert!(r.findings.iter().all(|f| f.text.chars().count() <= 300));
    }

    #[test]
    fn reads_leader_fields() {
        let raw = r#"{"findings":[],"verdict":"Not ready.","fixes":"Name the payment provider."}"#;
        let r = parse_review(ReviewRole::Leader, raw, &ids()).unwrap();
        assert_eq!(r.verdict, "Not ready.");
        assert_eq!(r.fixes, "Name the payment provider.");
        let r = parse_review(ReviewRole::Qa, r#"{"findings":[]}"#, &ids()).unwrap();
        assert_eq!(r.verdict, "");
    }

    #[test]
    fn missing_severity_becomes_suggestion() {
        let r = parse_review(ReviewRole::Qa, r#"{"findings":[{"text":"x"}]}"#, &ids()).unwrap();
        assert_eq!(r.findings[0].severity, Severity::Suggestion);
    }

    #[test]
    fn numeric_step_is_coerced() {
        let raw = r#"{"findings":[{"severity":"blocker","step":1,"text":"a"},{"severity":"blocker","step":{"x":1},"text":"b"}]}"#;
        let r = parse_review(ReviewRole::Qa, raw, &ids()).unwrap();
        assert_eq!(r.findings[0].step.as_deref(), Some("S1"));
        assert_eq!(r.findings[1].step, None);
    }

    #[test]
    fn fixes_array_is_joined() {
        let raw = r#"{"findings":[],"fixes":["One"," Two"]}"#;
        let r = parse_review(ReviewRole::Leader, raw, &ids()).unwrap();
        assert_eq!(r.fixes, "One\nTwo");
    }

    #[test]
    fn system_prompt_names_role_and_forbids_tools() {
        for role in ROLES {
            let p = review_system_prompt(role);
            assert!(p.contains(&format!("You are the {}", role.label())), "{}", role.label());
            assert!(p.contains("You have no tools"));
            assert!(!p.contains("name: prd-review"));
        }
    }

    #[test]
    fn prompt_includes_earlier_findings_only_when_given() {
        assert!(!review_prompt(PRD, &[]).contains("Findings so far"));
        let earlier = [RoleReview {
            role: ReviewRole::Engineer,
            findings: vec![Finding {
                severity: Severity::Blocker,
                step: Some("S1".into()),
                text: "No payment provider".into(),
            }],
            verdict: String::new(),
            fixes: String::new(),
        }];
        let p = review_prompt(PRD, &earlier);
        assert!(p.contains("Findings so far"));
        assert!(p.contains("No payment provider"));
    }

    #[test]
    fn step_ids_from_headings() {
        assert_eq!(prd_step_ids(PRD), ["S1", "S2"]);
    }
}
