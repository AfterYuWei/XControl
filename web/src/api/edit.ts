import { invokeCommand } from './tauri'
import type {
  SftpFileReadResponse,
  SftpFileWriteRequest,
  SftpFileWriteResponse,
} from '@/types/sftp'

/**
 * Unified file editor API.
 *
 * Works with both SFTP and ServerDetail sessions, which share Rust SFTP state.
 */
export const editApi = {
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
