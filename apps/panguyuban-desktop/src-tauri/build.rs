fn main() {
    // externalBin needs binaries/pangu-<triple> to exist even for plain cargo builds and tests;
    // scripts/build-pangu.sh stages the real one. Never overwrite an existing file.
    let triple = std::env::var("TARGET").unwrap();
    let path = std::path::Path::new("binaries").join(format!("pangu-{triple}"));
    if !path.exists() {
        std::fs::create_dir_all("binaries").unwrap();
        std::fs::write(&path, "#!/bin/sh\necho 'pangu was not built; run scripts/build-pangu.sh' >&2\nexit 1\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    println!("cargo:rerun-if-changed=binaries");
    tauri_build::build()
}
