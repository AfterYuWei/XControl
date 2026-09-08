import { invokeCommand } from './tauri'
import type { Snippet, SnippetCreateRequest, SnippetUpdateRequest } from '@/types/snippet'

export const snippetApi = {
  list: () => invokeCommand<Snippet[]>('snippet_list'),

  create: (data: SnippetCreateRequest) =>
    invokeCommand<Snippet>('snippet_create', { request: data }),

  update: (id: string, data: SnippetUpdateRequest) =>
    invokeCommand<Snippet>('snippet_update', { id, request: data }),

  delete: (id: string) => invokeCommand<void>('snippet_delete', { id }),
}
