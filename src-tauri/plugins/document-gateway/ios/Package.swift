// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "tauri-plugin-document-gateway",
    platforms: [.iOS(.v15)],
    products: [.library(name: "tauri-plugin-document-gateway", type: .static, targets: ["tauri-plugin-document-gateway"])],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
    targets: [.target(name: "tauri-plugin-document-gateway", dependencies: [.byName(name: "Tauri")], path: "Sources")]
)
