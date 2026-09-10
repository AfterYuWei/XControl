fn main() {
    println!("cargo:rerun-if-env-changed=EIZHU_BUILD_CHANNEL");
    println!("cargo:rerun-if-changed=../VERSION");

    let version = std::fs::read_to_string("../VERSION")
        .expect("failed to read the root VERSION file")
        .trim()
        .to_owned();
    let valid = version.split('.').count() == 3
        && version
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()));
    assert!(valid, "VERSION must be a stable x.y.z semantic version");
    assert_eq!(
        version,
        env!("CARGO_PKG_VERSION"),
        "Cargo.toml package.version must mirror the root VERSION file"
    );
    println!("cargo:rustc-env=EIZHU_APP_VERSION={version}");

    tauri_build::build()
}
