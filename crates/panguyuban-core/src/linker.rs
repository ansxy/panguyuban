use regex::Regex;
use std::sync::OnceLock;

const IGNORED_PREFIXES: &[&str] = &[
    "UTF", "SHA", "HTTP", "HTTPS", "ISO", "RSA", "AES", "TLS", "SSL", "IPV", "RFC",
];

fn ticket_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)(?:^|[^a-z0-9])([a-z]{2,10})-(\d+)(?:[^a-z0-9]|$)")
            .expect("valid ticket regex")
    })
}

pub fn extract_ticket_key(source_branch: &str, title: &str) -> Option<String> {
    for candidate_text in [source_branch, title] {
        for caps in ticket_regex().captures_iter(candidate_text) {
            let prefix = caps[1].to_ascii_uppercase();
            if IGNORED_PREFIXES.contains(&prefix.as_str()) {
                continue;
            }
            let num = &caps[2];
            return Some(format!("{prefix}-{num}"));
        }
    }
    None
}

pub fn format_branch_name(ticket_key: &str, title: &str) -> String {
    let key_lower = ticket_key.trim().to_ascii_lowercase();
    let words: Vec<String> = title
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .take(4)
        .map(|w| w.to_ascii_lowercase())
        .collect();

    if words.is_empty() {
        format!("feat/{key_lower}")
    } else {
        format!("feat/{key_lower}-{}", words.join("-"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_uppercase_key_from_lowercase_branch_and_title() {
        assert_eq!(
            extract_ticket_key("fix/pan-142-jwt-refresh", "fix(auth): serialize token refresh"),
            Some("PAN-142".to_string())
        );
        assert_eq!(
            extract_ticket_key("feat/pan-142_jwt_v2", "chore: update"),
            Some("PAN-142".to_string())
        );
        assert_eq!(
            extract_ticket_key("chore/deps", "feat(webhook): [PAN-145] retry queue"),
            Some("PAN-145".to_string())
        );
    }

    #[test]
    fn ignores_common_technical_prefixes_like_utf8_and_sha256() {
        assert_eq!(
            extract_ticket_key("chore/utf-8-encoding", "Update SHA-256 and HTTP-2 helpers"),
            None
        );
    }

    #[test]
    fn formats_clean_branch_name_from_ticket_key_and_title() {
        assert_eq!(
            format_branch_name("PAN-149", "Expose rate-limit headers on public endpoints!"),
            "feat/pan-149-expose-rate-limit-headers"
        );
    }
}
