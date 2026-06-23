export interface Snippet {
  id: string
  name: string
  content: string
  description: string
  tags: string[]
  is_global: boolean
  created_at: string
  updated_at: string
}

export interface SnippetCreateRequest {
  name: string
  content: string
  description?: string
  tags?: string[]
  is_global?: boolean
}

export interface SnippetUpdateRequest {
  name?: string
  content?: string
  description?: string
  tags?: string[]
  is_global?: boolean
}
