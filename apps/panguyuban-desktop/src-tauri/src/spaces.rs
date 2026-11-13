//! A space is named after its terminal's folder. This reads that folder: its git
//! state for the sidebar, and its files and uncommitted changes for the side panel.

use std::path::Path;
use std::process::Command;

use serde::Serialize;

use crate::terminal::expand_home;

/// Untracked files beyond this many are left out of the changes diff.
const MAX_NEW_FILES: usize = 50;
/// Files bigger than this are not previewed.
const MAX_PREVIEW_BYTES: u64 = 512 * 1024;

#[derive(Debug, Serialize, PartialEq)]
pub struct SpaceStatus {
    pub path: String,
    pub branch: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// `owner/repo` of the GitHub `origin` remote, used to scope pull requests.
    pub github_repo: Option<String>,
}

fn git(path: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git").arg("-C").arg(path).args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// `path` may start with `~`; it is echoed back as given so the UI can key by it.
pub fn status(path: &str) -> SpaceStatus {
    let dir = expand_home(path);
    let dir = dir.as_path();
    // `behind ahead` relative to the upstream; no upstream means 0/0.
    let (behind, ahead) = git(dir, &["rev-list", "--left-right", "--count", "@{u}...HEAD"])
        .and_then(|s| {
            let (b, a) = s.split_once('\t')?;
            Some((b.parse().ok()?, a.parse().ok()?))
        })
        .unwrap_or((0, 0));
    SpaceStatus {
        path: path.to_string(),
        branch: git(dir, &["rev-parse", "--abbrev-ref", "HEAD"]),
        ahead,
        behind,
        github_repo: git(dir, &["remote", "get-url", "origin"]).and_then(|u| github_repo(&u)),
    }
}

#[derive(Debug, Serialize, PartialEq)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
}

/// One folder level, folders first. Hides `.git` and `.DS_Store`.
pub fn list_dir(path: &str) -> Result<Vec<DirEntry>, String> {
    let mut entries: Vec<DirEntry> = std::fs::read_dir(expand_home(path))
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| DirEntry {
            name: e.file_name().to_string_lossy().into_owned(),
            // follows symlinks, so a linked folder can be opened
            is_dir: e.path().is_dir(),
        })
        .filter(|e| e.name != ".git" && e.name != ".DS_Store")
        .collect();
    entries.sort_by_key(|e| (!e.is_dir, e.name.to_lowercase()));
    Ok(entries)
}

/// A text file's contents for preview.
pub fn read_file(path: &str) -> Result<String, String> {
    let path = expand_home(path);
    let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if size > MAX_PREVIEW_BYTES {
        return Err(format!("File is {} KB, too big to preview", size / 1024));
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.contains(&0) {
        return Err("Binary file".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Uncommitted changes as one unified diff: edits since HEAD (staged or not),
/// then untracked files shown as new.
pub fn changes(path: &str) -> Result<Vec<String>, String> {
    let dir = expand_home(path);
    let dir = dir.as_path();
    git(dir, &["rev-parse", "--is-inside-work-tree"]).ok_or("Not a git repository")?;
    // A repo with no commits yet has no HEAD to diff against.
    let mut diff = git(dir, &["diff", "HEAD", "--no-color", "--no-ext-diff"])
        .or_else(|| git(dir, &["diff", "--cached", "--no-color", "--no-ext-diff"]))
        .unwrap_or_default();
    let untracked = git(dir, &["ls-files", "--others", "--exclude-standard"]).unwrap_or_default();
    for file in untracked.lines().take(MAX_NEW_FILES) {
        // --no-index exits 1 when files differ, so read the output whatever the status.
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["diff", "--no-color", "--no-index", "--", "/dev/null", file])
            .output()
            .map_err(|e| e.to_string())?;
        diff.push('\n');
        diff.push_str(String::from_utf8_lossy(&out.stdout).trim_end());
    }
    // A clean tree is no lines (the UI shows "No changes"), not one empty line.
    Ok(diff.trim().lines().map(str::to_string).collect())
}

/// `owner/repo` from an SSH or HTTPS GitHub remote URL.
fn github_repo(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("git@github.com:")
        .or_else(|| url.split_once("github.com/").map(|(_, r)| r))?;
    let repo = rest.trim_end_matches('/').trim_end_matches(".git");
    (repo.split('/').count() == 2).then(|| repo.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_owner_and_repo_from_github_remotes() {
        assert_eq!(github_repo("git@github.com:ansxy/panguyuban.git").as_deref(), Some("ansxy/panguyuban"));
        assert_eq!(github_repo("https://github.com/ansxy/panguyuban").as_deref(), Some("ansxy/panguyuban"));
        assert_eq!(github_repo("https://x@github.com/a/b.git/").as_deref(), Some("a/b"));
        assert_eq!(github_repo("git@gitlab.com:a/b.git"), None);
    }

    #[test]
    fn changes_cover_edits_and_new_files() {
        let dir = std::env::temp_dir().join(format!("pan-changes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.to_str().unwrap();
        let run = |args: &[&str]| assert!(git(&dir, args).is_some(), "git {args:?}");
        run(&["init", "-q"]);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        run(&["add", "a.txt"]);
        run(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
        std::fs::write(dir.join("a.txt"), "two\n").unwrap();
        std::fs::write(dir.join("new.txt"), "fresh\n").unwrap();

        let diff = changes(path).unwrap();
        assert!(diff.contains(&"-one".to_string()) && diff.contains(&"+two".to_string()), "{diff:?}");
        assert!(diff.contains(&"+fresh".to_string()), "{diff:?}");

        let names: Vec<_> = list_dir(path).unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names, ["a.txt", "new.txt"]);
        assert_eq!(read_file(&format!("{path}/new.txt")).unwrap(), "fresh\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_folder_outside_git_has_no_changes() {
        assert_eq!(changes("/").unwrap_err(), "Not a git repository");
    }

    #[test]
    fn a_folder_outside_git_has_no_branch() {
        let s = status("/");
        assert_eq!((s.branch, s.ahead, s.behind, s.github_repo), (None, 0, 0, None));
    }
}
