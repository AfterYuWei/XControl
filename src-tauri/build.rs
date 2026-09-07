fn main() {
    println!("cargo:rerun-if-env-changed=XCONTROL_BUILD_CHANNEL");
    tauri_build::build()
}
