import Security
import Tauri
import WebKit

struct StoreArgs: Decodable {
    let value: String
}

final class MasterKeyStorePlugin: Plugin {
    @objc func load(_ invoke: Invoke) {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            invoke.resolve([String: Any]())
            return
        }
        guard status == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            invoke.reject("读取 iOS Keychain 主密钥失败（\(status)）")
            return
        }
        invoke.resolve(["value": value])
    }

    @objc func store(_ invoke: Invoke) throws {
        let value = try invoke.parseArgs(StoreArgs.self).value
        let data = Data(value.utf8)
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let existingStatus = SecItemCopyMatching(query as CFDictionary, &result)
        if existingStatus == errSecSuccess {
            guard result as? Data == data else {
                invoke.reject("安全存储中已存在不同的主密钥")
                return
            }
            invoke.resolve()
            return
        }
        guard existingStatus == errSecItemNotFound else {
            invoke.reject("检查 iOS Keychain 主密钥失败（\(existingStatus)）")
            return
        }
        var insert = baseQuery()
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(insert as CFDictionary, nil)
        guard status == errSecSuccess else {
            invoke.reject("写入 iOS Keychain 主密钥失败（\(status)）")
            return
        }
        invoke.resolve()
    }

    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.yuweinfo.eizhu.master-key",
            kSecAttrAccount as String: "default",
        ]
    }
}

@_cdecl("init_plugin_master_key_store")
func initPlugin() -> Plugin { MasterKeyStorePlugin() }
