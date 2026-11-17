//! Links the bundled pangu binary onto PATH as `pangu`.
use std::path::{Path, PathBuf};

/// The sidecar's name inside the app. Not `pangu`, so Tauri's copy never lands on `target/<profile>/pangu`.
const BUNDLED: &str = "pangu-cli";

const BIN_DIRS: [&str; 2] = ["/opt/homebrew/bin", "/usr/local/bin"];

/// First of the usual bin folders that exists and is writable.
pub fn cli_link_target() -> Option<PathBuf> {
    BIN_DIRS.iter().map(PathBuf::from).find(|d| {
        std::ffi::CString::new(d.as_os_str().as_encoded_bytes())
            .is_ok_and(|c| unsafe { libc::access(c.as_ptr(), libc::W_OK) } == 0)
    })
}

/// The `pangu` link in the first dir where it is a symlink to `bundled`.
fn status_in(dirs: &[PathBuf], bundled: &Path) -> Option<PathBuf> {
    dirs.iter().map(|d| d.join("pangu")).find(|l| {
        std::fs::symlink_metadata(l).is_ok_and(|m| m.file_type().is_symlink())
            && std::fs::read_link(l).is_ok_and(|t| t == bundled)
    })
}

/// Creates or replaces the symlink `<dir>/pangu`; never replaces a regular file.
pub fn link_into(dir: &Path, source: &Path) -> Result<PathBuf, String> {
    let link = dir.join("pangu");
    match std::fs::symlink_metadata(&link) {
        Ok(m) if m.file_type().is_symlink() => std::fs::remove_file(&link).map_err(|e| e.to_string())?,
        Ok(_) => return Err(format!("{} exists and is not a link; remove it first", link.display())),
        Err(_) => {}
    }
    std::os::unix::fs::symlink(source, &link).map_err(|e| e.to_string())?;
    Ok(link)
}

fn bundled() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(|d| d.join(BUNDLED)).filter(|p| p.exists())
}

#[tauri::command]
pub fn install_pangu() -> Result<String, String> {
    let source = bundled().ok_or("pangu is not bundled in this build")?;
    let dir = cli_link_target().ok_or("no writable /opt/homebrew/bin or /usr/local/bin")?;
    Ok(link_into(&dir, &source)?.display().to_string())
}

/// The link path, if `<dir>/pangu` is a symlink to the bundled binary.
#[tauri::command]
pub fn pangu_status() -> Option<String> {
    let dirs: Vec<PathBuf> = BIN_DIRS.iter().map(PathBuf::from).collect();
    status_in(&dirs, &bundled()?).map(|p| p.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_are_replaced_but_files_are_not() {
        let dir = std::env::temp_dir().join(format!("pangu-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (a, b) = (dir.join(BUNDLED), dir.join("b"));
        std::fs::write(&a, "a").unwrap();
        std::fs::write(&b, "b").unwrap();
        let bin = dir.join("bin");
        std::fs::create_dir(&bin).unwrap();

        let link = link_into(&bin, &a).unwrap();
        assert_eq!(link, bin.join("pangu"));
        assert_eq!(std::fs::read_link(&link).unwrap(), a);
        link_into(&bin, &b).unwrap();
        assert_eq!(std::fs::read_link(&link).unwrap(), b);

        std::fs::remove_file(&link).unwrap();
        std::fs::write(&link, "mine").unwrap();
        let err = link_into(&bin, &a).unwrap_err();
        assert!(err.contains("is not a link"), "{err}");
        assert_eq!(std::fs::read_to_string(&link).unwrap(), "mine");

        // status: only a link to the bundled binary counts
        std::fs::remove_file(&link).unwrap();
        let dirs = [dir.join("missing"), bin.clone()];
        assert_eq!(status_in(&dirs, &a), None);
        link_into(&bin, &a).unwrap();
        assert_eq!(status_in(&dirs, &a), Some(link.clone()));
        assert_eq!(status_in(&dirs, &b), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
