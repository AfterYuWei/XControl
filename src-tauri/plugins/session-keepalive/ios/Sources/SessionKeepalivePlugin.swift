import Tauri
import UIKit
import WebKit

final class StartArgs: Decodable {
    let activeSessions: Int
    let durationSeconds: UInt64
}

final class SessionKeepalivePlugin: Plugin {
    private var taskIdentifier: UIBackgroundTaskIdentifier = .invalid

    @objc func start(_ invoke: Invoke) throws {
        _ = try invoke.parseArgs(StartArgs.self)
        endCurrentTask()
        taskIdentifier = UIApplication.shared.beginBackgroundTask(withName: "eizhu-ssh-window") {
            self.trigger("expired", data: ["reason": "system-expiration"])
            self.endCurrentTask()
        }
        invoke.resolve([
            "started": taskIdentifier != .invalid,
            "notificationPermission": true,
        ])
    }

    @objc func stop(_ invoke: Invoke) {
        endCurrentTask()
        invoke.resolve()
    }

    private func endCurrentTask() {
        guard taskIdentifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(taskIdentifier)
        taskIdentifier = .invalid
    }
}

@_cdecl("init_plugin_session_keepalive")
func initPlugin() -> Plugin {
    SessionKeepalivePlugin()
}
