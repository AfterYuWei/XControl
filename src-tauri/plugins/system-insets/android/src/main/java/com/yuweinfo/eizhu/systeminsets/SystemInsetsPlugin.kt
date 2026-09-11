package com.yuweinfo.eizhu.systeminsets

import android.app.Activity
import android.os.Build
import android.view.View
import android.view.WindowInsets
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * 读取状态栏/导航栏/刘海安全区内边距并推送到 WebView。
 * Android WebView（Chromium < 140）的 env(safe-area-inset-*) 恒为 0，
 * 前端 --safe-inset-* CSS 变量依赖本插件提供数值。
 */
class SystemInsetsPlugin(private val activity: Activity) : Plugin(activity) {
    private var lastSignature = ""
    private var latest: WindowInsets? = null

    @Command
    fun get(invoke: Invoke) {
        invoke.resolve(currentPayload())
    }

    override fun load(webView: WebView) {
        // WebView 能收到 View 层分发的真实 insets（Chromium bug 只影响 CSS env()），
        // 缓存最新值并推送给前端
        webView.setOnApplyWindowInsetsListener { view, insets ->
            latest = insets
            publish(insets)
            insets
        }
        webView.post {
            webView.requestApplyInsets()
            activity.window?.decorView?.requestApplyInsets()
        }
    }

    /** 优先用 WebView 实际收到的 insets，尚未分发时退回 decorView。 */
    private fun currentPayload(): JSObject {
        val insets = latest
            ?: activity.window?.decorView?.rootWindowInsets
            ?: return zeros()
        return toPayload(insetValues(insets))
    }

    private fun publish(insets: WindowInsets) {
        val payload = toPayload(insetValues(insets))
        val signature = "${payload["top"]},${payload["bottom"]},${payload["left"]},${payload["right"]}"
        if (signature == lastSignature) return
        lastSignature = signature
        trigger("system-insets-changed", payload)
    }

    private fun insetValues(insets: WindowInsets): IntArray =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val types = WindowInsets.Type.statusBars() or
                WindowInsets.Type.navigationBars() or
                WindowInsets.Type.displayCutout()
            val bars = insets.getInsets(types)
            intArrayOf(bars.left, bars.top, bars.right, bars.bottom)
        } else {
            @Suppress("DEPRECATION")
            intArrayOf(
                insets.systemWindowInsetLeft,
                insets.systemWindowInsetTop,
                insets.systemWindowInsetRight,
                insets.systemWindowInsetBottom,
            )
        }

    private fun toPayload(values: IntArray): JSObject {
        val density = activity.resources.displayMetrics.density
        return JSObject().apply {
            put("top", values[1] / density)
            put("bottom", values[3] / density)
            put("left", values[0] / density)
            put("right", values[2] / density)
        }
    }

    private fun zeros(): JSObject = JSObject().apply {
        put("top", 0.0)
        put("bottom", 0.0)
        put("left", 0.0)
        put("right", 0.0)
    }
}
