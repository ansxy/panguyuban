pub mod local_git;

use std::path::PathBuf;

use async_trait::async_trait;
use panguyuban_core::error::CoreError;
use panguyuban_core::linker::extract_ticket_key;
use panguyuban_core::models::{CiState, MergeMethod, PullRequest, ReviewState};
use panguyuban_core::traits::GitProvider;
use serde::{Deserialize, Serialize};

use crate::local_git::{checkout_existing_branch_in_repo, create_and_checkout_branch_in_repo};

#[derive(Debug, Clone)]
pub struct GithubConfig {
    pub api_url: String,
    pub repo: String,
    pub token: String,
    pub local_repo_path: PathBuf,
}

pub struct GithubProvider {
    config: GithubConfig,
    client: reqwest::Client,
}

#[derive(Debug, Deserialize)]
struct GithubUserPayload {
    login: String,
}

#[derive(Debug, Deserialize)]
struct GithubBranchRefPayload {
    #[serde(rename = "ref")]
    branch_ref: String,
    #[serde(default)]
    sha: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubReviewPayload {
    state: String,
}

#[derive(Debug, Deserialize)]
struct GithubCheckRunItem {
    status: String,
    conclusion: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubCheckRunsResponse {
    total_count: usize,
    check_runs: Vec<GithubCheckRunItem>,
}

pub fn parse_github_reviews(raw_json: &str) -> Result<ReviewState, CoreError> {
    let reviews: Vec<GithubReviewPayload> =
        serde_json::from_str(raw_json).map_err(|e| CoreError::StorageError(e.to_string()))?;
    let mut state = ReviewState::ReviewRequired;
    for r in reviews {
        match r.state.as_str() {
            "APPROVED" => state = ReviewState::Approved,
            "CHANGES_REQUESTED" => state = ReviewState::ChangesRequested,
            _ => {}
        }
    }
    Ok(state)
}

pub fn parse_github_check_runs(raw_json: &str) -> Result<CiState, CoreError> {
    let resp: GithubCheckRunsResponse =
        serde_json::from_str(raw_json).map_err(|e| CoreError::StorageError(e.to_string()))?;
    if resp.total_count == 0 {
        return Ok(CiState::Pending);
    }
    let mut passed = 0;
    let mut failed = 0;
    for run in &resp.check_runs {
        if run.status != "completed" {
            continue;
        }
        match run.conclusion.as_deref() {
            Some("success" | "neutral" | "skipped") => passed += 1,
            Some(_) => failed += 1,
            None => {}
        }
    }
    if failed > 0 {
        Ok(CiState::Failing {
            failed,
            total: resp.total_count,
        })
    } else if passed > 0 {
        Ok(CiState::Passing {
            passed,
            total: resp.total_count,
        })
    } else {
        Ok(CiState::Pending)
    }
}

#[derive(Debug, Deserialize)]
struct GithubPrPayload {
    number: u64,
    title: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    mergeable: Option<bool>,
    #[serde(default)]
    additions: Option<u32>,
    #[serde(default)]
    deletions: Option<u32>,
    user: GithubUserPayload,
    head: GithubBranchRefPayload,
    base: GithubBranchRefPayload,
}

#[derive(Debug, Serialize)]
struct ApprovePrRequest<'a> {
    event: &'a str,
}

#[derive(Debug, Serialize)]
struct MergePrRequest<'a> {
    merge_method: &'a str,
}

pub fn map_github_status_error(status: u16, body: &str) -> CoreError {
    if status == 401 || status == 403 {
        CoreError::AuthExpired {
            provider: "github".to_string(),
        }
    } else {
        CoreError::ProviderHttp {
            provider: "github".to_string(),
            status,
            message: body.to_string(),
        }
    }
}

fn convert_pr_payload(raw: GithubPrPayload, repo: &str, review_requested: bool) -> PullRequest {
    let linked_ticket_key = extract_ticket_key(&raw.head.branch_ref, &raw.title);
    let author = if raw.user.login.starts_with('@') {
        raw.user.login
    } else {
        format!("@{}", raw.user.login)
    };

    PullRequest {
        repo: repo.to_string(),
        number: raw.number,
        title: raw.title,
        author,
        source_branch: raw.head.branch_ref,
        target_branch: raw.base.branch_ref,
        mergeable: raw.mergeable.unwrap_or(true),
        additions: raw.additions.unwrap_or(0),
        deletions: raw.deletions.unwrap_or(0),
        review_state: ReviewState::ReviewRequired,
        ci_state: CiState::Pending,
        linked_ticket_key,
        diff_preview: Vec::new(),
        url: raw.html_url,
        review_requested,
    }
}

