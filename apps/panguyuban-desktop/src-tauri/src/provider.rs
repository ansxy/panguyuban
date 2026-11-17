//! OpenAI-compatible providers (OpenRouter, 9router, any server with `/models` and
//! `/chat/completions`). The list lives in app data without keys; each key lives in
//! the OS keychain under `provider:<id>` and never goes back to the UI.

use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

use agent_runtime::{
    hooks_named, tools_named, AgentRuntime, ChatModel, ChatReply, Effective, Harness, RuntimeError, TaskRuntime, ToolCall,
};
use panguyuban_core::storage::SqliteStore;
use panguyuban_core::traits::SecretStore;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::builder::ModelOption;
use crate::KeyringSecretStore;

const MODELS_TIMEOUT: Duration = Duration::from_secs(20);
/// The prefix of a harness string that names a saved provider: `provider:<id>`.
pub const HARNESS_PREFIX: &str = "provider:";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedProvider {
    id: String,
    base_url: String,
}

/// One store for every provider key, so its read cache is shared.
fn secrets() -> &'static KeyringSecretStore {
    static SECRETS: OnceLock<KeyringSecretStore> = OnceLock::new();
    SECRETS.get_or_init(|| KeyringSecretStore::new("com.ansar.panguyuban"))
}

fn secret_name(id: &str) -> String {
    format!("provider:{id}")
}

/// The saved key, if any. Empty counts as none (local servers need no key).
fn key_for(id: &str) -> Result<Option<String>, String> {
    let key = secrets().get_secret(&secret_name(id)).map_err(|e| e.to_string())?;
    Ok(key.filter(|k| !k.trim().is_empty()))
}

pub fn set_key(id: &str, key: &str) -> Result<(), String> {
    secrets().set_secret(&secret_name(id), key.trim()).map_err(|e| e.to_string())
}

pub fn delete_key(id: &str) -> Result<(), String> {
    secrets().delete_secret(&secret_name(id)).map_err(|e| e.to_string())
}

pub fn has_key(id: &str) -> Result<bool, String> {
    key_for(id).map(|k| k.is_some())
}

/// Trims the URL and drops trailing slashes, so `{base}/models` is always well formed.
fn normalize_base(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

/// `data[].id` with `name` as the label when present, sorted by id.
fn parse_models(body: &str) -> Result<Vec<ModelOption>, String> {
    let json: Value = serde_json::from_str(body)
        .map_err(|_| "The server's reply was not JSON. Is the base URL right (it usually ends in /v1)?".to_string())?;
    let data = json
        .get("data")
        .and_then(Value::as_array)
        .ok_or("The server's reply has no model list (expected {\"data\": [...]})")?;
    let mut models: Vec<ModelOption> = data
        .iter()
        .filter_map(|m| {
            let id = m.get("id")?.as_str()?.trim();
            let label = m.get("name").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty());
            (!id.is_empty()).then(|| ModelOption { id: id.into(), label: label.unwrap_or(id).into() })
        })
        .collect();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(models)
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

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().build().expect("HTTP client config is static"))
}

fn connect_error(base: &str, e: &reqwest::Error) -> String {
    if e.is_timeout() {
        format!("{base} did not answer in time")
    } else if e.is_connect() {
        format!("Could not reach {base}. Is the server running?")
    } else {
        format!("Request to {base} failed: {e}")
    }
}

/// Lists the models a provider offers, using its saved key if it has one.
pub async fn models(id: &str, base_url: &str) -> Result<Vec<ModelOption>, String> {
    let base = normalize_base(base_url);
    if base.is_empty() {
        return Err("Enter a base URL".into());
    }
    let mut request = client().get(format!("{base}/models")).timeout(MODELS_TIMEOUT);
    if let Some(key) = key_for(id)? {
        request = request.bearer_auth(key);
    }
    let res = request.send().await.map_err(|e| connect_error(&base, &e))?;
    let status = res.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 | 403 => format!("{base} rejected the API key (HTTP {status})"),
            _ => format!("{base} answered HTTP {status}"),
        });
    }
    let body = res.text().await.map_err(|e| connect_error(&base, &e))?;
    parse_models(&body)
}

/// Runs one agent turn against an OpenAI-compatible chat endpoint.
pub struct OpenAiCompatRuntime {
    pub base_url: String,
    pub api_key: Option<String>,
}

fn failed(detail: String) -> RuntimeError {
    RuntimeError::Failed { harness: "provider", detail }
}

fn require_model(model: Option<&str>) -> Result<&str, RuntimeError> {
    model.filter(|m| !m.trim().is_empty()).ok_or_else(|| failed("Pick a model for this provider".into()))
}

