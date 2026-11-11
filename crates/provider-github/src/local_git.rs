use std::path::Path;

use git2::{build::CheckoutBuilder, BranchType, Repository};
use panguyuban_core::error::CoreError;

pub fn create_and_checkout_branch_in_repo(
    repo_path: &Path,
    branch_name: &str,
) -> Result<(), CoreError> {
    let repo = Repository::open(repo_path).map_err(|e| CoreError::GitLocalError(e.to_string()))?;
    let head = repo
        .head()
        .map_err(|e| CoreError::GitLocalError(e.to_string()))?;
    let head_commit = head
        .peel_to_commit()
        .map_err(|e| CoreError::GitLocalError(e.to_string()))?;

    if repo.find_branch(branch_name, BranchType::Local).is_err() {
        repo.branch(branch_name, &head_commit, false)
            .map_err(|e| CoreError::GitLocalError(e.to_string()))?;
    }

    checkout_existing_branch_in_repo(repo_path, branch_name)
}

pub fn checkout_existing_branch_in_repo(
    repo_path: &Path,
    branch_name: &str,
) -> Result<(), CoreError> {
    let repo = Repository::open(repo_path).map_err(|e| CoreError::GitLocalError(e.to_string()))?;
    let refname = format!("refs/heads/{branch_name}");
    let obj = repo
        .revparse_single(&refname)
        .map_err(|e| CoreError::GitLocalError(e.to_string()))?;

    let mut checkout_opts = CheckoutBuilder::new();
    checkout_opts.safe();

    repo.checkout_tree(&obj, Some(&mut checkout_opts))
        .map_err(|e| CoreError::GitLocalError(e.to_string()))?;

    repo.set_head(&refname)
        .map_err(|e| CoreError::GitLocalError(e.to_string()))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Repository, Signature};
    use panguyuban_core::error::CoreError;
    use std::fs;
    use tempfile::TempDir;

    fn init_repo_with_commit() -> (TempDir, Repository) {
        let dir = TempDir::new().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        let file_path = dir.path().join("README.md");
        fs::write(&file_path, "initial content\n").unwrap();

        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("README.md")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let sig = Signature::now("Ansar", "ansar@example.com").unwrap();
        {
            let tree = repo.find_tree(tree_id).unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "Initial commit", &tree, &[])
                .unwrap();
        }
        (dir, repo)
    }

    #[test]
    fn creates_and_checks_out_new_branch_cleanly() {
        let (dir, repo) = init_repo_with_commit();
        create_and_checkout_branch_in_repo(dir.path(), "feat/pan-149-rate-limit").unwrap();
        let head = repo.head().unwrap();
        assert_eq!(head.shorthand(), Some("feat/pan-149-rate-limit"));
    }

    #[test]
    fn rejects_branch_switch_when_dirty_working_tree_conflicts() {
        let (dir, repo) = init_repo_with_commit();
        let default_branch = repo.head().unwrap().shorthand().unwrap().to_string();

        create_and_checkout_branch_in_repo(dir.path(), "feat/pan-142-jwt").unwrap();
        let file_path = dir.path().join("README.md");
        fs::write(&file_path, "committed on feature branch\n").unwrap();
        {
            let mut index = repo.index().unwrap();
            index.add_path(std::path::Path::new("README.md")).unwrap();
            index.write().unwrap();
            let tree_id = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            let parent = repo.head().unwrap().peel_to_commit().unwrap();
            let sig = Signature::now("Ansar", "ansar@example.com").unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "Update README", &tree, &[&parent])
                .unwrap();
        }

        // Dirty README.md in the working tree so switching back to default_branch conflicts
        fs::write(&file_path, "uncommitted local modification\n").unwrap();
        let err = checkout_existing_branch_in_repo(dir.path(), &default_branch).unwrap_err();
        assert!(matches!(err, CoreError::GitLocalError(_)));
    }
}
