//! Links the bundled `pangu` binary onto PATH.
use std::path::{Path, PathBuf};

/// First of the usual bin folders that exists and is writable.
pub fn cli_link_target() -> Option<PathBuf> {
    ["/opt/homebrew/bin", "/usr/local/bin"].iter().map(PathBuf::from).find(|d| {
        std::fs::metadata(d).map(|m| m.is_dir() && !m.permissions().readonly()).unwrap_or(false)
            && std::fs::File::create(d.join(".pangu-write-test")).is_ok_and(|_| {
                let _ = std::fs::remove_file(d.join(".pangu-write-test"));
                true
            })
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
    std::env::current_exe().ok()?.parent().map(|d| d.join("pangu")).filter(|p| p.exists())
}

#[tauri::command]
pub fn install_pangu() -> Result<String, String> {
    let source = bundled().ok_or("pangu is not bundled in this build")?;
    let dir = cli_link_target().ok_or("no writable /opt/homebrew/bin or /usr/local/bin")?;
    Ok(link_into(&dir, &source)?.display().to_string())
}

/// The link path, if `<target>/pangu` is a symlink to the bundled binary.
#[tauri::command]
pub fn pangu_status() -> Option<String> {
    let link = cli_link_target()?.join("pangu");
    (std::fs::read_link(&link).ok()? == bundled()?).then(|| link.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_are_replaced_but_files_are_not() {
        let dir = std::env::temp_dir().join(format!("pangu-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (a, b) = (dir.join("a"), dir.join("b"));
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
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
