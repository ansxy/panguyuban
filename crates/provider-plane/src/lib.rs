use async_trait::async_trait;
use panguyuban_core::error::CoreError;
use panguyuban_core::models::{Ticket, TicketState};
use panguyuban_core::traits::IssueProvider;
use std::collections::HashMap;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
pub struct PlaneConfig {
    pub base_url: String,
    pub workspace_slug: String,
    pub project_id: String,
    pub api_token: String,
}

pub struct PlaneProvider {
    config: PlaneConfig,
    client: reqwest::Client,
}

/// Plane list endpoints answer either `{ "results": [...] }` or a bare array.
#[derive(Debug, Deserialize)]
struct PlaneResults<T> {
    results: Vec<T>,
}

fn parse_results<T: DeserializeOwned>(raw_json: &str) -> Result<Vec<T>, CoreError> {
    serde_json::from_str::<PlaneResults<T>>(raw_json)
        .map(|r| r.results)
        .or_else(|_| serde_json::from_str(raw_json))
        .map_err(|e| CoreError::StorageError(e.to_string()))
}

#[derive(Debug, Deserialize)]
struct PlaneProjectDetail {
    identifier: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum PlaneProjectField {
    Id(#[allow(dead_code)] String),
    Expanded(PlaneProjectDetail),
}

#[derive(Debug, Deserialize)]
struct PlaneStateDetail {
    group: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum PlaneStateField {
    Id(String),
    Expanded(PlaneStateDetail),
}

#[derive(Debug, Deserialize)]
struct PlaneAssigneeDetail {
    #[serde(default)]
    id: Option<String>,
    display_name: Option<String>,
    first_name: Option<String>,
    last_name: Option<String>,
    email: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum PlaneAssigneeField {
    Id(String),
    Expanded(PlaneAssigneeDetail),
}

#[derive(Debug, Deserialize)]
struct PlaneIssuePayload {
    id: String,
    #[serde(default)]
    sequence_id: Option<u64>,
    name: String,
    #[serde(default)]
    description_stripped: Option<String>,
    #[serde(default)]
    description_html: Option<String>,
    #[serde(default)]
    priority: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    project: Option<PlaneProjectField>,
    #[serde(default)]
    project_detail: Option<PlaneProjectDetail>,
    #[serde(default)]
    state: Option<PlaneStateField>,
    #[serde(default)]
    state_detail: Option<PlaneStateDetail>,
    #[serde(default)]
    assignees: Option<Vec<PlaneAssigneeField>>,
    #[serde(default)]
    assignee_details: Option<Vec<PlaneAssigneeDetail>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaneProjectItem {
    pub id: String,
    #[serde(default)]
    pub identifier: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Serialize)]
struct CreatePlaneIssueRequest<'a> {
    name: &'a str,
    description_html: String,
}

#[derive(Debug, Serialize)]
struct TransitionPlaneIssueRequest<'a> {
    state: &'a str,
}

#[derive(Debug, Deserialize)]
struct PlaneStateItem {
    id: String,
    group: String,
}

pub fn resolve_plane_state_id(raw_json: &str, target: &TicketState) -> Result<String, CoreError> {
    let target_group = map_state_to_plane_group(target);
    parse_results::<PlaneStateItem>(raw_json)?
        .into_iter()
        .find(|s| s.group == target_group)
        .map(|s| s.id)
        .ok_or_else(|| {
            CoreError::NotFound(format!("Plane state group '{target_group}' not found"))
        })
}

pub fn map_plane_status_error(status: u16, body: &str) -> CoreError {
    if status == 401 || status == 403 {
        CoreError::AuthExpired {
            provider: "plane.so".to_string(),
        }
    } else {
        CoreError::ProviderHttp {
            provider: "plane.so".to_string(),
            status,
            message: body.to_string(),
        }
    }
}

fn map_plane_group_to_state(group: Option<&str>) -> TicketState {
    match group {
        Some("backlog") => TicketState::Backlog,
        Some("unstarted") => TicketState::Todo,
        Some("started") => TicketState::InProgress,
        Some("completed") => TicketState::Done,
        Some("cancelled") => TicketState::Cancelled,
        _ => TicketState::Todo,
    }
}

fn map_state_to_plane_group(state: &TicketState) -> &'static str {
    match state {
        TicketState::Backlog => "backlog",
        TicketState::Todo => "unstarted",
        TicketState::InProgress | TicketState::InReview => "started",
        TicketState::Done => "completed",
        TicketState::Cancelled => "cancelled",
    }
}

pub fn normalize_plane_base_url(raw_url: &str) -> String {
    let trimmed = raw_url.trim().trim_end_matches('/');
    let without_api = trimmed
        .strip_suffix("/api/v1")
        .or_else(|| trimmed.strip_suffix("/api"))
        .unwrap_or(trimmed);
    without_api.trim_end_matches('/').to_string()
}

/// Projects to pull tickets from, mirroring top-bar: the configured project when it
/// matches an id, identifier or name, otherwise the first four in the workspace.
fn select_target_projects(projects: Vec<PlaneProjectItem>, project_ref: &str) -> Vec<PlaneProjectItem> {
    let needle = project_ref.trim();
    let matches = |p: &PlaneProjectItem| {
        !needle.is_empty()
            && (p.id.eq_ignore_ascii_case(needle)
                || p.identifier.as_deref().is_some_and(|i| i.eq_ignore_ascii_case(needle))
                || p.name.as_deref().is_some_and(|n| n.eq_ignore_ascii_case(needle)))
    };
    match projects.iter().find(|p| matches(p)) {
        Some(p) => vec![p.clone()],
        None => projects.into_iter().take(4).collect(),
    }
}

/// Plane's editor HTML as readable plain text: block tags become line breaks,
/// list items get a bullet, images become an `[image:<asset id or url>]` line the
/// app renders in place; everything else (links, styling) keeps only its text.
fn html_to_text(html: &str) -> String {
    let mut out = String::new();
    let mut rest = html;
    while let Some(start) = rest.find('<') {
        out.push_str(&rest[..start]);
        let Some(end) = rest[start..].find('>') else { break };
        let tag = rest[start + 1..start + end].trim_start_matches('/');
        let name = tag.split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or("");
        match name {
            "image-component" | "img" => {
                if let Some(src) = tag.split("src=\"").nth(1).and_then(|r| r.split('"').next()) {
                    out.push_str(&format!("\n[image:{src}]\n"));
                }
            }
            "li" if !rest[start + 1..].starts_with('/') => out.push_str("\n• "),
            // Plane wraps list item text in <p>; keep it on the bullet's line.
            "p" | "br" | "div" | "ul" | "ol" | "h1" | "h2" | "h3" | "blockquote" | "pre"
                if !out.ends_with("• ") =>
            {
                out.push('\n')
            }
            _ => {}
        }
        rest = &rest[start + end + 1..];
    }
    out.push_str(rest);
    let text = out
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&");
    // Collapse the blank lines that nested blocks leave behind.
    text.lines()
        .map(str::trim_end)
        .filter(|l| !l.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn convert_payload(
    issue: PlaneIssuePayload,
    base_url: &str,
    workspace_slug: &str,
    project: &PlaneProjectItem,
    state_groups: &HashMap<String, String>,
    me: Option<&str>,
) -> Ticket {
    let prefix = issue
        .project_detail
        .and_then(|p| p.identifier)
        .or_else(|| match issue.project {
            Some(PlaneProjectField::Expanded(p)) => p.identifier,
            _ => None,
        })
        .or_else(|| project.identifier.clone())
        .unwrap_or_else(|| "PAN".to_string());
    let seq = issue.sequence_id.unwrap_or(1);
    let key = format!("{}-{}", prefix.to_ascii_uppercase(), seq);

    let state_group = issue
        .state_detail
        .as_ref()
        .and_then(|s| s.group.as_deref().or(s.name.as_deref()))
        .or_else(|| match &issue.state {
            Some(PlaneStateField::Expanded(s)) => s.group.as_deref().or(s.name.as_deref()),
            // Without `expand`, `state` is a bare id; resolve it via the project's states.
            Some(PlaneStateField::Id(id)) => state_groups.get(id).map(String::as_str),
            None => None,
        });
    let state = map_plane_group_to_state(state_group);

    let extract_name = |a: PlaneAssigneeDetail| -> Option<String> {
        a.display_name
            .filter(|s| !s.trim().is_empty())
            .or_else(|| {
                match (a.first_name, a.last_name) {
                    (Some(f), Some(l)) if !f.trim().is_empty() => {
                        Some(format!("{} {}", f.trim(), l.trim()).trim().to_string())
                    }
                    (Some(f), None) if !f.trim().is_empty() => Some(f),
                    _ => None,
                }
            })
            .or(a.email)
    };

    let assigned_to_me = me.is_some_and(|me| {
        let from_details = issue.assignee_details.iter().flatten().filter_map(|a| a.id.as_deref());
        let from_field = issue.assignees.iter().flatten().filter_map(|a| match a {
            PlaneAssigneeField::Id(id) => Some(id.as_str()),
            PlaneAssigneeField::Expanded(a) => a.id.as_deref(),
        });
        from_details.chain(from_field).any(|id| id == me)
    });

    let assignee_raw = issue
        .assignee_details
        .and_then(|mut list| list.pop())
        .and_then(extract_name)
        .or_else(|| {
            issue.assignees.and_then(|list| {
                list.into_iter().find_map(|item| match item {
                    PlaneAssigneeField::Expanded(detail) => extract_name(detail),
                    PlaneAssigneeField::Id(_) => None,
                })
            })
        });

    let assignee = assignee_raw.map(|name| {
        if name.starts_with('@') {
            name
        } else {
            format!("@{name}")
        }
    });

    let clean_base = normalize_plane_base_url(base_url);
    Ticket {
        id: issue.id.clone(),
        key,
        title: issue.name,
        // Self-hosted Plane often leaves `description_stripped` null; use the HTML then.
        description: issue
            .description_stripped
            .filter(|d| !d.trim().is_empty())
            .or_else(|| issue.description_html.as_deref().map(html_to_text))
            .unwrap_or_default(),
        state,
        assignee,
        priority: issue.priority,
        updated_at: issue.updated_at.unwrap_or_default(),
        url: format!(
            "{}/{}/projects/{}/issues/{}",
            clean_base, workspace_slug, project.id, issue.id
        ),
        assigned_to_me,
    }
}

pub fn parse_plane_issue(
    raw_json: &str,
    base_url: &str,
    workspace_slug: &str,
) -> Result<Ticket, CoreError> {
    let payload: PlaneIssuePayload =
        serde_json::from_str(raw_json).map_err(|e| CoreError::StorageError(e.to_string()))?;
    let project_id = match &payload.project {
        Some(PlaneProjectField::Id(id)) => id.clone(),
        _ => String::new(),
    };
    let project = PlaneProjectItem { id: project_id, identifier: None, name: None };
    Ok(convert_payload(payload, base_url, workspace_slug, &project, &HashMap::new(), None))
}

impl PlaneProvider {
    pub fn new(config: PlaneConfig) -> Self {
        Self {
            config,
            client: reqwest::Client::new(),
        }
    }

    fn clean_base_url(&self) -> String {
        normalize_plane_base_url(&self.config.base_url)
    }

    fn workspace_endpoint(&self, path: &str) -> String {
        format!(
            "{}/api/v1/workspaces/{}/{}",
            self.clean_base_url(),
            self.config.workspace_slug.trim(),
            path
        )
    }

    async fn get_text(&self, url: &str) -> Result<String, CoreError> {
        let resp = self
            .client
            .get(url)
            .header("X-API-Key", &self.config.api_token)
            .send()
            .await
            .map_err(plane_http_err)?;
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(map_plane_status_error(status, &body));
        }
        Ok(body)
    }

    /// The API key owner's user id (`/users/me/`), used to flag tickets assigned to me.
    async fn current_user_id(&self) -> Option<String> {
        #[derive(Deserialize)]
        struct Me {
            id: String,
        }
        let url = format!("{}/api/v1/users/me/", self.clean_base_url());
        let body = self.get_text(&url).await.ok()?;
        serde_json::from_str::<Me>(&body).ok().map(|m| m.id)
    }

    /// A short-lived download URL for an image embedded in a ticket description
    /// (Plane stores editor images as asset ids, not URLs).
    pub async fn asset_url(&self, asset_id: &str) -> Result<String, CoreError> {
        #[derive(Deserialize)]
        struct Asset {
            asset_url: String,
        }
        let body = self
            .get_text(&self.workspace_endpoint(&format!("assets/generic-asset/{asset_id}/")))
            .await?;
        serde_json::from_str::<Asset>(&body)
            .map(|a| a.asset_url)
            .map_err(|e| CoreError::StorageError(e.to_string()))
    }

    /// Every project in the workspace, for the settings project picker.
    pub async fn list_projects(&self) -> Result<Vec<PlaneProjectItem>, CoreError> {
        let body = self.get_text(&self.workspace_endpoint("projects/")).await?;
        parse_results(&body)
    }

    async fn target_projects(&self) -> Result<Vec<PlaneProjectItem>, CoreError> {
        let projects = self.list_projects().await?;
        Ok(select_target_projects(projects, &self.config.project_id))
    }

    /// State id -> group for one project. Missing states just leave tickets as Todo.
    async fn state_groups(&self, project_id: &str) -> HashMap<String, String> {
        let url = self.workspace_endpoint(&format!("projects/{project_id}/states/"));
        let Ok(body) = self.get_text(&url).await else {
            return HashMap::new();
        };
        parse_results::<PlaneStateItem>(&body)
            .unwrap_or_default()
            .into_iter()
            .map(|s| (s.id, s.group))
            .collect()
    }

    /// Every ticket of the target projects, paired with its project id
    /// (transitions and creates need it). Projects are fetched one by one like top-bar.
    async fn fetch_all(&self) -> Result<Vec<(String, Ticket)>, CoreError> {
        // ponytail: like top-bar's `isConfigured` guard, no key = Plane not set up.
        if self.config.api_token.trim().is_empty() {
            return Ok(Vec::new());
        }
        let me = self.current_user_id().await;
        let mut out = Vec::new();
        for project in self.target_projects().await? {
            let states = self.state_groups(&project.id).await;
            let body = self
                .send_items(
                    reqwest::Method::GET,
                    &project.id,
                    "?expand=state,assignees,project&per_page=100",
                    None,
                )
                .await?;
            for item in parse_results::<PlaneIssuePayload>(&body)? {
                let ticket = convert_payload(
                    item,
                    &self.config.base_url,
                    &self.config.workspace_slug,
                    &project,
                    &states,
                    me.as_deref(),
                );
                out.push((project.id.clone(), ticket));
            }
        }
        Ok(out)
    }

    async fn find_ticket(&self, key: &str) -> Result<(String, Ticket), CoreError> {
        self.fetch_all()
            .await?
            .into_iter()
            .find(|(_, t)| t.key.eq_ignore_ascii_case(key))
            .ok_or_else(|| CoreError::NotFound(format!("Ticket {key} not found in Plane.so")))
    }

    /// Sends a request to `work-items/`; on 404 retries the legacy `issues/` path
    /// (older self-hosted Plane releases only expose `issues/`).
    async fn send_items(
        &self,
        method: reqwest::Method,
        project_uuid: &str,
        suffix: &str,
        body: Option<serde_json::Value>,
    ) -> Result<String, CoreError> {
        let urls = [
            self.workspace_endpoint(&format!("projects/{project_uuid}/work-items/{suffix}")),
            self.workspace_endpoint(&format!("projects/{project_uuid}/issues/{suffix}")),
        ];
        let mut last_err = None;
        for url in urls {
            let mut req = self
                .client
                .request(method.clone(), &url)
                .header("X-API-Key", &self.config.api_token);
            if let Some(b) = &body {
                req = req.json(b);
            }
            let resp = req.send().await.map_err(plane_http_err)?;
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            if (200..300).contains(&status) {
                return Ok(text);
            }
            let err = map_plane_status_error(status, &text);
            if status != 404 {
                return Err(err);
            }
            last_err = Some(err);
        }
        Err(last_err.unwrap_or_else(|| CoreError::NotFound("Plane work items".into())))
    }
}

fn plane_http_err(e: reqwest::Error) -> CoreError {
    CoreError::ProviderHttp {
        provider: "plane.so".into(),
        status: 0,
        message: e.to_string(),
    }
}

#[async_trait]
impl IssueProvider for PlaneProvider {
    fn provider_name(&self) -> &'static str {
        "plane.so"
    }

    async fn list_tickets(&self) -> Result<Vec<Ticket>, CoreError> {
        Ok(self.fetch_all().await?.into_iter().map(|(_, t)| t).collect())
    }

    async fn get_ticket(&self, key: &str) -> Result<Ticket, CoreError> {
        Ok(self.find_ticket(key).await?.1)
    }

    async fn create_ticket(&self, title: &str, description: &str) -> Result<Ticket, CoreError> {
        let project = self
            .target_projects()
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| CoreError::NotFound("No Plane project in workspace".into()))?;
        let req_body = serde_json::to_value(CreatePlaneIssueRequest {
            name: title,
            description_html: format!("<p>{description}</p>"),
        })
        .map_err(|e| CoreError::StorageError(e.to_string()))?;

        let body = self
            .send_items(reqwest::Method::POST, &project.id, "", Some(req_body))
            .await?;
        let payload: PlaneIssuePayload =
            serde_json::from_str(&body).map_err(|e| CoreError::StorageError(e.to_string()))?;
        let states = self.state_groups(&project.id).await;
        Ok(convert_payload(
            payload,
            &self.config.base_url,
            &self.config.workspace_slug,
            &project,
            &states,
            None,
        ))
    }

