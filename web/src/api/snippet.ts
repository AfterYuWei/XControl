import { api } from './client'
import type { Snippet, SnippetCreateRequest, SnippetUpdateRequest } from '@/types/snippet'

export const snippetApi = {
  list: () => api.get<Snippet[]>('/api/snippets'),

  create: (data: SnippetCreateRequest) =>
    api.post<Snippet>('/api/snippets', data),

  update: (id: string, data: SnippetUpdateRequest) =>
    api.put<Snippet>(`/api/snippets/${id}`, data),

  delete: (id: string) => api.delete<void>(`/api/snippets/${id}`),
}
