export interface Group {
  id: string
  name: string
  parent_id?: string
  icon: string
  sort_order: number
  created_at: string
}

export interface GroupCreateRequest {
  name: string
  parent_id?: string
  icon?: string
}

export interface GroupUpdateRequest {
  name?: string
  parent_id?: string
  icon?: string
}
