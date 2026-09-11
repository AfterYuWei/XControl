// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "tauri-plugin-system-insets",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "tauri-plugin-system-insets",
            type: .static,
            targets: ["tauri-plugin-system-insets"]
        )
    ],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
    targets: [
        .target(
            name: "tauri-plugin-system-insets",
            dependencies: [.byName(name: "Tauri")],
            path: "Sources"
        )
    ]
)
