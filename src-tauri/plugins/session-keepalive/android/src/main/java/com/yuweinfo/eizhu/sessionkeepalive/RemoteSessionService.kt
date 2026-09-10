package com.yuweinfo.eizhu.sessionkeepalive

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat

class RemoteSessionService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private val timeout = Runnable { stopSelf() }

    override fun onCreate() {
        super.onCreate()
        running = true
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "远程会话",
                    NotificationManager.IMPORTANCE_LOW,
                ).apply { description = "在限定时间内保持 SSH 与 SFTP 会话" },
            )
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP || intent?.action == ACTION_DISCONNECT_ALL) {
            if (intent.action == ACTION_DISCONNECT_ALL) {
                sendBroadcast(Intent(ACTION_DISCONNECT_REQUESTED).setPackage(packageName))
            }
            stopSelf()
            return START_NOT_STICKY
        }

        val count = intent?.getIntExtra(EXTRA_SESSION_COUNT, 0) ?: 0
        val duration = intent?.getLongExtra(EXTRA_DURATION_SECONDS, 360) ?: 360
        val stopIntent = Intent(this, RemoteSessionService::class.java).apply {
            action = ACTION_DISCONNECT_ALL
        }
        val stopAction = PendingIntent.getService(
            this,
            1,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_warning)
            .setContentTitle("eizhu 正在保持 $count 个远程会话")
            .setContentText("后台恢复窗口最长 6 分钟")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .addAction(0, "断开全部会话", stopAction)
            .build()
        startForeground(NOTIFICATION_ID, notification)
        handler.removeCallbacks(timeout)
        handler.postDelayed(timeout, duration.coerceAtMost(360) * 1_000)
        return START_NOT_STICKY
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        stopSelf(startId)
    }

    override fun onDestroy() {
        running = false
        handler.removeCallbacks(timeout)
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        @Volatile
        var running: Boolean = false
            private set
        const val ACTION_START = "com.yuweinfo.eizhu.sessionkeepalive.START"
        const val ACTION_STOP = "com.yuweinfo.eizhu.sessionkeepalive.STOP"
        const val ACTION_DISCONNECT_ALL = "com.yuweinfo.eizhu.sessionkeepalive.DISCONNECT_ALL"
        const val ACTION_DISCONNECT_REQUESTED =
            "com.yuweinfo.eizhu.sessionkeepalive.DISCONNECT_REQUESTED"
        const val EXTRA_SESSION_COUNT = "active_session_count"
        const val EXTRA_DURATION_SECONDS = "duration_seconds"
        private const val CHANNEL_ID = "eizhu_remote_sessions"
        private const val NOTIFICATION_ID = 360
    }
}
