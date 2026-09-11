import Tauri
import Foundation
import UIKit

final class SystemInsetsPlugin: Plugin {
    @objc func get(_ invoke: Invoke) {
        DispatchQueue.main.async {
            invoke.resolve(Self.currentInsets())
        }
    }

    private static func currentInsets() -> [String: Double] {
        guard let scene = UIApplication.shared.connectedScenes.first(where: {
            $0.activationState == .foregroundActive
        }) as? UIWindowScene else {
            return ["top": 0, "bottom": 0, "left": 0, "right": 0]
        }
        let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first
        guard let window else {
            return ["top": 0, "bottom": 0, "left": 0, "right": 0]
        }
        return [
            "top": Double(window.safeAreaInsets.top),
            "bottom": Double(window.safeAreaInsets.bottom),
            "left": Double(window.safeAreaInsets.left),
            "right": Double(window.safeAreaInsets.right),
        ]
    }
}

@_cdecl("init_plugin_system_insets")
func initPlugin() -> Plugin {
    SystemInsetsPlugin()
}
