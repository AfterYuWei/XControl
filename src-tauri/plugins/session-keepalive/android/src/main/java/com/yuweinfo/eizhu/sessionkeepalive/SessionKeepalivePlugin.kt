package com.yuweinfo.eizhu.sessionkeepalive

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class StartArgs {
    var activeSessions: Int = 0
    var durationSeconds: Long = 360
}

@TauriPlugin(permissions = [Manifest.permission.POST_NOTIFICATIONS])
class SessionKeepalivePlugin(private val activity: Activity) : Plugin(activity) {
    private val connectivity = activity.getSystemService(ConnectivityManager::class.java)
    private var networkGeneration = 0L
    private var networkSignature = ""
    private var networkState = "unknown"
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = publishNetworkState()
        override fun onLost(network: Network) = publishNetworkState()
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) =
            publishNetworkState()
    }
    private val disconnectReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                RemoteSessionService.ACTION_DISCONNECT_REQUESTED ->
                    trigger("disconnect-all", JSObject().apply { put("source", "notification") })
                RemoteSessionService.ACTION_WINDOW_EXPIRED ->
                    trigger("expired", JSObject().apply { put("reason", "logic-window") })
            }
        }
    }

    init {
        ContextCompat.registerReceiver(
            activity,
            disconnectReceiver,
            IntentFilter().apply {
                addAction(RemoteSessionService.ACTION_DISCONNECT_REQUESTED)
                addAction(RemoteSessionService.ACTION_WINDOW_EXPIRED)
            },
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        connectivity.registerDefaultNetworkCallback(networkCallback)
        publishNetworkState()
    }

    override fun onDestroy() {
        connectivity.unregisterNetworkCallback(networkCallback)
        activity.unregisterReceiver(disconnectReceiver)
    }

    @Command
    fun start(invoke: Invoke) {
        val args = invoke.parseArgs(StartArgs::class.java)
        val intent = Intent(activity, RemoteSessionService::class.java).apply {
            action = RemoteSessionService.ACTION_START
            putExtra(RemoteSessionService.EXTRA_SESSION_COUNT, args.activeSessions)
            putExtra(RemoteSessionService.EXTRA_DURATION_SECONDS, args.durationSeconds)
        }
        ContextCompat.startForegroundService(activity, intent)
        val notificationPermission =
            android.os.Build.VERSION.SDK_INT < 33 || ActivityCompat.checkSelfPermission(
                activity,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
        if (!notificationPermission && android.os.Build.VERSION.SDK_INT >= 33) {
            ActivityCompat.requestPermissions(
                activity,
                arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                NOTIFICATION_PERMISSION_REQUEST,
            )
            trigger("notification-limited", JSObject().apply {
                put("message", "未授予通知权限，Android 后台会话保活可能受限")
            })
        }
        val networkSnapshot = synchronized(this) { networkGeneration to networkState }
        invoke.resolve(JSObject().apply {
            put("started", true)
            put("notificationPermission", notificationPermission)
            put("networkGeneration", networkSnapshot.first)
            put("networkState", networkSnapshot.second)
        })
    }

    private fun publishNetworkState() {
        val capabilities = connectivity.getNetworkCapabilities(connectivity.activeNetwork)
        val online = capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
        val transports = listOf(
            NetworkCapabilities.TRANSPORT_WIFI to "wifi",
            NetworkCapabilities.TRANSPORT_CELLULAR to "cellular",
            NetworkCapabilities.TRANSPORT_ETHERNET to "ethernet",
            NetworkCapabilities.TRANSPORT_VPN to "vpn",
        ).filter { capabilities?.hasTransport(it.first) == true }.joinToString("+") { it.second }
        val state = if (online) "online" else "offline"
        val signature = "$state:$transports"
        val generation = synchronized(this) {
            if (signature == networkSignature) return
            networkSignature = signature
            networkState = state
            networkGeneration += 1
            networkGeneration
        }
        activity.runOnUiThread {
            trigger("network-change", JSObject().apply {
                put("online", online)
                put("generation", generation)
                put("transport", transports)
            })
        }
    }

    @Command
    fun stop(invoke: Invoke) {
        activity.stopService(Intent(activity, RemoteSessionService::class.java))
        invoke.resolve()
    }

    @Command
    fun status(invoke: Invoke) {
        val notificationPermission =
            android.os.Build.VERSION.SDK_INT < 33 || ActivityCompat.checkSelfPermission(
                activity,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
        val networkSnapshot = synchronized(this) { networkGeneration to networkState }
        invoke.resolve(JSObject().apply {
            put("running", RemoteSessionService.running)
            put("notificationPermission", notificationPermission)
            put("networkGeneration", networkSnapshot.first)
            put("networkState", networkSnapshot.second)
        })
    }

    companion object {
        private const val NOTIFICATION_PERMISSION_REQUEST = 360
    }
}
