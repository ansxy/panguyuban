//! OpenAI-compatible providers (OpenRouter, 9router, any server with `/models` and
//! `/chat/completions`). The list lives in app data without keys; each key lives in
//! the OS keychain under `provider:<id>` and never goes back to the UI.

use std::sync::OnceLock;
use std::time::Duration;

use agent_runtime::{hooks_named, tools_named, AgentRuntime, Effective, Harness, TaskRuntime};
use panguyuban_core::storage::SqliteStore;
use panguyuban_core::traits::SecretStore;
use provider_openai::{connect_error, normalize_base, OpenAiCompat};
use serde_json::Value;

use crate::builder::ModelOption;
use crate::KeyringSecretStore;

const MODELS_TIMEOUT: Duration = Duration::from_secs(20);
/// The prefix of a harness string that names a saved provider: `provider:<id>`.
pub const HARNESS_PREFIX: &str = "provider:";

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

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().build().expect("HTTP client config is static"))
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

fn unsupported(label: &str) -> String {
    format!("Building with {label} is not supported yet; pick a provider agent")
}

fn saved_runtime(store: &SqliteStore, id: &str) -> Result<OpenAiCompat, String> {
    let saved = provider_openai::saved_providers(store)?
        .into_iter()
        .find(|p| p.id == id)
        .ok_or("That provider is no longer saved. Add it again in Settings")?;
    Ok(OpenAiCompat { base_url: saved.base_url, api_key: key_for(id)? })
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
    fn only_providers_can_build() {
        assert_eq!(unsupported("Claude lead"), "Building with Claude lead is not supported yet; pick a provider agent");
    }
}
