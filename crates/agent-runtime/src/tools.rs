//! The file tools an agent may call, all confined to one project folder.

use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

/// Folders the list and search tools never enter.
const SKIPPED_DIRS: [&str; 3] = ["node_modules", ".git", ".panguyuban"];
const OUTPUT_CAP: usize = 20_000;
const MAX_MATCHES: usize = 200;

/// A project folder the tools may touch. Every file access goes through here.
pub struct Workspace {
    root: PathBuf,
    write_paths: Vec<String>,
}

impl Workspace {
    pub fn new(root: &Path, write_paths: &[String]) -> std::io::Result<Workspace> {
        Ok(Workspace { root: root.canonicalize()?, write_paths: write_paths.to_vec() })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The full path for a relative one, or why it is outside the folder. The path
    /// may not exist yet; its nearest existing ancestor must resolve inside the root.
    pub fn resolve(&self, rel: &str) -> Result<PathBuf, String> {
        let p = Path::new(rel);
        if rel.is_empty() || p.is_absolute() || p.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
            return Err(format!("path must be relative and inside the project folder: {rel:?}"));
        }
        let full = self.root.join(p);
        // symlink_metadata so a dangling link counts as existing and fails to canonicalize.
        let mut anchor = full.as_path();
        while std::fs::symlink_metadata(anchor).is_err() {
            anchor = anchor.parent().ok_or("path has no existing parent")?;
        }
        let real = anchor.canonicalize().map_err(|e| format!("cannot resolve {rel:?}: {e}"))?;
        if !real.starts_with(&self.root) {
            return Err(format!("path is outside the project folder: {rel:?}"));
        }
        Ok(full)
    }

    pub fn read(&self, rel: &str) -> Result<String, String> {
        std::fs::read_to_string(self.resolve(rel)?).map_err(|e| format!("cannot read {rel}: {e}"))
    }

    /// Writes a file the task may write, creating parent folders after the checks pass.
    pub fn write(&self, rel: &str, content: &str) -> Result<(), String> {
        let full = self.resolve(rel)?;
        if std::fs::symlink_metadata(&full).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(format!("writing {rel} is not allowed: it is a symbolic link"));
        }
        self.check_write(rel)?;
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("cannot create folder for {rel}: {e}"))?;
        }
        std::fs::write(&full, content).map_err(|e| format!("cannot write {rel}: {e}"))
    }

    /// Whether `rel` may be written: never inside `.git`, otherwise only the allowed paths.
    pub fn check_write(&self, rel: &str) -> Result<(), String> {
        // The canonical path, so `..` and linked folders cannot hide `.git` or the write list.
        let normal = crate::relative_to(&self.root, rel).ok_or_else(|| format!("path is outside the project folder: {rel:?}"))?;
        if normal.split('/').next().is_some_and(|c| c.eq_ignore_ascii_case(".git")) {
            return Err("the .git folder is off limits".into());
        }
        if !self.write_paths.iter().any(|w| w == "*" || *w == normal) {
            return Err(format!("writing {rel} is not allowed; you can write: {}", self.write_paths.join(", ")));
        }
        Ok(())
    }

    /// Path of `full` relative to the root, with forward slashes.
    fn rel(&self, full: &Path) -> String {
        full.strip_prefix(&self.root).unwrap_or(full).to_string_lossy().replace('\\', "/")
    }
}

/// What a tool returns: a one-line `summary` for the UI and the full `output` for the model.
#[derive(Debug)]
pub struct ToolResult {
    pub ok: bool,
    pub summary: String,
    pub output: String,
}

impl ToolResult {
    fn ok(summary: String, output: String) -> Self {
        ToolResult { ok: true, summary, output }
    }

    pub fn refused(summary: impl Into<String>, output: impl Into<String>) -> Self {
        ToolResult { ok: false, summary: summary.into(), output: output.into() }
    }
}

