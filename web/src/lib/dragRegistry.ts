// 拖放目标注册表（P3 指针拖拽核心设施，见 docs/TAURI_MIGRATION.md §6.6）。
//
// 设计：拖放表面通过 data-drag-payload 属性声明目标元数据（JSON），
// 命中测试用 elementFromPoint + closest 语义向上找最近的声明元素——
// 深层元素（文件夹行）优先于外层容器（列表面板），天然实现
// 「拖到文件夹行上不要被列表的当前目录目标覆盖」的旧 HTML5 逻辑。
//
// 相比 Map<element, payload> 注册方案：无生命周期管理、随渲染自动更新
// （目录切换后 destDir 变化），对 FileRow/FileTree/Breadcrumb 零侵入。

import type { SftpDropTarget } from '@/store/sftp'

/** 拖放目标元数据：SFTP 各表面 / Sidebar 分组。 */
export type DragPayload =
  | { kind: 'sftp'; target: SftpDropTarget }
  | { kind: 'group'; groupId: string }

/** 渲染到拖放表面的 data 属性值。 */
export function dropPayloadAttr(payload: DragPayload): string {
  return JSON.stringify(payload)
}

/** 解析 data 属性值（容错：非法 JSON 返回 null）。 */
export function parseDropPayloadAttr(attr: string | null): DragPayload | null {
  if (!attr) return null
  try {
    return JSON.parse(attr) as DragPayload
  } catch {
    return null
  }
}

/**
 * 命中测试：返回坐标处最近的可拖放表面（CSS 像素坐标）。
 * Tauri onDragDropEvent 给的是物理像素，调用方需先除以 devicePixelRatio。
 */
export function hitTestDropTarget(x: number, y: number): DragPayload | null {
  let element = document.elementFromPoint(x, y) as HTMLElement | null
  while (element) {
    const payload = parseDropPayloadAttr(element.getAttribute('data-drag-payload'))
    if (payload) return payload
    element = element.parentElement
  }
  return null
}
