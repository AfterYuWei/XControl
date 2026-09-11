import Tauri
import UIKit
import UniformTypeIdentifiers
import WebKit

struct PickArgs: Decodable {
    let stagingDir: String
    let multiple: Bool
    let mimeTypes: [String]
}

struct ExportArgs: Decodable {
    let sourcePath: String
    let suggestedName: String
    let mimeType: String
}

final class DocumentGatewayPlugin: Plugin, UIDocumentPickerDelegate {
    private var pendingInvoke: Invoke?
    private var stagingDirectory: URL?
    private var exportCopy: URL?
    private var exporting = false

    @objc func pick(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(PickArgs.self)
        pendingInvoke = invoke
        exporting = false
        stagingDirectory = URL(fileURLWithPath: args.stagingDir, isDirectory: true)
        try FileManager.default.createDirectory(at: stagingDirectory!, withIntermediateDirectories: true)
        let types = args.mimeTypes.compactMap { UTType(mimeType: $0) }
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: types.isEmpty ? [.item] : types, asCopy: false)
        picker.allowsMultipleSelection = args.multiple
        picker.delegate = self
        picker.modalPresentationStyle = .fullScreen
        manager.viewController?.present(picker, animated: true)
    }

    @objc func export(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(ExportArgs.self)
        pendingInvoke = invoke
        exporting = true
        let source = URL(fileURLWithPath: args.sourcePath)
        let renamed = source.deletingLastPathComponent().appendingPathComponent(args.suggestedName)
        if source != renamed {
            try? FileManager.default.removeItem(at: renamed)
            try FileManager.default.copyItem(at: source, to: renamed)
            exportCopy = renamed
        } else {
            exportCopy = nil
        }
        let picker = UIDocumentPickerViewController(forExporting: [renamed], asCopy: true)
        picker.delegate = self
        picker.modalPresentationStyle = .fullScreen
        manager.viewController?.present(picker, animated: true)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let invoke = pendingInvoke else { return }
        defer {
            pendingInvoke = nil
            cleanupExportCopy()
        }
        if exporting {
            invoke.resolve(["saved": true, "destination": urls.first?.absoluteString ?? ""])
            return
        }
        do {
            guard let directory = stagingDirectory else { throw NSError(domain: "DocumentGateway", code: 1) }
            let documents: [[String: Any]] = try urls.map { source in
                let scoped = source.startAccessingSecurityScopedResource()
                defer { if scoped { source.stopAccessingSecurityScopedResource() } }
                let safeName = source.lastPathComponent.replacingOccurrences(of: "/", with: "_")
                let target = directory.appendingPathComponent("\(UUID().uuidString)-\(safeName)")
                try? FileManager.default.removeItem(at: target)
                try FileManager.default.copyItem(at: source, to: target)
                let size = (try FileManager.default.attributesOfItem(atPath: target.path)[.size] as? NSNumber)?.uint64Value ?? 0
                return ["path": target.path, "name": safeName, "size": size]
            }
            invoke.resolve(["documents": documents])
        } catch {
            invoke.reject("复制所选文件失败：\(error.localizedDescription)")
        }
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        if exporting { pendingInvoke?.resolve(["saved": false]) }
        else { pendingInvoke?.resolve(["documents": []]) }
        pendingInvoke = nil
        cleanupExportCopy()
    }

    private func cleanupExportCopy() {
        if let copy = exportCopy {
            try? FileManager.default.removeItem(at: copy)
        }
        exportCopy = nil
    }
}

@_cdecl("init_plugin_document_gateway")
func initPlugin() -> Plugin { DocumentGatewayPlugin() }
