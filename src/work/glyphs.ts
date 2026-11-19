// The pixel A, S and O, from the user's SOA.svg (Downloads/SOA.svg).
// Each glyph is a set of rects on a 160-unit cap height; y offsets are kept,
// so the O sits a touch inside the cap line as drawn.

export interface PixelGlyph {
  w: number
  rects: [number, number, number, number][]
}

export const CAP_UNITS = 160

export const PIXEL_GLYPHS: Record<string, PixelGlyph> = {
  S: {
    w: 127,
    rects: [
      [22, 0, 82, 23],
      [0, 22, 22, 44],
      [105, 23, 22, 23],
      [22, 67, 82, 23],
      [105, 90, 22, 47],
      [0, 115, 22, 22],
      [22, 138, 82, 22],
    ],
  },
  O: {
    w: 133,
    rects: [
      [39, 9, 55, 20],
      [19, 30, 20, 20],
      [94, 30, 20, 20],
      [0, 50, 19, 61],
      [114, 50, 19, 61],
      [19, 112, 20, 20],
      [94, 112, 20, 20],
      [39, 132, 55, 20],
    ],
  },
  A: {
    w: 125,
    rects: [
      [46, 1, 34, 22],
      [23, 24, 22, 22],
      [80, 24, 22, 22],
      [0, 47, 22, 39],
      [103, 47, 22, 39],
      [23, 87, 79, 22],
      [0, 110, 22, 50],
      [103, 110, 22, 50],
    ],
  },
}

/** extra stroke around every block, in glyph units: strokes ~10% heavier, to sit with the type */
export const GLYPH_BOLD = 2.2

/** drawn width and height of a glyph including its bold stroke, in glyph units */
export const glyphBox = (g: PixelGlyph) => ({ w: g.w + GLYPH_BOLD, h: CAP_UNITS + GLYPH_BOLD })

export function glyphSvg(g: PixelGlyph, cls: string) {
  const r = g.rects.map(([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`).join("")
  const b = GLYPH_BOLD / 2
  const box = glyphBox(g)
  return `<svg class="${cls}" viewBox="${-b} ${-b} ${box.w} ${box.h}" preserveAspectRatio="none" fill="currentColor" stroke="currentColor" stroke-width="${GLYPH_BOLD}" stroke-linejoin="miter" shape-rendering="crispEdges" aria-hidden="true" focusable="false">${r}</svg>`
}
