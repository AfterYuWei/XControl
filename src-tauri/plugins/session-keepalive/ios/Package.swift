// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "tauri-plugin-session-keepalive",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "tauri-plugin-session-keepalive",
            type: .static,
            targets: ["tauri-plugin-session-keepalive"]
        )
    ],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
    targets: [
        .target(
            name: "tauri-plugin-session-keepalive",
            dependencies: [.byName(name: "Tauri")],
            path: "Sources"
        )
    ]
)