pub fn parse_github_pr(raw_json: &str) -> Result<PullRequest, CoreError> {
    let payload: GithubPrPayload =
        serde_json::from_str(raw_json).map_err(|e| CoreError::StorageError(e.to_string()))?;
    Ok(convert_pr_payload(payload, "", false))
}

/// One search per list, like top-bar's `gh search prs --author=@me` /
/// `--review-requested=@me`, but asking GraphQL for branch, review, CI and merge
/// state in the same call instead of ~3 REST requests per PR.
const PR_SEARCH_QUERY: &str = r#"query($q: String!) {
  search(query: $q, type: ISSUE, first: 50) {
    nodes {
      ... on PullRequest {
        number title url
        repository { nameWithOwner }
        author { login }
        headRefName baseRefName
        mergeable mergeStateStatus additions deletions reviewDecision
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
          ... on CheckRun { status conclusion }
          ... on StatusContext { state }
        } } } } } }
      }
    }
  }
}"#;

#[derive(Debug, Deserialize)]
struct GqlResponse {
    data: Option<GqlData>,
    #[serde(default)]
    errors: Vec<GqlError>,
}

#[derive(Debug, Deserialize)]
struct GqlError {
    message: String,
}

#[derive(Debug, Deserialize)]
struct GqlData {
    search: GqlSearch,
}

#[derive(Debug, Deserialize)]
struct GqlSearch {
    nodes: Vec<Option<GqlPr>>,
}

#[derive(Debug, Deserialize)]
struct GqlRepo {
    #[serde(rename = "nameWithOwner")]
    name_with_owner: String,
}

#[derive(Debug, Deserialize)]
struct GqlLogin {
    login: String,
}

#[derive(Debug, Deserialize)]
struct GqlNodes<T> {
    nodes: Vec<T>,
}

#[derive(Debug, Deserialize)]
struct GqlCommitNode {
    commit: GqlCommit,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlCommit {
    status_check_rollup: Option<GqlRollup>,
}

#[derive(Debug, Deserialize)]
struct GqlRollup {
    contexts: GqlNodes<GqlCheck>,
}

/// A CheckRun (`status` + `conclusion`) or a legacy StatusContext (`state`).
#[derive(Debug, Deserialize)]
struct GqlCheck {
    status: Option<String>,
    conclusion: Option<String>,
    state: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlPr {
    number: u64,
    title: String,
    url: String,
    repository: GqlRepo,
    author: Option<GqlLogin>,
    head_ref_name: String,
    base_ref_name: String,
    mergeable: Option<String>,
    merge_state_status: Option<String>,
    additions: Option<u32>,
    deletions: Option<u32>,
    review_decision: Option<String>,
    commits: GqlNodes<GqlCommitNode>,
}

fn gql_ci_state(checks: &[GqlCheck]) -> CiState {
    let (mut passed, mut failed) = (0, 0);
    for c in checks {
        let outcome = match (&c.state, c.status.as_deref(), c.conclusion.as_deref()) {
            (Some(state), _, _) => Some(state.as_str()),
            (None, Some("COMPLETED"), conclusion) => conclusion,
            _ => None, // still running
        };
        match outcome {
            Some("SUCCESS" | "NEUTRAL" | "SKIPPED") => passed += 1,
            Some("PENDING" | "EXPECTED") | None => {}
            Some(_) => failed += 1,
        }
    }
    let total = checks.len();
    if failed > 0 {
        CiState::Failing { failed, total }
    } else if passed > 0 {
        CiState::Passing { passed, total }
    } else {
        CiState::Pending
    }
}

fn convert_gql_pr(raw: GqlPr, review_requested: bool) -> PullRequest {
    let checks = raw
        .commits
        .nodes
        .into_iter()
        .next()
        .and_then(|n| n.commit.status_check_rollup)
        .map(|r| r.contexts.nodes)
        .unwrap_or_default();
    // Mergeable = no conflicts and GitHub isn't blocking it (top-bar's merge dot).
    let mergeable = raw.mergeable.as_deref() != Some("CONFLICTING")
        && !matches!(
            raw.merge_state_status.as_deref(),
            Some("BLOCKED" | "DIRTY" | "DRAFT")
        );
    PullRequest {
        linked_ticket_key: extract_ticket_key(&raw.head_ref_name, &raw.title),
        repo: raw.repository.name_with_owner,
        number: raw.number,
        title: raw.title,
        author: format!("@{}", raw.author.map(|a| a.login).unwrap_or_else(|| "ghost".into())),
        source_branch: raw.head_ref_name,
        target_branch: raw.base_ref_name,
        mergeable,
        additions: raw.additions.unwrap_or(0),
        deletions: raw.deletions.unwrap_or(0),
        review_state: match raw.review_decision.as_deref() {
            Some("APPROVED") => ReviewState::Approved,
            Some("CHANGES_REQUESTED") => ReviewState::ChangesRequested,
            _ => ReviewState::ReviewRequired,
        },
        ci_state: gql_ci_state(&checks),
        diff_preview: Vec::new(),
        url: raw.url,
        review_requested,
    }
}

/// Parses a GraphQL PR search. Partial errors (e.g. an org needing SSO) still
/// return the PRs that came back; only a response with no data fails.
pub fn parse_github_pr_search(
    raw_json: &str,
    review_requested: bool,
) -> Result<Vec<PullRequest>, CoreError> {
    let resp: GqlResponse =
        serde_json::from_str(raw_json).map_err(|e| CoreError::StorageError(e.to_string()))?;
    let Some(data) = resp.data else {
        let message = resp
            .errors
            .into_iter()
            .map(|e| e.message)
            .collect::<Vec<_>>()
            .join("; ");
        return Err(CoreError::ProviderHttp {
            provider: "github".into(),
            status: 200,
            message,
        });
    };
    Ok(data
        .search
        .nodes
        .into_iter()
        .flatten()
        .map(|pr| convert_gql_pr(pr, review_requested))
        .collect())
}

impl GithubProvider {
    pub fn new(config: GithubConfig) -> Self {
        Self {
            config,
            client: reqwest::Client::new(),
        }
    }

