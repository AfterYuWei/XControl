import Tauri
import Foundation
import UIKit
import WebKit
import Network

final class StartArgs: Decodable {
    let activeSessions: Int
    let durationSeconds: UInt64
}

final class SessionKeepalivePlugin: Plugin {
    private var taskIdentifier: UIBackgroundTaskIdentifier = .invalid
    private var logicalExpiration: DispatchWorkItem?
    private let networkMonitor = NWPathMonitor()
    private let networkQueue = DispatchQueue(label: "com.yuweinfo.eizhu.network")
    private let networkLock = NSLock()
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
        let args = try invoke.parseArgs(StartArgs.self)
        endCurrentTask()
        taskIdentifier = UIApplication.shared.beginBackgroundTask(withName: "eizhu-ssh-window") {
            self.trigger("expired", data: ["reason": "system-expiration"])
            self.endCurrentTask()
        }
        let expiration = DispatchWorkItem { [weak self] in
            guard let self, self.taskIdentifier != .invalid else { return }
            self.trigger("expired", data: ["reason": "logic-window"])
            self.endCurrentTask()
        }
        logicalExpiration = expiration
        DispatchQueue.main.asyncAfter(
            deadline: .now() + Double(min(args.durationSeconds, 360)),
            execute: expiration
        )
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
        networkLock.lock()
        let generation = networkGeneration
        let state = networkState
        networkLock.unlock()
        var response: [String: Any] = [
            "running": taskIdentifier != .invalid,
            "notificationPermission": true,
            "networkGeneration": generation,
            "networkState": state,
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
        networkLock.lock()
        guard signature != networkSignature else {
            networkLock.unlock()
            return
        }
        networkSignature = signature
        networkState = state
        networkGeneration += 1
        let generation = networkGeneration
        networkLock.unlock()
        DispatchQueue.main.async {
            self.trigger("network-change", data: [
                "online": state == "online",
                "generation": generation,
                "transport": transports,
            ])
        }
    }

    private func endCurrentTask() {
        logicalExpiration?.cancel()
        logicalExpiration = nil
        guard taskIdentifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(taskIdentifier)
        taskIdentifier = .invalid
    }
}

@_cdecl("init_plugin_session_keepalive")
func initPlugin() -> Plugin {
    SessionKeepalivePlugin()
}
