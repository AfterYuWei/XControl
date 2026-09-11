// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "tauri-plugin-master-key-store",
    platforms: [.iOS(.v15)],
    products: [.library(name: "tauri-plugin-master-key-store", type: .static, targets: ["tauri-plugin-master-key-store"])],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
    targets: [.target(name: "tauri-plugin-master-key-store", dependencies: [.byName(name: "Tauri")], path: "Sources")]
)