    fn api(&self) -> &str {
        self.config.api_url.trim_end_matches('/')
    }

    fn request(&self, method: reqwest::Method, url: String) -> reqwest::RequestBuilder {
        self.client
            .request(method, url)
            .header("Authorization", format!("Bearer {}", self.config.token))
            .header("User-Agent", "panguyuban-desktop")
            .header("Accept", "application/vnd.github+json")
    }

    async fn get_text(&self, url: String) -> Result<String, CoreError> {
        let resp = self
            .request(reqwest::Method::GET, url)
            .send()
            .await
            .map_err(github_http_err)?;
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(map_github_status_error(status, &body));
        }
        Ok(body)
    }

    /// `https://api.github.com` -> `.../graphql`; GHE `https://host/api/v3` -> `https://host/api/graphql`.
    fn graphql_url(&self) -> String {
        match self.api().strip_suffix("/v3") {
            Some(ghe) => format!("{ghe}/graphql"),
            None => format!("{}/graphql", self.api()),
        }
    }

    /// Open PRs across all repos (personal and org) matching a qualifier such as
    /// `author:@me`. Only an `owner/name` repo setting narrows the search.
    async fn search_open_prs(
        &self,
        qualifier: &str,
        review_requested: bool,
    ) -> Result<Vec<PullRequest>, CoreError> {
        let mut q = format!("is:pr is:open archived:false sort:updated-desc {qualifier}");
        let repo_filter = self.config.repo.trim();
        // Anything that isn't `owner/name` (e.g. your username) is ignored, so the
        // default matches top-bar's `gh search prs`.
        if repo_filter.contains('/') {
            q.push_str(&format!(" repo:{repo_filter}"));
        }
        let resp = self
            .request(reqwest::Method::POST, self.graphql_url())
            .json(&serde_json::json!({ "query": PR_SEARCH_QUERY, "variables": { "q": q } }))
            .send()
            .await
            .map_err(github_http_err)?;
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(map_github_status_error(status, &body));
        }
        parse_github_pr_search(&body, review_requested)
    }

