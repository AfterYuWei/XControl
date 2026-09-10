fn main() {
    println!("cargo:rerun-if-env-changed=EIZHU_BUILD_CHANNEL");
    tauri_build::build()
}
