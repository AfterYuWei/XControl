import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeCommand } = vi.hoisted(() => ({ invokeCommand: vi.fn() }))
vi.mock('./tauri', () => ({ invokeCommand }))

import { documentApi, pickDocumentText } from './document'

describe('documentApi', () => {
  beforeEach(() => invokeCommand.mockReset())

  it('uses opaque references instead of content URIs', async () => {
    invokeCommand
      .mockResolvedValueOnce([{ reference: 'document://token-1', name: 'id_ed25519', size: 12 }])
      .mockResolvedValueOnce('private key')
      .mockResolvedValueOnce(undefined)

    await expect(pickDocumentText(['text/plain'], 1024)).resolves.toBe('private key')
    expect(invokeCommand).toHaveBeenNthCalledWith(1, 'document_pick', {
      multiple: false,
      mimeTypes: ['text/plain'],
    })
    expect(invokeCommand).toHaveBeenNthCalledWith(2, 'document_read_text', {
      reference: 'document://token-1',
      maxBytes: 1024,
    })
    expect(invokeCommand).toHaveBeenNthCalledWith(3, 'document_release', {
      reference: 'document://token-1',
    })
  })

  it('releases a staged document even when decoding fails', async () => {
    invokeCommand
      .mockResolvedValueOnce([{ reference: 'document://token-2', name: 'bad', size: 2 }])
      .mockRejectedValueOnce(new Error('encoding'))
      .mockResolvedValueOnce(undefined)

    await expect(pickDocumentText()).rejects.toThrow('encoding')
    expect(invokeCommand).toHaveBeenLastCalledWith('document_release', {
      reference: 'document://token-2',
    })
  })

  it('exports text through the native destination picker', async () => {
    invokeCommand.mockResolvedValue('content://saved')
    await documentApi.exportText('key', 'id_ed25519', 'application/x-pem-file')
    expect(invokeCommand).toHaveBeenCalledWith('document_export_text', {
      content: 'key',
      suggestedName: 'id_ed25519',
      mimeType: 'application/x-pem-file',
    })
  })
})
