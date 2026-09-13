import { describe, expect, it } from 'vitest'

import { selectionSpecFromInclusiveCells } from '@/lib/terminalSelection'

describe('selectionSpecFromInclusiveCells', () => {
  it('keeps a same-line selection inclusive', () => {
    expect(selectionSpecFromInclusiveCells({ x: 3, y: 4 }, { x: 7, y: 4 }, 80)).toEqual({
      column: 3,
      row: 4,
      length: 5,
    })
  })

  it('selects continuously across terminal rows', () => {
    expect(selectionSpecFromInclusiveCells({ x: 78, y: 4 }, { x: 2, y: 6 }, 80)).toEqual({
      column: 78,
      row: 4,
      length: 85,
    })
  })

  it('normalizes endpoints when a handle crosses the fixed anchor', () => {
    expect(selectionSpecFromInclusiveCells({ x: 5, y: 8 }, { x: 70, y: 6 }, 80)).toEqual({
      column: 70,
      row: 6,
      length: 96,
    })
  })
})