/// A tool the model can call.
pub trait Tool: Send + Sync {
    fn name(&self) -> &'static str;
    /// One OpenAI `{"type":"function","function":{…}}` entry.
    fn definition(&self) -> Value;
    fn run(&self, ws: &Workspace, args: &Value) -> ToolResult;
}

pub(crate) fn definition(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({"type": "function", "function": {
        "name": name,
        "description": description,
        "parameters": {"type": "object", "properties": properties, "required": required},
    }})
}

/// A required string argument, or a refusal naming the problem.
pub(crate) fn str_arg<'a>(args: &'a Value, field: &str) -> Result<&'a str, ToolResult> {
    args.get(field).and_then(Value::as_str).ok_or_else(|| {
        ToolResult::refused(format!("refused: bad {field}"), format!("missing or not a string: {field}"))
    })
}

fn skipped(name: &std::ffi::OsStr) -> bool {
    SKIPPED_DIRS.iter().any(|d| name == *d)
}

/// Files under `start`, skipping tool folders. Links are not followed, so a symlink
/// inside the folder can neither be walked into nor lead out.
fn walk_files(start: &Path) -> impl Iterator<Item = walkdir::DirEntry> {
    walkdir::WalkDir::new(start)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !skipped(e.file_name()))
        .flatten()
        .filter(|e| e.file_type().is_file())
}

pub struct ReadFile;
pub struct ListFiles;
pub struct Search;
pub struct WriteFile;
pub struct EditFile;

impl Tool for ReadFile {
    fn name(&self) -> &'static str {
        "read_file"
    }
    fn definition(&self) -> Value {
        definition("read_file", "Read a text file in the project folder.", json!({"path": {"type": "string", "description": "Relative path"}}), &["path"])
    }
    fn run(&self, ws: &Workspace, args: &Value) -> ToolResult {
        let path = match str_arg(args, "path") {
            Ok(p) => p,
            Err(r) => return r,
        };
        match ws.read(path) {
            Ok(text) => ToolResult::ok(format!("read {path}"), text),
            Err(e) => ToolResult::refused(format!("refused read of {path}"), e),
        }
    }
}

impl Tool for ListFiles {
    fn name(&self) -> &'static str {
        "list_files"
    }
    fn definition(&self) -> Value {
        definition("list_files", "List files matching a glob pattern such as **/*.html.", json!({"pattern": {"type": "string"}}), &["pattern"])
    }
    fn run(&self, ws: &Workspace, args: &Value) -> ToolResult {
        let pattern = match str_arg(args, "pattern") {
            Ok(p) => p,
            Err(r) => return r,
        };
        if Path::new(pattern).is_absolute() || pattern.contains("..") {
            return ToolResult::refused(format!("refused list {pattern}"), "pattern must be relative and without ..");
        }
        let pat = match glob::Pattern::new(pattern) {
            Ok(p) => p,
            Err(e) => return ToolResult::refused(format!("refused list {pattern}"), format!("bad pattern: {e}")),
        };
        let opts = glob::MatchOptions { require_literal_separator: true, ..Default::default() };
        let mut files: Vec<String> = walk_files(&ws.root)
            .map(|e| ws.rel(e.path()))
            .filter(|r| pat.matches_with(r, opts) && ws.resolve(r).is_ok())
            .collect();
        files.sort();
        ToolResult::ok(format!("listed {pattern} ({} files)", files.len()), files.join("\n"))
    }
}

impl Tool for Search {
    fn name(&self) -> &'static str {
        "search"
    }
    fn definition(&self) -> Value {
        definition(
            "search",
            "Find a text in the project's files. Output is path:line: text.",
            json!({"text": {"type": "string"}, "path": {"type": "string", "description": "Optional folder or file to search"}}),
            &["text"],
        )
    }
    fn run(&self, ws: &Workspace, args: &Value) -> ToolResult {
        let text = match str_arg(args, "text") {
            Ok(t) => t,
            Err(r) => return r,
        };
        let start = match args.get("path").and_then(Value::as_str) {
            Some(p) => match ws.resolve(p) {
                Ok(full) => full,
                Err(e) => return ToolResult::refused(format!("refused search in {p}"), e),
            },
            None => ws.root.clone(),
        };
        let mut found = Vec::new();
        'files: for entry in walk_files(&start) {
            let Ok(content) = std::fs::read_to_string(entry.path()) else { continue };
            for (i, line) in content.lines().enumerate().filter(|(_, l)| l.contains(text)) {
                found.push(format!("{}:{}: {}", ws.rel(entry.path()), i + 1, line.trim()));
                if found.len() >= MAX_MATCHES {
                    break 'files;
                }
            }
        }
        ToolResult::ok(format!("searched \"{text}\" ({} matches)", found.len()), found.join("\n"))
    }
}

