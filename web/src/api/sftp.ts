import { invoke } from '@tauri-apps/api/core'
import { invokeCommand, normalizeCommandError } from './tauri'
import type {
  SftpEntry,
  TransferTask,
  ConflictResolution,
  SftpCreateSessionResponse,
  SftpListResponse,
  SftpTreeResponse,
  SftpTransferResponse,
  SftpUploadResponse,
  SftpUploadBeginResponse,
  SftpDownloadResponse,
  SftpDeleteResponse,
  SftpFileReadResponse,
  SftpFileWriteRequest,
  SftpFileWriteResponse,
  DirectoryTransferMode,
  SftpMoveResponse,
} from '@/types/sftp'

const IPC_CHUNK_BYTES = 512 * 1024
const USE_BASE64_IPC = typeof navigator !== 'undefined'
  && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)

/** Rust SFTP session info. */
export interface SftpSessionInfo {
  id: string
  profile_id: string
  status: string
  error?: string
  home_dir?: string // User's home directory
  created_at: string
  host_key_fingerprint?: string
  known_host_key_fingerprint?: string
}

export const sftpApi = {
  // --- Session management ---

  createSession: (profileId: string) =>
    invokeCommand<SftpCreateSessionResponse>('sftp_create_session', { profileId }),

  getSession: (id: string) =>
    invokeCommand<SftpSessionInfo>('sftp_get_session', { id }),

  reconnectSession: (id: string) =>
    invokeCommand<SftpCreateSessionResponse>('sftp_reconnect_session', { id }),

  decideHostKey: (
    requestId: string,
    fingerprint: string,
    decision: 'trust_once' | 'trust_permanently' | 'reject',
  ) => invokeCommand<{ status: string; persisted?: boolean }>('sftp_host_key_decide', {
    requestId,
    fingerprint,
    decision,
  }),

  listSessions: () =>
    invokeCommand<SftpSessionInfo[]>('sftp_list_sessions'),

  closeSession: (id: string) =>
    invokeCommand<void>('sftp_close_session', { id }),

  // --- File operations ---

  list: (sessionId: string, path: string, showHidden = false) =>
    invokeCommand<SftpListResponse>('sftp_list', { sessionId, path, showHidden }),

  stat: (sessionId: string, path: string) =>
    invokeCommand<SftpEntry>('sftp_stat', { sessionId, path }),

  tree: (sessionId: string, path: string, depth = 3) =>
    invokeCommand<SftpTreeResponse>('sftp_tree', { sessionId, path, depth }),

  mkdir: (sessionId: string, path: string) =>
    invokeCommand<SftpEntry>('sftp_mkdir', { sessionId, path }),

  rename: (sessionId: string, oldPath: string, newPath: string) =>
    invokeCommand<SftpEntry>('sftp_rename', { sessionId, oldPath, newPath }),

  delete: (sessionId: string, paths: string[]) =>
    invokeCommand<SftpDeleteResponse>('sftp_delete', { sessionId, paths }),

  // --- Transfers ---

  /** Cross-session transfer: tries direct server-to-server copy first, falls
   *  back to backend relay if direct is not possible.
   *  If conflictResolution is "ask" (default) and the target has existing
   *  files, resolves with a `conflicts` array instead of starting a transfer.
   *  Pass "overwrite" | "rename" | "skip" to proceed without prompting. */
  transfer: async (
    sourceSessionId: string,
    targetSessionId: string,
    paths: string[],
    destDir: string,
    conflictResolution: ConflictResolution = 'ask',
    directoryMode: DirectoryTransferMode = 'archive',
  ): Promise<SftpTransferResponse> => {
    return invokeCommand<SftpTransferResponse>('sftp_transfer', {
        sourceSessionId,
        targetSessionId,
        paths,
        destDir,
        conflictResolution,
        directoryMode,
    })
  },

  move: async (
    sessionId: string,
    paths: string[],
    destDir: string,
    conflictResolution: ConflictResolution = 'ask',
  ): Promise<SftpMoveResponse> => {
    return invokeCommand<SftpMoveResponse>('sftp_move', {
      sessionId,
      paths,
      destDir,
      conflictResolution,
    })
  },

  /** Stream files through bounded raw IPC chunks. Each invoke completes only
   *  after Rust wrote the chunk, providing end-to-end backpressure. */
  upload: async (
    sessionId: string,
    files: File[],
    destDir: string,
    overwrite = false,
    onTasks?: (tasks: TransferTask[]) => void,
  ) => {
    const responses: SftpUploadResponse[] = []
    for (const file of files) {
      let uploadId: string | undefined
      try {
        const begin = await invokeCommand<SftpUploadBeginResponse>('sftp_upload_begin', {
          sessionId,
          name: file.name,
          destDir,
          overwrite,
          size: file.size,
        })
        uploadId = begin.upload_id
        onTasks?.(begin.tasks)
        const reader = file.stream().getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            for (let offset = 0; offset < value.byteLength; offset += IPC_CHUNK_BYTES) {
              const chunk = value.subarray(offset, offset + IPC_CHUNK_BYTES)
              if (USE_BASE64_IPC) {
                await invokeCommand('sftp_upload_chunk_base64', {
                  uploadId,
                  data: bytesToBase64(chunk),
                })
              } else {
                await invoke(
                  'sftp_upload_chunk',
                  chunk,
                  { headers: { 'x-eizhu-upload-id': uploadId } },
                )
              }
            }
          }
        } finally {
          reader.releaseLock()
        }
        responses.push(await invokeCommand<SftpUploadResponse>('sftp_upload_finish', { uploadId }))
      } catch (cause) {
        if (uploadId) {
          try {
            await invokeCommand<void>('sftp_upload_abort', { uploadId })
          } catch {
            // Preserve the original upload error.
          }
        }
        throw normalizeCommandError(cause)
      }
    }
    return { tasks: responses.flatMap((response) => response.tasks) }
  },

  /** Stage remote files in Rust without loading them into memory. */
  download: (sessionId: string, paths: string[]) =>
    invokeCommand<SftpDownloadResponse>('sftp_download', { sessionId, paths }),

  /** Pull a completed staged download as a backpressured byte stream. */
  streamDownloadFile: (taskId: string): ReadableStream<Uint8Array> => {
    let offset = 0
    let closed = false
    const close = async () => {
      if (closed) return
      closed = true
      await invokeCommand<void>('sftp_download_close', { taskId })
    }
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = USE_BASE64_IPC
            ? base64ToBytes(await invokeCommand<string>('sftp_download_chunk_base64', {
                taskId,
                offset,
                maxBytes: IPC_CHUNK_BYTES,
              }))
            : toUint8Array(await invoke<ArrayBuffer | Uint8Array>('sftp_download_chunk', {
                taskId,
                offset,
                maxBytes: IPC_CHUNK_BYTES,
              }))
          if (chunk.byteLength === 0) {
            controller.close()
            await close()
            return
          }
          offset += chunk.byteLength
          controller.enqueue(chunk)
        } catch (cause) {
          controller.error(normalizeCommandError(cause))
          try {
            await close()
          } catch {
            // Preserve the original download error.
          }
        }
      },
      async cancel() {
        await close()
      },
    })
  },

  listTransfers: (sessionId?: string, status?: string) => {
    return invokeCommand<TransferTask[]>('sftp_list_transfers', { sessionId, status })
  },

  cancelTransfer: (taskId: string) =>
    invokeCommand<{ id: string; status: string }>('sftp_cancel_transfer', { taskId }),

  clearCompletedTransfers: () =>
    invokeCommand<void>('sftp_clear_completed_transfers'),

  // --- Built-in editor ---

  /** Read a remote file as text for editing. Backend guards: >10MB → 413,
   *  binary → 415, non-UTF-8 → 415. Returns content + optimistic-lock token
   *  (mod_time) + Monaco language hint. */
  readFile: (sessionId: string, path: string) =>
    invokeCommand<SftpFileReadResponse>('sftp_read_file', { sessionId, path }),

  /** Write edited content back. Uses optimistic locking via expected_mod_time;
   *  mismatch → 409 FILE_MODIFIED. Returns the new mod_time for the next save. */
  writeFile: (sessionId: string, path: string, body: SftpFileWriteRequest) =>
    invokeCommand<SftpFileWriteResponse>('sftp_write_file', { sessionId, path, request: body }),
}

function toUint8Array(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value)
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.byteLength; offset += 32 * 1024) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32 * 1024))
  }
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}
