// The Cove Studio palette, taken from the brand board (Image/brand-board.webp).
// Every colour on the site comes from here. The first six are the board's own
// labelled swatches; Hot Magenta is the big "COVE STUDIO" card, Electric Purple
// the app-icon tile.

export const PALETTE = {
  ink: "#0A0A0B", //       the ground
  paper: "#FFFFFF", //     type, chrome, the trail
  signalPink: "#FF0058",
  orange: "#FF7A00",
  lime: "#E7FF00",
  green: "#00E676",
  blue: "#0057FF",
  violet: "#A100FF",
  hotMagenta: "#FD2BC8",
  electricPurple: "#753AFB",
} as const

/** The accent spectrum, in board order, for anything that cycles colour. */
export const SPECTRUM = [
  PALETTE.signalPink,
  PALETTE.orange,
  PALETTE.lime,
  PALETTE.green,
  PALETTE.blue,
  PALETTE.violet,
  PALETTE.hotMagenta,
  PALETTE.electricPurple,
] as const

/** GLSL vec3 constants for the spectrum, so shaders share the exact values. */
export function spectrumGlsl(name = "PAL") {
  const v = SPECTRUM.map((h) => {
    const n = parseInt(h.slice(1), 16)
    const f = (x: number) => (x / 255).toFixed(4)
    return `vec3(${f((n >> 16) & 255)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`
  })
  return `const vec3 ${name}[${v.length}] = vec3[${v.length}](${v.join(", ")});`
}
