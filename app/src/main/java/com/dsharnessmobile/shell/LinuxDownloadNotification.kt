package com.dsharnessmobile.shell

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent

internal object LinuxDownloadNotification {
  private const val CHANNEL = "linux-environment-download"
  private const val ID = 1506

  fun show(stage: String?, bytes: Long, size: Long) {
    val app = ShellAppContext.get() ?: return
    val manager = app.getSystemService(NotificationManager::class.java)
    if (stage == null) {
      manager.cancel(ID)
      return
    }
    if (!manager.areNotificationsEnabled()) return
    val title = UiText.t(app, "Linux 环境", "Linux environment")
    manager.createNotificationChannel(NotificationChannel(CHANNEL, title, NotificationManager.IMPORTANCE_LOW))
    val message = when (stage) {
      "paused" -> UiText.t(app, "下载已暂停", "Download paused")
      "verifying" -> UiText.t(app, "正在校验", "Verifying")
      "extracting" -> UiText.t(app, "正在解压", "Extracting")
      "installing" -> UiText.t(app, "正在安装", "Installing")
      else -> UiText.t(app, "正在下载", "Downloading")
    }
    val content = PendingIntent.getActivity(app, ID, Intent(app, MainActivity::class.java),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val percent = if (size > 0) ((bytes * 100) / size).coerceIn(0, 100).toInt() else 0
    val notification = Notification.Builder(app, CHANNEL)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle(title)
      .setContentText(message)
      .setOngoing(stage != "paused")
      .setOnlyAlertOnce(true)
      .setContentIntent(content)
      .setProgress(100, percent, stage != "downloading")
      .build()
    try { manager.notify(ID, notification) } catch (_: SecurityException) { }
  }
}
