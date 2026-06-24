import {
  Server,
  Terminal,
  Database,
  Cloud,
  HardDrive,
  Cpu,
  Globe,
  Box,
  Network,
  Shield,
  Container,
  Router,
  MemoryStick,
  Layers,
  Gauge,
  ServerCog,
  type LucideIcon,
} from 'lucide-react'

/**
 * Built-in line-style server icons. Each entry maps a stable string key
 * (stored on the profile) to a Lucide line icon. Icons render with
 * `currentColor`, so they automatically adapt to the active theme.
 */
export interface ServerIconDef {
  key: string
  label: string
  Icon: LucideIcon
}

export const SERVER_ICONS: ServerIconDef[] = [
  { key: 'server', label: '服务器', Icon: Server },
  { key: 'terminal', label: '终端', Icon: Terminal },
  { key: 'database', label: '数据库', Icon: Database },
  { key: 'cloud', label: '云主机', Icon: Cloud },
  { key: 'harddrive', label: '存储', Icon: HardDrive },
  { key: 'cpu', label: '计算', Icon: Cpu },
  { key: 'globe', label: '网络站点', Icon: Globe },
  { key: 'box', label: '容器', Icon: Box },
  { key: 'container', label: '集群', Icon: Container },
  { key: 'network', label: '网络', Icon: Network },
  { key: 'router', label: '路由', Icon: Router },
  { key: 'shield', label: '安全', Icon: Shield },
  { key: 'memory', label: '内存', Icon: MemoryStick },
  { key: 'layers', label: '分层', Icon: Layers },
  { key: 'gauge', label: '监控', Icon: Gauge },
  { key: 'server-cog', label: '运维', Icon: ServerCog },
]

const ICON_MAP: Record<string, LucideIcon> = Object.fromEntries(
  SERVER_ICONS.map((d) => [d.key, d.Icon])
)

/** Default icon key used when a profile has no icon set. */
export const DEFAULT_SERVER_ICON = 'server'

/**
 * Resolve a profile's icon key to a Lucide component, falling back to the
 * default server icon for unknown / empty keys.
 */
export function resolveServerIcon(key?: string): LucideIcon {
  if (key && ICON_MAP[key]) return ICON_MAP[key]
  return ICON_MAP[DEFAULT_SERVER_ICON]
}