impl Tool for WriteFile {
    fn name(&self) -> &'static str {
        "write_file"
    }
    fn definition(&self) -> Value {
        definition(
            "write_file",
            "Create or replace a file. Only some paths are writable.",
            json!({"path": {"type": "string"}, "content": {"type": "string"}}),
            &["path", "content"],
        )
    }
    fn run(&self, ws: &Workspace, args: &Value) -> ToolResult {
        let (path, content) = match (str_arg(args, "path"), str_arg(args, "content")) {
            (Ok(p), Ok(c)) => (p, c),
            (Err(r), _) | (_, Err(r)) => return r,
        };
        match ws.write(path, content) {
            Ok(()) => ToolResult::ok(format!("wrote {path}"), format!("wrote {} characters to {path}", content.chars().count())),
            Err(e) => ToolResult::refused(format!("refused write to {path}"), e),
        }
    }
}

impl Tool for EditFile {
    fn name(&self) -> &'static str {
        "edit_file"
    }
    fn definition(&self) -> Value {
        definition(
            "edit_file",
            "Replace one exact piece of text in a file. `old` must appear exactly once.",
            json!({"path": {"type": "string"}, "old": {"type": "string"}, "new": {"type": "string"}}),
            &["path", "old", "new"],
        )
    }
    fn run(&self, ws: &Workspace, args: &Value) -> ToolResult {
        let (path, old, new) = match (str_arg(args, "path"), str_arg(args, "old"), str_arg(args, "new")) {
            (Ok(p), Ok(o), Ok(n)) => (p, o, n),
            (Err(r), _, _) | (_, Err(r), _) | (_, _, Err(r)) => return r,
        };
        let refuse = |why: String| ToolResult::refused(format!("refused edit of {path}"), why);
        let text = match ws.read(path) {
            Ok(t) => t,
            Err(e) => return refuse(e),
        };
        match text.matches(old).count() {
            0 if old.is_empty() => return refuse("old must not be empty".into()),
            0 => return refuse(format!("old text not found in {path}")),
            1 => {}
            n => return refuse(format!("old text appears {n} times in {path}; include more context so it matches once")),
        }
        match ws.write(path, &text.replacen(old, new, 1)) {
            Ok(()) => ToolResult::ok(format!("edited {path}"), format!("edited {path}")),
            Err(e) => ToolResult::refused(format!("refused write to {path}"), e),
        }
    }
}

pub fn builtin_tool(name: &str) -> Option<Box<dyn Tool>> {
    Some(match name {
        "read_file" => Box::new(ReadFile),
        "list_files" => Box::new(ListFiles),
        "search" => Box::new(Search),
        "write_file" => Box::new(WriteFile),
        "edit_file" => Box::new(EditFile),
        _ => return None,
    })
}

/// The named built-in tools, in order; unknown names are skipped.
pub fn tools_named(names: &[String]) -> Vec<Box<dyn Tool>> {
    names.iter().filter_map(|n| builtin_tool(n)).collect()
}

