package com.yuweinfo.eizhu.systeminsets

import android.app.Activity
import android.os.Build
import android.util.Log
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
 *
 * 读取优先级：WebView 实际收到的 insets → decorView rootWindowInsets →
 * 框架 status_bar_height / navigation_bar_height 尺寸兜底（不依赖 insets 分发，
 * 在厂商 ROM 上也能拿到状态栏高度）。
 */
class SystemInsetsPlugin(private val activity: Activity) : Plugin(activity) {
    private var lastSignature = ""
    private var latest: WindowInsets? = null

    @Command
    fun get(invoke: Invoke) {
        val payload = currentPayload()
        Log.d(
            TAG,
            "get -> top=${payload["top"]} bottom=${payload["bottom"]} " +
                "left=${payload["left"]} right=${payload["right"]} " +
                "source=${if (latest != null) "webview" else "decor"}"
        )
        invoke.resolve(payload)
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

    /** 依次尝试 WebView insets、decorView insets、框架尺寸兜底。 */
    private fun currentPayload(): JSObject {
        val insets = latest
            ?: activity.window?.decorView?.rootWindowInsets
        val values = if (insets != null) insetValues(insets) else intArrayOf(0, 0, 0, 0)
        if (values[1] <= 0) values[1] = frameworkDimen("status_bar_height")
        if (values[3] <= 0) values[3] = frameworkDimen("navigation_bar_height")
        return toPayload(values, if (insets != null) imeValue(insets) else 0)
    }

    private fun publish(insets: WindowInsets) {
        val payload = toPayload(insetValues(insets), imeValue(insets))
        val signature = "${payload["top"]},${payload["bottom"]},${payload["left"]},${payload["right"]},${payload["ime"]}"
        if (signature == lastSignature) return
        lastSignature = signature
        Log.d(TAG, "changed -> $signature")
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

    /**
     * IME（软键盘）可见高度，CSS 像素。软键盘弹出/收起都会触发 insets 重分发，
     * WebView 视口不一定收缩（adjustPan），因此键盘检测以原生 insets 为准。
     */
    private fun imeValue(insets: WindowInsets): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            insets.getInsets(WindowInsets.Type.ime()).bottom
        } else {
            @Suppress("DEPRECATION")
            val legacyBottom = insets.systemWindowInsetBottom
            val nav = frameworkDimen("navigation_bar_height")
            maxOf(0, legacyBottom - nav)
        }

    /** 读取框架系统尺寸（如 status_bar_height），厂商 ROM 上普遍可用。 */
    private fun frameworkDimen(name: String): Int {
        val id = activity.resources.getIdentifier(name, "dimen", "android")
        if (id <= 0) return 0
        return try {
            activity.resources.getDimensionPixelSize(id)
        } catch (error: Exception) {
            0
        }
    }

    private fun toPayload(values: IntArray, ime: Int): JSObject {
        val density = activity.resources.displayMetrics.density
        return JSObject().apply {
            put("top", values[1] / density)
            put("bottom", values[3] / density)
            put("left", values[0] / density)
            put("right", values[2] / density)
            put("ime", ime / density)
        }
    }

    private fun zeros(): JSObject = JSObject().apply {
        put("top", 0.0)
        put("bottom", 0.0)
        put("left", 0.0)
        put("right", 0.0)
        put("ime", 0.0)
    }

    companion object {
        private const val TAG = "EizhuInsets"
    }
}
