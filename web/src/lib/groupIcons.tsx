import {
  Folder,
  FolderTree,
  Folders,
  Boxes,
  Box,
  Layers,
  Globe,
  Cloud,
  Network,
  Container,
  Workflow,
  GitBranch,
  Shapes,
  FolderCog,
  Package,
  type LucideIcon,
} from 'lucide-react'

/**
 * Built-in line-style group icons. Each entry maps a stable string key
 * (stored on the group) to a Lucide line icon. Icons render with
 * `currentColor`, so they automatically adapt to the active theme.
 */
export interface GroupIconDef {
  key: string
  label: string
  Icon: LucideIcon
}

export const GROUP_ICONS: GroupIconDef[] = [
  { key: 'folder', label: '文件夹', Icon: Folder },
  { key: 'folder-tree', label: '目录树', Icon: FolderTree },
  { key: 'folders', label: '多文件夹', Icon: Folders },
  { key: 'boxes', label: '集合', Icon: Boxes },
  { key: 'box', label: '容器', Icon: Box },
  { key: 'layers', label: '分层', Icon: Layers },
  { key: 'globe', label: '地域', Icon: Globe },
  { key: 'cloud', label: '云', Icon: Cloud },
  { key: 'network', label: '网络', Icon: Network },
  { key: 'container', label: '集群', Icon: Container },
  { key: 'workflow', label: '流程', Icon: Workflow },
  { key: 'git-branch', label: '分支', Icon: GitBranch },
  { key: 'shapes', label: '分类', Icon: Shapes },
  { key: 'folder-cog', label: '配置', Icon: FolderCog },
  { key: 'package', label: '包', Icon: Package },
]

const ICON_MAP: Record<string, LucideIcon> = Object.fromEntries(
  GROUP_ICONS.map((d) => [d.key, d.Icon])
)

/** Default icon key used when a group has no icon set. */
export const DEFAULT_GROUP_ICON = 'folder'

/**
 * Resolve a group's icon key to a Lucide component, falling back to the
 * default folder icon for unknown / empty keys (including legacy emoji).
 */
export function resolveGroupIcon(key?: string): LucideIcon {
  if (key && ICON_MAP[key]) return ICON_MAP[key]
  return ICON_MAP[DEFAULT_GROUP_ICON]
}
