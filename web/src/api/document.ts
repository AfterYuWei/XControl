import { invokeCommand } from './tauri'

export interface DocumentDescriptor {
  reference: string
  name: string
  size: number
}

export const documentApi = {
  pick: (multiple = false, mimeTypes: string[] = []) =>
    invokeCommand<DocumentDescriptor[]>('document_pick', { multiple, mimeTypes }),
  release: (reference: string) =>
    invokeCommand<void>('document_release', { reference }),
  readText: (reference: string, maxBytes = 1024 * 1024) =>
    invokeCommand<string>('document_read_text', { reference, maxBytes }),
  exportText: (content: string, suggestedName: string, mimeType = 'text/plain') =>
    invokeCommand<string | null>('document_export_text', { content, suggestedName, mimeType }),
}

export async function pickDocumentText(mimeTypes: string[] = ['text/plain'], maxBytes = 1024 * 1024) {
  const document = (await documentApi.pick(false, mimeTypes))[0]
  if (!document) return null
  try {
    return await documentApi.readText(document.reference, maxBytes)
  } finally {
    await documentApi.release(document.reference).catch(() => undefined)
  }
}
