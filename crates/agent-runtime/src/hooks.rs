//! Checks that run around every tool call: `before` can refuse it, `after` can add a note.

use serde_json::Value;

use crate::{ToolCall, ToolResult, Workspace};

pub trait Hook: Send + Sync {
    fn name(&self) -> &'static str;
    /// Refuse the call by returning the reason, which goes back to the model.
    fn before(&self, _call: &ToolCall, _args: &Value) -> Result<(), String> {
        Ok(())
    }
    fn after(&self, _call: &ToolCall, _ws: &Workspace, _result: &mut ToolResult) {}
}

/// Warns the model when a file it wrote links to the web, which the preview blocks.
pub struct NoExternalUrls;

impl Hook for NoExternalUrls {
    fn name(&self) -> &'static str {
        "no_external_urls"
    }
    fn after(&self, call: &ToolCall, ws: &Workspace, result: &mut ToolResult) {
        if !result.ok || !matches!(call.name.as_str(), "write_file" | "edit_file") {
            return;
        }
        let args: Value = serde_json::from_str(&call.arguments).unwrap_or(Value::Null);
        let Some(path) = args.get("path").and_then(Value::as_str) else { return };
        if let Ok(text) = ws.read(path) {
            if text.contains("http://") || text.contains("https://") {
                result.output.push_str(
                    "\nNote: this file links to http(s) URLs. The preview blocks them; inline the content or remove the links.",
                );
            }
        }
    }
}

pub fn builtin_hook(name: &str) -> Option<Box<dyn Hook>> {
    Some(match name {
        "no_external_urls" => Box::new(NoExternalUrls),
        _ => return None,
    })
}

/// The named built-in hooks, in order; unknown names are skipped.
pub fn hooks_named(names: &[String]) -> Vec<Box<dyn Hook>> {
    names.iter().filter_map(|n| builtin_hook(n)).collect()
}
