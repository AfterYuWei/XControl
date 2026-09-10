import Tauri
import UIKit
import WebKit
import Network

final class StartArgs: Decodable {
    let activeSessions: Int
    let durationSeconds: UInt64
}

final class SessionKeepalivePlugin: Plugin {
    private var taskIdentifier: UIBackgroundTaskIdentifier = .invalid
    private let networkMonitor = NWPathMonitor()
    private let networkQueue = DispatchQueue(label: "com.yuweinfo.eizhu.network")
    private var networkGeneration: UInt64 = 0
    private var networkSignature = ""
    private var networkState = "unknown"

    override init() {
        super.init()
        networkMonitor.pathUpdateHandler = { [weak self] path in
            self?.publishNetwork(path)
        }
        networkMonitor.start(queue: networkQueue)
    }

    deinit {
        networkMonitor.cancel()
    }

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

    @objc func status(_ invoke: Invoke) {
        let remaining = UIApplication.shared.backgroundTimeRemaining
        var response: [String: Any] = [
            "running": taskIdentifier != .invalid,
            "notificationPermission": true,
            "networkGeneration": networkGeneration,
            "networkState": networkState,
        ]
        if remaining.isFinite && remaining < Double.greatestFiniteMagnitude {
            response["backgroundTimeRemainingSeconds"] = UInt64(max(0, remaining))
        }
        invoke.resolve(response)
    }

    private func publishNetwork(_ path: NWPath) {
        let state = path.status == .satisfied ? "online" : "offline"
        let transports = [
            (NWInterface.InterfaceType.wifi, "wifi"),
            (.cellular, "cellular"),
            (.wiredEthernet, "ethernet"),
            (.other, "other"),
        ].filter { path.usesInterfaceType($0.0) }.map(\.1).joined(separator: "+")
        let signature = "\(state):\(transports)"
        guard signature != networkSignature else { return }
        networkSignature = signature
        networkState = state
        networkGeneration += 1
        DispatchQueue.main.async {
            self.trigger("network-change", data: [
                "online": state == "online",
                "generation": self.networkGeneration,
                "transport": transports,
            ])
        }
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