    /// Full PR details plus review and CI state.
    async fn fetch_pr(
        &self,
        repo: &str,
        number: u64,
        review_requested: bool,
    ) -> Result<PullRequest, CoreError> {
        let body = self
            .get_text(format!("{}/repos/{}/pulls/{}", self.api(), repo, number))
            .await?;
        let payload: GithubPrPayload =
            serde_json::from_str(&body).map_err(|e| CoreError::StorageError(e.to_string()))?;
        let head_sha = payload.head.sha.clone();
        let mut pr = convert_pr_payload(payload, repo, review_requested);

        if let Ok(text) = self
            .get_text(format!("{}/repos/{}/pulls/{}/reviews", self.api(), repo, number))
            .await
        {
            if let Ok(state) = parse_github_reviews(&text) {
                pr.review_state = state;
            }
        }
        if let Some(sha) = head_sha {
            if let Ok(text) = self
                .get_text(format!("{}/repos/{}/commits/{}/check-runs", self.api(), repo, sha))
                .await
            {
                if let Ok(ci) = parse_github_check_runs(&text) {
                    pr.ci_state = ci;
                }
            }
        }
        Ok(pr)
    }
}

fn github_http_err(e: reqwest::Error) -> CoreError {
    CoreError::ProviderHttp {
        provider: "github".into(),
        status: 0,
        message: e.to_string(),
    }
}

