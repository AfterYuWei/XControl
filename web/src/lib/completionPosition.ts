export interface CompletionPositionInput {
  anchorLeft: number
  anchorTop: number
  anchorBottom: number
  panelWidth: number
  panelHeight: number
  containerWidth: number
  containerHeight: number
  gap?: number
  margin?: number
}

export interface CompletionPosition {
  left: number
  top: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Position a completion panel next to the cursor while keeping as much of the
 * panel as possible inside the terminal container.
 */
export function calculateCompletionPosition({
  anchorLeft,
  anchorTop,
  anchorBottom,
  panelWidth,
  panelHeight,
  containerWidth,
  containerHeight,
  gap = 4,
  margin = 8,
}: CompletionPositionInput): CompletionPosition {
  const maxLeft = Math.max(margin, containerWidth - panelWidth - margin)
  const left = clamp(anchorLeft, margin, maxLeft)

  const belowTop = anchorBottom + gap
  const aboveTop = anchorTop - panelHeight - gap
  const maxTop = Math.max(margin, containerHeight - panelHeight - margin)
  const fitsBelow = belowTop + panelHeight <= containerHeight - margin
  const fitsAbove = aboveTop >= margin

  let preferredTop: number
  if (fitsBelow) {
    preferredTop = belowTop
  } else if (fitsAbove) {
    preferredTop = aboveTop
  } else {
    const spaceBelow = containerHeight - margin - anchorBottom
    const spaceAbove = anchorTop - margin
    preferredTop = spaceBelow >= spaceAbove ? belowTop : aboveTop
  }

  return {
    left,
    top: clamp(preferredTop, margin, maxTop),
  }
}
