//! OpenAI-compatible chat client (blocking), shared by the desktop app and `pangu`.

use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

use agent_runtime::{AgentRuntime, ChatModel, ChatReply, RuntimeError, ToolCall};
use panguyuban_core::storage::SqliteStore;
use serde::Deserialize;
use serde_json::{json, Value};

/// A provider saved in app data (no key; keys live in the keychain).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SavedProvider {
    pub id: String,
    pub name: String,
    pub base_url: String,
}

/// The saved providers; none saved means an empty list.
pub fn saved_providers(store: &SqliteStore) -> Result<Vec<SavedProvider>, String> {
    Ok(store
        .get_app_data("providers")
        .map_err(|e| e.to_string())?
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default())
}

/// The keychain key for a provider; missing or blank is `None` (local servers need no key).
pub fn provider_key(id: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new("com.ansar.panguyuban", &format!("provider:{id}")).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(key) => Ok(Some(key).filter(|k| !k.trim().is_empty())),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Trims the URL and drops trailing slashes, so `{base}/models` is always well formed.
pub fn normalize_base(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

pub fn connect_error(base: &str, e: &reqwest::Error) -> String {
    if e.is_timeout() {
        format!("{base} did not answer in time")
    } else if e.is_connect() {
        format!("Could not reach {base}. Is the server running?")
    } else {
        format!("Request to {base} failed: {e}")
    }
}

/// `choices[0].message.content`, or the server's own error message when it sent one.
fn parse_chat(body: &str) -> Result<String, String> {
    let json: Value = serde_json::from_str(body).map_err(|_| "The server's reply was not JSON".to_string())?;
    if let Some(message) = json.pointer("/error/message").and_then(Value::as_str) {
        return Err(message.to_string());
    }
    json.pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(String::from)
        .ok_or_else(|| "The model returned an empty reply".to_string())
}

/// Created on first use, never dropped; callers run it off the async workers (`spawn_blocking`).
fn client() -> &'static reqwest::blocking::Client {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::blocking::Client::builder().build().expect("HTTP client config is static"))
}

/// Runs agent turns against an OpenAI-compatible chat endpoint.
pub struct OpenAiCompat {
    pub base_url: String,
    pub api_key: Option<String>,
}

fn failed(detail: String) -> RuntimeError {
    RuntimeError::Failed { harness: "provider", detail }
}

fn require_model(model: Option<&str>) -> Result<&str, RuntimeError> {
    model.filter(|m| !m.trim().is_empty()).ok_or_else(|| failed("Pick a model for this provider".into()))
}

/// Some APIs reject an empty tools list with a 400 about tools, so it is left out.
fn chat_payload(model: &str, messages: &[Value], tools: &Value) -> Value {
    let mut payload = json!({ "model": model, "messages": messages, "tools": tools });
    if tools.as_array().is_some_and(|t| t.is_empty()) {
        payload.as_object_mut().unwrap().remove("tools");
    }
    payload
}

fn tools_unsupported(status: reqwest::StatusCode, body: &str) -> bool {
    matches!(status.as_u16(), 400 | 404 | 422) && body.to_lowercase().contains("tool")
}

impl OpenAiCompat {
    fn chat_request(&self, body: &Value, timeout: Duration) -> reqwest::blocking::RequestBuilder {
        let base = normalize_base(&self.base_url);
        let mut request = client().post(format!("{base}/chat/completions")).timeout(timeout).json(body);
        if let Some(key) = &self.api_key {
            request = request.bearer_auth(key);
        }
        request
    }

    /// POSTs `body` to `{base}/chat/completions`; returns the HTTP status and the reply body.
    fn post_chat(&self, body: Value, timeout: Duration) -> Result<(reqwest::StatusCode, String), RuntimeError> {
        let base = normalize_base(&self.base_url);
        let res = self.chat_request(&body, timeout).send().map_err(|e| {
            if e.is_timeout() {
                RuntimeError::TimedOut { harness: "provider", seconds: timeout.as_secs() }
            } else {
                failed(connect_error(&base, &e))
            }
        })?;
        let status = res.status();
        let body = res.text().map_err(|e| failed(connect_error(&base, &e)))?;
        Ok((status, body))
    }

    /// Servers put the reason in the body; show it, or the status when they don't.
    fn http_error(&self, status: reqwest::StatusCode, body: &str) -> RuntimeError {
        let detail = parse_chat(body).err().filter(|_| body.contains("\"error\""));
        failed(detail.unwrap_or_else(|| format!("{} answered HTTP {status}", normalize_base(&self.base_url))))
    }
}

impl AgentRuntime for OpenAiCompat {
    fn harness(&self) -> &'static str {
        "provider"
    }

    fn is_available(&self) -> bool {
        true
    }

    fn complete(
        &self,
        system: &str,
        prompt: &str,
        model: Option<&str>,
        _work_dir: &Path,
        timeout: Duration,
    ) -> Result<String, RuntimeError> {
        let model = require_model(model)?;
        let (status, body) = self.post_chat(
            json!({
                "model": model,
                "messages": [
                    { "role": "system", "content": system },
                    { "role": "user", "content": prompt },
                ],
            }),
            timeout,
        )?;
        if !status.is_success() {
            return Err(self.http_error(status, &body));
        }
        parse_chat(&body).map_err(failed)
    }
}

impl ChatModel for OpenAiCompat {
    fn chat(&self, messages: &[Value], tools: &Value, model: Option<&str>, timeout: Duration) -> Result<ChatReply, RuntimeError> {
        let model = require_model(model)?;
        let (status, body) = self.post_chat(chat_payload(model, messages, tools), timeout)?;
        if !status.is_success() {
            if tools_unsupported(status, &body) {
                return Err(failed("This model or provider does not support tools; pick another model".into()));
            }
            return Err(self.http_error(status, &body));
        }
        parse_tool_reply(&body).map_err(failed)
    }
}