    async fn transition_ticket(&self, key: &str, next: TicketState) -> Result<Ticket, CoreError> {
        let (project_id, mut ticket) = self.find_ticket(key).await?;

        let states_body = self
            .get_text(&self.workspace_endpoint(&format!("projects/{project_id}/states/")))
            .await?;
        let state_id = resolve_plane_state_id(&states_body, &next)?;
        let req_body = serde_json::to_value(TransitionPlaneIssueRequest { state: &state_id })
            .map_err(|e| CoreError::StorageError(e.to_string()))?;
        self.send_items(
            reqwest::Method::PATCH,
            &project_id,
            &format!("{}/", ticket.id),
            Some(req_body),
        )
        .await?;

        ticket.state = next;
        Ok(ticket)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use panguyuban_core::error::CoreError;
    use panguyuban_core::models::TicketState;

    #[test]
    fn parses_plane_issue_payload_into_core_ticket() {
        let raw = r#"{
            "id": "b62f8d9a-1111-2222-3333-444455556666",
            "sequence_id": 142,
            "name": "Fix JWT refresh race on concurrent requests",
            "description_stripped": "Guard token rotation with an async mutex.",
            "priority": "high",
            "updated_at": "2026-11-11T02:14:09Z",
            "project_detail": { "identifier": "PAN" },
            "state_detail": { "group": "started" },
            "assignee_details": [{ "display_name": "ansar" }]
        }"#;

        let ticket = parse_plane_issue(raw, "https://app.plane.so", "panguyuban").unwrap();
        assert_eq!(ticket.key, "PAN-142");
        assert_eq!(ticket.title, "Fix JWT refresh race on concurrent requests");
        assert_eq!(ticket.state, TicketState::InProgress);
        assert_eq!(ticket.assignee, Some("@ansar".to_string()));
        assert_eq!(ticket.priority, Some("high".to_string()));
    }

