package com.yuweinfo.eizhu.sessionkeepalive

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import android.content.pm.PackageManager
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
    private val disconnectReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == RemoteSessionService.ACTION_DISCONNECT_REQUESTED) {
                trigger("disconnect-all", JSObject().apply { put("source", "notification") })
            }
        }
    }

    init {
        ContextCompat.registerReceiver(
            activity,
            disconnectReceiver,
            IntentFilter(RemoteSessionService.ACTION_DISCONNECT_REQUESTED),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
    }

    override fun onDestroy() {
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
        }
        invoke.resolve(JSObject().apply {
            put("started", true)
            put("notificationPermission", notificationPermission)
        })
    }

    @Command
    fun stop(invoke: Invoke) {
        activity.stopService(Intent(activity, RemoteSessionService::class.java))
        invoke.resolve()
    }

    companion object {
        private const val NOTIFICATION_PERMISSION_REQUEST = 360
    }
}