impl OpenAiCompatRuntime {
    /// POSTs `body` to `{base}/chat/completions`; returns the HTTP status and the reply body.
    fn post_chat(&self, body: Value, timeout: Duration) -> Result<(reqwest::StatusCode, String), RuntimeError> {
        let base = normalize_base(&self.base_url);
        let mut request = client().post(format!("{base}/chat/completions")).timeout(timeout).json(&body);
        if let Some(key) = &self.api_key {
            request = request.bearer_auth(key);
        }
        // Builder commands call this from `spawn_blocking`, a plain thread outside the async
        // workers, so blocking on the app's runtime here is allowed and cannot stall it.
        tauri::async_runtime::block_on(async {
            let res = request.send().await.map_err(|e| {
                if e.is_timeout() {
                    RuntimeError::TimedOut { harness: "provider", seconds: timeout.as_secs() }
                } else {
                    failed(connect_error(&base, &e))
                }
            })?;
            let status = res.status();
            let body = res.text().await.map_err(|e| failed(connect_error(&base, &e)))?;
            Ok((status, body))
        })
    }

    /// Servers put the reason in the body; show it, or the status when they don't.
    fn http_error(&self, status: reqwest::StatusCode, body: &str) -> RuntimeError {
        let detail = parse_chat(body).err().filter(|_| body.contains("\"error\""));
        failed(detail.unwrap_or_else(|| format!("{} answered HTTP {status}", normalize_base(&self.base_url))))
    }
}

impl AgentRuntime for OpenAiCompatRuntime {
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

impl ChatModel for OpenAiCompatRuntime {
    fn chat(&self, messages: &[Value], tools: &Value, model: Option<&str>, timeout: Duration) -> Result<ChatReply, RuntimeError> {
        let model = require_model(model)?;
        let mut payload = json!({ "model": model, "messages": messages, "tools": tools });
        // Some APIs reject an empty tools list with a 400 about tools.
        if tools.as_array().is_some_and(|t| t.is_empty()) {
            payload.as_object_mut().unwrap().remove("tools");
        }
        let (status, body) = self.post_chat(payload, timeout)?;
        if !status.is_success() {
            if matches!(status.as_u16(), 400 | 404 | 422) && body.to_lowercase().contains("tool") {
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

fn unsupported(label: &str) -> String {
    format!("Building with {label} is not supported yet; pick a provider agent")
}

fn saved_runtime(store: &SqliteStore, id: &str) -> Result<OpenAiCompatRuntime, String> {
    let saved = store
        .get_app_data("providers")
        .map_err(|e| e.to_string())?
        .and_then(|json| serde_json::from_str::<Vec<SavedProvider>>(&json).ok())
        .and_then(|list| list.into_iter().find(|p| p.id == id))
        .ok_or("That provider is no longer saved. Add it again in Settings")?;
    Ok(OpenAiCompatRuntime { base_url: saved.base_url, api_key: key_for(id)? })
}

/// The tool-calling runtime for a task: only saved providers can drive it.
pub fn task_runtime_for(store: &SqliteStore, harness: &str, label: &str, effective: &Effective) -> Result<Box<dyn TaskRuntime>, String> {
    let Some(id) = harness.strip_prefix(HARNESS_PREFIX) else {
        return Err(unsupported(label));
    };
    Ok(Box::new(Harness {
        chat: Box::new(saved_runtime(store, id)?),
        tools: tools_named(&effective.tools),
        hooks: hooks_named(&effective.hooks),
    }))
}

/// The runtime for a harness string: `provider:<id>` from the saved list and keychain,
/// anything else from the agent-runtime crate.
pub fn runtime_for(store: &SqliteStore, harness: &str) -> Result<Box<dyn AgentRuntime>, String> {
    let Some(id) = harness.strip_prefix(HARNESS_PREFIX) else {
        return agent_runtime::runtime_for(harness).map_err(|e| e.to_string());
    };
    Ok(Box::new(saved_runtime(store, id)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openrouter_models_use_names_and_are_sorted() {
        let body = r#"{"data":[
            {"id":"openai/gpt-x","name":"OpenAI: GPT X","context_length":128000,"pricing":{"prompt":"0.1"}},
            {"id":"anthropic/claude-y","name":"Anthropic: Claude Y"}]}"#;
        let models = parse_models(body).unwrap();
        assert_eq!(models[0].id, "anthropic/claude-y");
        assert_eq!(models[1].label, "OpenAI: GPT X");
    }

    #[test]
    fn minimal_models_fall_back_to_the_id() {
        let models = parse_models(r#"{"data":[{"id":"b"},{"id":"a","name":""},{"object":"x"}]}"#).unwrap();
        assert_eq!(models.iter().map(|m| (m.id.as_str(), m.label.as_str())).collect::<Vec<_>>(), [("a", "a"), ("b", "b")]);
    }

    #[test]
    fn bad_model_replies_are_explained() {
        assert!(parse_models("<html>").unwrap_err().contains("not JSON"));
        assert!(parse_models(r#"{"error":"x"}"#).unwrap_err().contains("no model list"));
    }

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
    fn only_providers_can_build() {
        assert_eq!(unsupported("Claude lead"), "Building with Claude lead is not supported yet; pick a provider agent");
    }

    #[test]
    fn a_model_is_required() {
        let runtime = OpenAiCompatRuntime { base_url: "http://localhost:1".into(), api_key: None };
        let err = runtime.complete("s", "p", None, Path::new("."), Duration::from_secs(1)).unwrap_err();
        assert!(err.to_string().contains("Pick a model"));
    }
}
