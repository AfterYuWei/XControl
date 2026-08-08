import { describe, expect, it } from 'vitest'
import { calculateCompletionPosition } from './completionPosition'

describe('calculateCompletionPosition', () => {
  it('places a one-row panel directly above a cursor on the last row', () => {
    expect(calculateCompletionPosition({
      anchorLeft: 120,
      anchorTop: 760,
      anchorBottom: 780,
      panelWidth: 260,
      panelHeight: 30,
      containerWidth: 1000,
      containerHeight: 800,
    })).toEqual({ left: 120, top: 726 })
  })

  it('prefers the space below the cursor when the full panel fits', () => {
    expect(calculateCompletionPosition({
      anchorLeft: 120,
      anchorTop: 100,
      anchorBottom: 120,
      panelWidth: 260,
      panelHeight: 170,
      containerWidth: 1000,
      containerHeight: 800,
    })).toEqual({ left: 120, top: 124 })
  })

  it('places a multi-row panel above the cursor when it does not fit below', () => {
    expect(calculateCompletionPosition({
      anchorLeft: 120,
      anchorTop: 600,
      anchorBottom: 620,
      panelWidth: 260,
      panelHeight: 170,
      containerWidth: 1000,
      containerHeight: 700,
    })).toEqual({ left: 120, top: 426 })
  })

  it('clamps a cascade panel to the right edge using its actual width', () => {
    expect(calculateCompletionPosition({
      anchorLeft: 400,
      anchorTop: 100,
      anchorBottom: 120,
      panelWidth: 520,
      panelHeight: 100,
      containerWidth: 700,
      containerHeight: 500,
    }).left).toBe(172)
  })

  it('keeps the configured margin when the panel is larger than the container', () => {
    expect(calculateCompletionPosition({
      anchorLeft: 100,
      anchorTop: 80,
      anchorBottom: 100,
      panelWidth: 400,
      panelHeight: 300,
      containerWidth: 300,
      containerHeight: 200,
    })).toEqual({ left: 8, top: 8 })
  })

  it('recalculates the edge clamp after the container is resized', () => {
    const base = {
      anchorLeft: 700,
      anchorTop: 100,
      anchorBottom: 120,
      panelWidth: 260,
      panelHeight: 100,
      containerHeight: 500,
    }

    expect(calculateCompletionPosition({ ...base, containerWidth: 1000 }).left).toBe(700)
    expect(calculateCompletionPosition({ ...base, containerWidth: 800 }).left).toBe(532)
  })
})