/// Cuts text sent to the model at 20 000 characters, with a note of what was left out.
pub fn cap_output(text: &str) -> String {
    match text.char_indices().nth(OUTPUT_CAP) {
        None => text.to_string(),
        Some((at, _)) => format!("{}\n[output cut: {} more characters]", &text[..at], text[at..].chars().count()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    fn setup() -> (tempfile::TempDir, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("prd.md"), "# Orders\n").unwrap();
        fs::create_dir(dir.path().join("app")).unwrap();
        fs::write(dir.path().join("app/index.html"), "<p>total</p>").unwrap();
        let ws = Workspace::new(dir.path(), &["app/index.html".to_string()]).unwrap();
        (dir, ws)
    }

    fn run(ws: &Workspace, name: &str, args: serde_json::Value) -> ToolResult {
        builtin_tool(name).unwrap().run(ws, &args)
    }

    #[test]
    fn reads_inside_the_folder() {
        let (_d, ws) = setup();
        let r = run(&ws, "read_file", json!({"path":"prd.md"}));
        assert!(r.ok);
        assert_eq!(r.output, "# Orders\n");
        assert_eq!(r.summary, "read prd.md");
    }

    #[test]
    fn paths_cannot_leave_the_folder() {
        let (d, ws) = setup();
        let outside = d.path().parent().unwrap().join("x");
        for p in ["../x", "/etc/hosts", "app/../../x", ""] {
            assert!(!run(&ws, "read_file", json!({"path":p})).ok, "{p}");
            assert!(!run(&ws, "write_file", json!({"path":p,"content":"hi"})).ok, "{p}");
        }
        assert!(!outside.exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_leave_the_folder() {
        let (d, _) = setup();
        let other = tempfile::tempdir().unwrap();
        fs::write(other.path().join("a.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(other.path(), d.path().join("out")).unwrap();
        // A dangling link must not be followed when creating a file either.
        std::os::unix::fs::symlink(other.path().join("c.txt"), d.path().join("dangling")).unwrap();
        let ws = Workspace::new(d.path(), &["*".to_string()]).unwrap();
        assert!(!run(&ws, "read_file", json!({"path":"out/a.txt"})).ok);
        assert!(!run(&ws, "write_file", json!({"path":"out/b.txt","content":"x"})).ok);
        assert!(!run(&ws, "write_file", json!({"path":"dangling","content":"x"})).ok);
        assert!(!other.path().join("b.txt").exists());
        assert!(!other.path().join("c.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_write_will_not_go_through_a_symlink() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("prd.md"), "spec").unwrap();
        fs::create_dir(d.path().join("app")).unwrap();
        std::os::unix::fs::symlink("../prd.md", d.path().join("app/index.html")).unwrap();
        let ws = Workspace::new(d.path(), &["app/index.html".to_string()]).unwrap();
        let r = run(&ws, "write_file", json!({"path":"app/index.html","content":"x"}));
        assert!(!r.ok && r.output.contains("symbolic link"));
        assert_eq!(fs::read_to_string(d.path().join("prd.md")).unwrap(), "spec");
    }

    #[test]
    fn git_is_off_limits_even_with_star() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::new(dir.path(), &["*".to_string()]).unwrap();
        let err = ws.write(".git/config", "x").unwrap_err();
        assert!(err.contains("off limits"));
        assert!(!dir.path().join(".git").exists());
    }

    #[test]
    fn writes_only_the_allowed_paths() {
        let (d, ws) = setup();
        let r = run(&ws, "write_file", json!({"path":"prd.md","content":"x"}));
        assert!(!r.ok);
        assert_eq!(r.summary, "refused write to prd.md");
        assert_eq!(fs::read_to_string(d.path().join("prd.md")).unwrap(), "# Orders\n");
        let r = run(&ws, "write_file", json!({"path":"app/index.html","content":"new"}));
        assert!(r.ok);
        assert_eq!(r.summary, "wrote app/index.html");
        assert_eq!(fs::read_to_string(d.path().join("app/index.html")).unwrap(), "new");
    }

    #[test]
    fn star_allows_any_path_inside() {
        let d = tempfile::tempdir().unwrap();
        let ws = Workspace::new(d.path(), &["*".to_string()]).unwrap();
        assert!(run(&ws, "write_file", json!({"path":"a/b/c.txt","content":"x"})).ok);
        assert_eq!(fs::read_to_string(d.path().join("a/b/c.txt")).unwrap(), "x");
    }

    #[test]
    fn refused_write_creates_no_folders() {
        let (d, ws) = setup();
        assert!(!run(&ws, "write_file", json!({"path":"new/dir/f.txt","content":"x"})).ok);
        assert!(!d.path().join("new").exists());
    }

    #[test]
    fn edit_needs_one_exact_match() {
        let (d, ws) = setup();
        let f = d.path().join("app/index.html");
        fs::write(&f, "a b a").unwrap();
        let r = run(&ws, "edit_file", json!({"path":"app/index.html","old":"zzz","new":"y"}));
        assert!(!r.ok && r.output.contains("not found"));
        let r = run(&ws, "edit_file", json!({"path":"app/index.html","old":"a","new":"y"}));
        assert!(!r.ok && r.output.contains("2 times"));
        assert_eq!(fs::read_to_string(&f).unwrap(), "a b a");
        let r = run(&ws, "edit_file", json!({"path":"app/index.html","old":"b","new":"y"}));
        assert!(r.ok);
        assert_eq!(r.summary, "edited app/index.html");
        assert_eq!(fs::read_to_string(&f).unwrap(), "a y a");
    }

    #[test]
    fn bad_arguments_are_refused_not_fatal() {
        let (_d, ws) = setup();
        let r = run(&ws, "write_file", json!({"path":"app/index.html"}));
        assert!(!r.ok && r.output.contains("content"));
        let r = run(&ws, "read_file", json!({"path": 5}));
        assert!(!r.ok && r.output.contains("path"));
        assert!(!run(&ws, "read_file", json!("not an object")).ok);
    }

    #[test]
    fn list_and_search_skip_tool_folders() {
        let (d, ws) = setup();
        fs::create_dir(d.path().join("node_modules")).unwrap();
        fs::write(d.path().join("node_modules/x.js"), "total").unwrap();
        let r = run(&ws, "list_files", json!({"pattern":"**/*.*"}));
        assert!(r.ok);
        assert!(r.output.contains("app/index.html"));
        assert!(!r.output.contains("node_modules"));
        let r = run(&ws, "search", json!({"text":"total"}));
        assert!(r.ok);
        assert!(r.output.contains("app/index.html:1: <p>total</p>"));
        assert!(!r.output.contains("node_modules"));
        assert_eq!(r.summary, "searched \"total\" (1 matches)");
        assert!(!run(&ws, "list_files", json!({"pattern":"../*"})).ok);
        assert!(!run(&ws, "list_files", json!({"pattern":"/etc/*"})).ok);
    }

    #[cfg(unix)]
    #[test]
    fn list_does_not_walk_through_symlinks() {
        let (d, ws) = setup();
        let other = tempfile::tempdir().unwrap();
        fs::write(other.path().join("a.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(other.path(), d.path().join("out")).unwrap();
        std::os::unix::fs::symlink(".", d.path().join("loop")).unwrap();
        let r = run(&ws, "list_files", json!({"pattern":"**/*"}));
        assert!(r.ok);
        assert!(r.output.contains("app/index.html"));
        assert!(!r.output.contains("out/a.txt") && !r.output.contains("loop"));
    }

    #[test]
    fn long_output_is_cut_with_a_note() {
        let text = "a".repeat(20_005);
        let cut = cap_output(&text);
        assert_eq!(cut, format!("{}\n[output cut: 5 more characters]", "a".repeat(20_000)));
        assert_eq!(cap_output("short"), "short");
    }

    #[test]
    fn tools_are_found_by_name() {
        let names: Vec<_> = tools_named(&["edit_file".into(), "nope".into(), "read_file".into()])
            .iter()
            .map(|t| t.name())
            .collect();
        assert_eq!(names, ["edit_file", "read_file"]);
        for n in ["read_file", "list_files", "search", "write_file", "edit_file"] {
            let t = builtin_tool(n).unwrap();
            assert_eq!(t.definition()["function"]["name"], t.name());
        }
    }
}
