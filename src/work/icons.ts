// Pixel icons, drawn on a grid of squares so they share the heading's pixel voice.

export function pixelSvg(rows: string[], cls = "") {
  const h = rows.length
  const w = Math.max(...rows.map((r) => r.length))
  let rects = ""
  rows.forEach((r, y) => {
    for (let x = 0; x < r.length; x++) if (r[x] !== ".") rects += `<rect x="${x}" y="${y}" width="1.02" height="1.02"/>`
  })
  return `<svg class="${cls}" viewBox="0 0 ${w} ${h}" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true" focusable="false">${rects}</svg>`
}

export const ICONS = {
  /** a dithered double chevron: open / play the reel */
  open: ["X.X..", ".X.X.", "..X.X", ".X.X.", "X.X.."],
  play: ["X...", "XX..", "XXX.", "XXXX", "XXX.", "XX..", "X..."],
  pause: ["XX.XX", "XX.XX", "XX.XX", "XX.XX", "XX.XX", "XX.XX", "XX.XX"],
  close: ["X...X", ".X.X.", "..X..", ".X.X.", "X...X"],
  tag: ["X.X", ".X.", "X.X"],
  square: ["XX", "XX"],
}

export function soundSvg() {
  // four bars; CSS animates their height while the sound is on
  let bars = ""
  for (let i = 0; i < 4; i++) bars += `<rect class="eq__bar" x="${i * 2}" y="0" width="1.02" height="7"/>`
  return `<svg class="eq" viewBox="0 0 7 7" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true" focusable="false">${bars}</svg>`
}