    #[test]
    fn resolves_plane_state_uuid_for_target_ticket_state() {
        let states_json = r#"{
            "results": [
                { "id": "state-uuid-todo", "group": "unstarted" },
                { "id": "state-uuid-started", "group": "started" },
                { "id": "state-uuid-done", "group": "completed" }
            ]
        }"#;
        assert_eq!(
            resolve_plane_state_id(states_json, &TicketState::Done).unwrap(),
            "state-uuid-done"
        );
        assert_eq!(
            resolve_plane_state_id(states_json, &TicketState::InProgress).unwrap(),
            "state-uuid-started"
        );
    }

    #[test]
    fn parses_expanded_work_item_payload_from_self_hosted_plane() {
        let raw = r#"{
            "id": "wi-1",
            "sequence_id": 7,
            "name": "Self hosted item",
            "project": "8c9d0e1f-2a3b-4c5d-6e7f-8a9b0c1d2e3f",
            "state": { "id": "s1", "name": "In Progress", "group": "started" },
            "assignees": [{ "id": "u1", "first_name": "Ansar", "last_name": "", "email": "a@x.io" }]
        }"#;
        let ticket = parse_plane_issue(raw, "https://plane.example.com/api/v1/", "team").unwrap();
        assert_eq!(ticket.key, "PAN-7");
        assert_eq!(ticket.state, TicketState::InProgress);
        assert_eq!(ticket.assignee, Some("@Ansar".to_string()));
        assert_eq!(
            ticket.url,
            "https://plane.example.com/team/projects/8c9d0e1f-2a3b-4c5d-6e7f-8a9b0c1d2e3f/issues/wi-1"
        );
    }

    #[test]
    fn normalizes_self_hosted_base_url() {
        assert_eq!(normalize_plane_base_url("https://plane.example.com/"), "https://plane.example.com");
        assert_eq!(normalize_plane_base_url("https://plane.example.com/api/v1"), "https://plane.example.com");
        assert_eq!(normalize_plane_base_url("http://localhost/api/"), "http://localhost");
    }

    #[test]
    fn targets_configured_project_or_first_four_like_top_bar() {
        let raw = r#"{ "results": [
            { "id": "uuid-a", "identifier": "WEB", "name": "Website" },
            { "id": "uuid-b", "identifier": "PAN", "name": "Panguyuban" },
            { "id": "uuid-c" }, { "id": "uuid-d" }, { "id": "uuid-e" }
        ]}"#;
        let ids = |r: &str| -> Vec<String> {
            select_target_projects(parse_results(raw).unwrap(), r)
                .into_iter()
                .map(|p| p.id)
                .collect()
        };
        assert_eq!(ids("pan"), ["uuid-b"]);
        assert_eq!(ids("Website"), ["uuid-a"]);
        assert_eq!(ids("nope"), ["uuid-a", "uuid-b", "uuid-c", "uuid-d"]);
        assert_eq!(ids(""), ["uuid-a", "uuid-b", "uuid-c", "uuid-d"]);
    }

    #[test]
    fn resolves_id_only_state_and_flags_tickets_assigned_to_me() {
        let raw = r#"{
            "id": "wi-9", "sequence_id": 9, "name": "Plain payload",
            "state": "s-started", "assignees": ["u-me", "u-other"]
        }"#;
        let payload: PlaneIssuePayload = serde_json::from_str(raw).unwrap();
        let project = PlaneProjectItem { id: "p1".into(), identifier: Some("web".into()), name: None };
        let states = HashMap::from([("s-started".to_string(), "started".to_string())]);

        let ticket = convert_payload(payload, "https://plane.x", "team", &project, &states, Some("u-me"));
        assert_eq!(ticket.key, "WEB-9");
        assert_eq!(ticket.state, TicketState::InProgress);
        assert!(ticket.assigned_to_me);
        assert_eq!(ticket.url, "https://plane.x/team/projects/p1/issues/wi-9");
    }

    #[test]
    fn falls_back_to_description_html_as_plain_text() {
        let raw = r#"{ "id": "x", "name": "n", "description_stripped": null,
            "description_html": "<p class=\"a\">Context: copay &amp; plan</p><ol><li><p>Add validation</p></li><li><p>Keep &lt;2027&gt; flow</p></li></ol><image-component src=\"i\"></image-component><p>a<br>b&nbsp;c</p><p></p>" }"#;
        let ticket = parse_plane_issue(raw, "https://plane.x", "team").unwrap();
        assert_eq!(
            ticket.description,
            "Context: copay & plan\n• Add validation\n• Keep <2027> flow\n[image:i]\na\nb c"
        );
    }

    #[test]
    fn maps_http_401_and_403_to_auth_expired() {
        assert_eq!(
            map_plane_status_error(401, "Unauthorized"),
            CoreError::AuthExpired {
                provider: "plane.so".to_string()
            }
        );
        assert_eq!(
            map_plane_status_error(403, "Forbidden"),
            CoreError::AuthExpired {
                provider: "plane.so".to_string()
            }
        );
    }
}