/// `choices[0].message` as text plus tool calls. Unlike `parse_chat`, empty text is fine when
/// the model called tools; no text and no calls is an error.
fn parse_tool_reply(body: &str) -> Result<ChatReply, String> {
    let json: Value = serde_json::from_str(body).map_err(|_| "The server's reply was not JSON".to_string())?;
    if let Some(message) = json.pointer("/error/message").and_then(Value::as_str) {
        return Err(message.to_string());
    }
    let message = json.pointer("/choices/0/message");
    let text = message.and_then(|m| m.get("content")).and_then(Value::as_str).unwrap_or("").trim().to_string();
    let tool_calls: Vec<ToolCall> = message
        .and_then(|m| m.get("tool_calls"))
        .and_then(Value::as_array)
        .map(|calls| {
            calls
                .iter()
                .filter_map(|c| {
                    let arguments = c.pointer("/function/arguments").and_then(Value::as_str).unwrap_or("").trim();
                    Some(ToolCall {
                        id: c.get("id")?.as_str()?.to_string(),
                        name: c.pointer("/function/name")?.as_str()?.to_string(),
                        arguments: if arguments.is_empty() { "{}".into() } else { arguments.into() },
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    if text.is_empty() && tool_calls.is_empty() {
        return Err("The model returned an empty reply".into());
    }
    Ok(ChatReply { text, tool_calls })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn base_urls_are_trimmed() {
        assert_eq!(normalize_base("  http://localhost:20128/v1// "), "http://localhost:20128/v1");
        assert_eq!(normalize_base("https://openrouter.ai/api/v1"), "https://openrouter.ai/api/v1");
    }

    #[test]
    fn chat_replies_are_read_or_explained() {
        let ok = r#"{"choices":[{"message":{"role":"assistant","content":" hi \n"}}]}"#;
        assert_eq!(parse_chat(ok).unwrap(), "hi");
        assert_eq!(parse_chat(r#"{"error":{"message":"no credits"}}"#).unwrap_err(), "no credits");
        assert!(parse_chat(r#"{"choices":[]}"#).is_err());
        assert!(parse_chat("nope").is_err());
    }

    #[test]
    fn tool_replies_are_parsed() {
        let calls = r#"{"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[
            {"id":"c1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"prd.md\"}"}}]}}]}"#;
        let r = parse_tool_reply(calls).unwrap();
        assert_eq!(r.text, "");
        assert_eq!((r.tool_calls[0].id.as_str(), r.tool_calls[0].name.as_str()), ("c1", "read_file"));
        let text = parse_tool_reply(r#"{"choices":[{"message":{"content":"Built S1"}}]}"#).unwrap();
        assert!(text.tool_calls.is_empty());
        assert_eq!(text.text, "Built S1");
        assert!(parse_tool_reply(r#"{"error":{"message":"no credits"}}"#).unwrap_err().contains("no credits"));
        let bare = r#"{"choices":[{"message":{"content":"","tool_calls":[{"id":"c2","function":{"name":"list_files","arguments":" "}}]}}]}"#;
        assert_eq!(parse_tool_reply(bare).unwrap().tool_calls[0].arguments, "{}");
        assert_eq!(parse_tool_reply(r#"{"choices":[{"message":{"content":null}}]}"#).unwrap_err(), "The model returned an empty reply");
    }

    #[test]
    fn a_model_is_required() {
        let runtime = OpenAiCompat { base_url: "http://localhost:1".into(), api_key: None };
        let err = runtime.complete("s", "p", None, Path::new("."), Duration::from_secs(1)).unwrap_err();
        assert!(err.to_string().contains("Pick a model"));
    }

    #[test]
    fn no_key_sends_no_auth_header() {
        let body = json!({});
        let req = |key: Option<&str>| {
            OpenAiCompat { base_url: "http://localhost:1/v1/".into(), api_key: key.map(String::from) }
                .chat_request(&body, Duration::from_secs(1))
                .build()
                .unwrap()
        };
        assert!(req(None).headers().get("authorization").is_none());
        assert_eq!(req(Some("k")).headers().get("authorization").unwrap(), "Bearer k");
        assert_eq!(req(None).url().as_str(), "http://localhost:1/v1/chat/completions");
    }

    #[test]
    fn tools_errors_and_empty_tools_are_handled() {
        let runtime = OpenAiCompat { base_url: "http://localhost:1".into(), api_key: None };
        let err = runtime.http_error(reqwest::StatusCode::BAD_REQUEST, r#"{"error":{"message":"bad"}}"#);
        assert!(err.to_string().contains("bad"));
        assert_eq!(chat_payload("m", &[], &json!([])).get("tools"), None);
        assert!(chat_payload("m", &[], &json!([{"type":"function"}])).get("tools").is_some());
        assert!(tools_unsupported(reqwest::StatusCode::BAD_REQUEST, "Tools are not supported"));
        assert!(!tools_unsupported(reqwest::StatusCode::INTERNAL_SERVER_ERROR, "tool"));
    }

    #[test]
    fn saved_providers_are_read_from_app_data() {
        let store = SqliteStore::open_in_memory().unwrap();
        assert!(saved_providers(&store).unwrap().is_empty());
        store.set_app_data("providers", r#"[{"id":"x","name":"Local","baseUrl":"http://localhost:1/v1"}]"#).unwrap();
        let list = saved_providers(&store).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "Local");
    }
}
