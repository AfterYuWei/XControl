package com.yuweinfo.eizhu.masterkeystore

import android.app.Activity
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class StoreArgs {
    lateinit var value: String
}

@TauriPlugin
class MasterKeyStorePlugin(private val activity: Activity) : Plugin(activity) {
    private val preferences by lazy {
        activity.getSharedPreferences(PREFERENCES, Activity.MODE_PRIVATE)
    }

    @Command
    fun load(invoke: Invoke) {
        try {
            val wrapped = preferences.getString(WRAPPED_KEY, null)
            val response = JSObject()
            if (wrapped != null) response.put("value", decrypt(wrapped))
            invoke.resolve(response)
        } catch (error: Exception) {
            invoke.reject(error.message ?: "读取 Android Keystore 主密钥失败")
        }
    }

    @Command
    fun store(invoke: Invoke) {
        try {
            val value = invoke.parseArgs(StoreArgs::class.java).value
            val existing = preferences.getString(WRAPPED_KEY, null)
            if (existing != null) {
                require(decrypt(existing) == value) { "安全存储中已存在不同的主密钥" }
                invoke.resolve()
                return
            }
            val committed = preferences.edit().putString(WRAPPED_KEY, encrypt(value)).commit()
            require(committed) { "写入安全存储失败" }
            require(preferences.getString(WRAPPED_KEY, null)?.let(::decrypt) == value) {
                "安全存储写入校验失败"
            }
            invoke.resolve()
        } catch (error: Exception) {
            invoke.reject(error.message ?: "写入 Android Keystore 主密钥失败")
        }
    }

    private fun wrappingKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, wrappingKey())
        val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        val payload = cipher.iv + encrypted
        return Base64.encodeToString(payload, Base64.NO_WRAP)
    }

    private fun decrypt(encoded: String): String {
        val payload = Base64.decode(encoded, Base64.NO_WRAP)
        require(payload.size > IV_BYTES) { "安全存储数据损坏" }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(
            Cipher.DECRYPT_MODE,
            wrappingKey(),
            GCMParameterSpec(128, payload.copyOfRange(0, IV_BYTES)),
        )
        return String(cipher.doFinal(payload.copyOfRange(IV_BYTES, payload.size)), Charsets.UTF_8)
    }

    companion object {
        private const val PREFERENCES = "eizhu_master_key_store"
        private const val WRAPPED_KEY = "wrapped_master_key"
        private const val KEY_ALIAS = "eizhu.master-key.wrapping.v1"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_BYTES = 12
    }
}
