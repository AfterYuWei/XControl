package com.yuweinfo.eizhu.documentgateway

import android.app.Activity
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.util.UUID

@InvokeArg
class PickArgs {
    lateinit var stagingDir: String
    var multiple: Boolean = false
    var mimeTypes: Array<String> = emptyArray()
}

@InvokeArg
class ExportArgs {
    lateinit var sourcePath: String
    lateinit var suggestedName: String
    var mimeType: String = "application/octet-stream"
}

@TauriPlugin
class DocumentGatewayPlugin(private val activity: Activity) : Plugin(activity) {
    private var pickArgs: PickArgs? = null
    private var exportArgs: ExportArgs? = null

    @Command
    fun pick(invoke: Invoke) {
        val args = invoke.parseArgs(PickArgs::class.java)
        pickArgs = args
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = if (args.mimeTypes.size == 1) args.mimeTypes[0] else "*/*"
            if (args.mimeTypes.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, args.mimeTypes)
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, args.multiple)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        }
        startActivityForResult(invoke, intent, "pickResult")
    }

    @ActivityCallback
    fun pickResult(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode == Activity.RESULT_CANCELED) {
            pickArgs = null
            invoke.resolve(JSObject().apply { put("documents", JSArray()) })
            return
        }
        if (result.resultCode != Activity.RESULT_OK || pickArgs == null) {
            pickArgs = null
            invoke.reject("无法读取系统文件选择结果")
            return
        }
        try {
            val data = result.data
            val uris = mutableListOf<Uri>()
            data?.data?.let(uris::add)
            data?.clipData?.let { clip ->
                for (index in 0 until clip.itemCount) uris.add(clip.getItemAt(index).uri)
            }
            val targetDir = File(pickArgs!!.stagingDir).apply { mkdirs() }
            val documents = JSArray()
            for (uri in uris.distinct()) {
                val displayName = queryName(uri) ?: "document-${UUID.randomUUID()}"
                val safeName = displayName.replace(Regex("[\\\\/]"), "_")
                val target = File(targetDir, "${UUID.randomUUID()}-$safeName")
                activity.contentResolver.openInputStream(uri).use { input ->
                    requireNotNull(input) { "无法打开所选文件" }
                    target.outputStream().use { output -> input.copyTo(output) }
                }
                documents.put(JSObject().apply {
                    put("path", target.absolutePath)
                    put("name", safeName)
                    put("size", target.length())
                })
            }
            invoke.resolve(JSObject().apply { put("documents", documents) })
        } catch (error: Exception) {
            invoke.reject(error.message ?: "复制所选文件失败")
        } finally {
            pickArgs = null
        }
    }

    @Command
    fun export(invoke: Invoke) {
        val args = invoke.parseArgs(ExportArgs::class.java)
        exportArgs = args
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = args.mimeType
            putExtra(Intent.EXTRA_TITLE, args.suggestedName)
            addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        }
        startActivityForResult(invoke, intent, "exportResult")
    }

    @ActivityCallback
    fun exportResult(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode == Activity.RESULT_CANCELED) {
            exportArgs = null
            invoke.resolve(JSObject().apply { put("saved", false) })
            return
        }
        val args = exportArgs
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || args == null || uri == null) {
            exportArgs = null
            invoke.reject("无法读取系统保存位置")
            return
        }
        try {
            File(args.sourcePath).inputStream().use { input ->
                activity.contentResolver.openOutputStream(uri, "wt").use { output ->
                    requireNotNull(output) { "无法打开系统保存位置" }
                    input.copyTo(output)
                }
            }
            invoke.resolve(JSObject().apply {
                put("saved", true)
                put("destination", uri.toString())
            })
        } catch (error: Exception) {
            invoke.reject(error.message ?: "保存文件失败")
        } finally {
            exportArgs = null
        }
    }

    private fun queryName(uri: Uri): String? {
        var cursor: Cursor? = null
        return try {
            cursor = activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            if (cursor != null && cursor.moveToFirst()) cursor.getString(0) else null
        } finally {
            cursor?.close()
        }
    }
}