#[async_trait]
impl GitProvider for GithubProvider {
    fn provider_name(&self) -> &'static str {
        "github"
    }

    /// Your open PRs plus PRs where your review is requested, across every repo.
    async fn list_pull_requests(&self) -> Result<Vec<PullRequest>, CoreError> {
        // ponytail: no token = GitHub not set up; `@me` search needs auth anyway.
        if self.config.token.trim().is_empty() {
            return Ok(Vec::new());
        }
        let mut prs = self.search_open_prs("review-requested:@me", true).await?;
        for pr in self.search_open_prs("author:@me", false).await? {
            if !prs.iter().any(|p| p.repo == pr.repo && p.number == pr.number) {
                prs.push(pr);
            }
        }
        Ok(prs)
    }

    async fn pull_request_diff(&self, repo: &str, number: u64) -> Result<Vec<String>, CoreError> {
        let resp = self
            .client
            .get(format!("{}/repos/{}/pulls/{}", self.api(), repo, number))
            .header("Authorization", format!("Bearer {}", self.config.token))
            .header("User-Agent", "panguyuban-desktop")
            .header("Accept", "application/vnd.github.diff")
            .send()
            .await
            .map_err(github_http_err)?;
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(map_github_status_error(status, &body));
        }
        // ponytail: first 800 lines keep huge PRs responsive; open on GitHub for the rest.
        Ok(body.lines().take(800).map(str::to_string).collect())
    }

    async fn approve_pull_request(&self, repo: &str, number: u64) -> Result<PullRequest, CoreError> {
        let resp = self
            .request(
                reqwest::Method::POST,
                format!("{}/repos/{}/pulls/{}/reviews", self.api(), repo, number),
            )
            .json(&ApprovePrRequest { event: "APPROVE" })
            .send()
            .await
            .map_err(github_http_err)?;
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(map_github_status_error(status, &body));
        }

        let mut pr = self.fetch_pr(repo, number, true).await?;
        pr.review_state = ReviewState::Approved;
        Ok(pr)
    }

    async fn merge_pull_request(
        &self,
        repo: &str,
        number: u64,
        method: MergeMethod,
    ) -> Result<(), CoreError> {
        let method_str = match method {
            MergeMethod::Squash => "squash",
            MergeMethod::MergeCommit => "merge",
            MergeMethod::Rebase => "rebase",
        };
        let resp = self
            .request(
                reqwest::Method::PUT,
                format!("{}/repos/{}/pulls/{}/merge", self.api(), repo, number),
            )
            .json(&MergePrRequest {
                merge_method: method_str,
            })
            .send()
            .await
            .map_err(github_http_err)?;
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(map_github_status_error(status, &body));
        }
        Ok(())
    }

    fn create_and_checkout_branch(&self, branch_name: &str) -> Result<(), CoreError> {
        create_and_checkout_branch_in_repo(&self.config.local_repo_path, branch_name)
    }

    fn checkout_existing_branch(&self, branch_name: &str) -> Result<(), CoreError> {
        checkout_existing_branch_in_repo(&self.config.local_repo_path, branch_name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use panguyuban_core::error::CoreError;
    use panguyuban_core::models::{CiState, ReviewState};

    #[test]
    fn parses_github_pr_payload_and_extracts_linked_ticket_key() {
        let raw = r#"{
            "number": 89,
            "title": "fix(auth): serialize token refresh with mutex",
            "html_url": "https://github.com/ansar/panguyuban/pull/89",
            "mergeable": true,
            "additions": 84,
            "deletions": 19,
            "user": { "login": "ansar" },
            "head": { "ref": "fix/pan-142-jwt" },
            "base": { "ref": "main" }
        }"#;

        let pr = parse_github_pr(raw).unwrap();
        assert_eq!(pr.number, 89);
        assert_eq!(pr.author, "@ansar");
        assert_eq!(pr.source_branch, "fix/pan-142-jwt");
        assert_eq!(pr.target_branch, "main");
        assert_eq!(pr.linked_ticket_key, Some("PAN-142".to_string()));
        assert_eq!(pr.review_state, ReviewState::ReviewRequired);
        assert!(matches!(pr.ci_state, CiState::Pending));
    }

    #[test]
    fn parses_github_reviews_and_check_runs_into_domain_states() {
        let reviews_json = r#"[
            { "state": "COMMENTED" },
            { "state": "APPROVED" }
        ]"#;
        assert_eq!(
            parse_github_reviews(reviews_json).unwrap(),
            ReviewState::Approved
        );

        let checks_json = r#"{
            "total_count": 3,
            "check_runs": [
                { "status": "completed", "conclusion": "success" },
                { "status": "completed", "conclusion": "success" },
                { "status": "completed", "conclusion": "success" }
            ]
        }"#;
        assert_eq!(
            parse_github_check_runs(checks_json).unwrap(),
            CiState::Passing {
                passed: 3,
                total: 3
            }
        );
    }

    #[test]
    fn parses_graphql_pr_search_with_review_ci_and_merge_state() {
        let raw = r#"{ "data": { "search": { "nodes": [
            { "number": 1833, "title": "fix: price mapping", "url": "https://github.com/acme/backend/pull/1833",
              "repository": { "nameWithOwner": "acme/backend" }, "author": { "login": "ansxy" },
              "headRefName": "fix/ABC-123", "baseRefName": "main",
              "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "additions": 5, "deletions": 1,
              "reviewDecision": "APPROVED",
              "commits": { "nodes": [ { "commit": { "statusCheckRollup": { "contexts": { "nodes": [
                  { "status": "COMPLETED", "conclusion": "SUCCESS" },
                  { "status": "IN_PROGRESS", "conclusion": null },
                  { "state": "FAILURE" }
              ] } } } } ] } },
            { "number": 102, "title": "feat: order status", "url": "u",
              "repository": { "nameWithOwner": "acme/web" }, "author": null,
              "headRefName": "feat/x", "baseRefName": "develop",
              "mergeable": "CONFLICTING", "mergeStateStatus": "DIRTY", "reviewDecision": null,
              "commits": { "nodes": [ { "commit": { "statusCheckRollup": null } } ] } },
            null
        ] } } }"#;
        let prs = parse_github_pr_search(raw, true).unwrap();
        assert_eq!(prs.len(), 2);
        assert_eq!(prs[0].repo, "acme/backend");
        assert_eq!(prs[0].author, "@ansxy");
        assert_eq!(prs[0].linked_ticket_key, Some("ABC-123".to_string()));
        assert_eq!(prs[0].review_state, ReviewState::Approved);
        assert_eq!(prs[0].ci_state, CiState::Failing { failed: 1, total: 3 });
        assert!(prs[0].mergeable && prs[0].review_requested);
        assert!(!prs[1].mergeable);
        assert_eq!(prs[1].ci_state, CiState::Pending);
        assert_eq!(prs[1].review_state, ReviewState::ReviewRequired);

        let err = parse_github_pr_search(r#"{ "errors": [ { "message": "Bad credentials" } ] }"#, false);
        assert!(err.is_err());
    }

    #[test]
    fn maps_github_http_401_and_403_to_auth_expired() {
        assert_eq!(
            map_github_status_error(401, "Bad credentials"),
            CoreError::AuthExpired {
                provider: "github".to_string()
            }
        );
        assert_eq!(
            map_github_status_error(403, "Resource not accessible"),
            CoreError::AuthExpired {
                provider: "github".to_string()
            }
        );
    }
}
