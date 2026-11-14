// Minimal WebGL2 toolkit: programs with cached uniforms, render targets,
// ping-pong pairs and a fullscreen triangle. No engine, nothing hidden.

export type GL = WebGL2RenderingContext

export const FULLSCREEN_VS = `#version 300 es
out vec2 vUv;
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    vUv = p;
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

function compile(gl: GL, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s)
    const numbered = src
      .split("\n")
      .map((l, i) => `${i + 1}: ${l}`)
      .join("\n")
    console.error(numbered)
    throw new Error("shader compile: " + log)
  }
  return s
}

export class Program {
  readonly prog: WebGLProgram
  private locs = new Map<string, WebGLUniformLocation | null>()
  private units = new Map<string, number>()

  constructor(private gl: GL, fs: string, vs: string = FULLSCREEN_VS) {
    const v = compile(gl, gl.VERTEX_SHADER, vs)
    const f = compile(gl, gl.FRAGMENT_SHADER, fs)
    const p = gl.createProgram()!
    gl.attachShader(p, v)
    gl.attachShader(p, f)
    gl.linkProgram(p)
    gl.deleteShader(v)
    gl.deleteShader(f)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("link: " + gl.getProgramInfoLog(p))
    this.prog = p
  }

  use() {
    this.gl.useProgram(this.prog)
    return this
  }

  loc(name: string) {
    let l = this.locs.get(name)
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.prog, name)
      this.locs.set(name, l)
    }
    return l
  }

  f1(n: string, a: number) {
    this.gl.uniform1f(this.loc(n), a)
    return this
  }
  f2(n: string, a: number, b: number) {
    this.gl.uniform2f(this.loc(n), a, b)
    return this
  }
  f3(n: string, a: number, b: number, c: number) {
    this.gl.uniform3f(this.loc(n), a, b, c)
    return this
  }
  f4(n: string, a: number, b: number, c: number, d: number) {
    this.gl.uniform4f(this.loc(n), a, b, c, d)
    return this
  }
  v3(n: string, v: ArrayLike<number>) {
    this.gl.uniform3f(this.loc(n), v[0], v[1], v[2])
    return this
  }
  m3(n: string, m: Float32Array) {
    this.gl.uniformMatrix3fv(this.loc(n), false, m)
    return this
  }
  /** Binds a texture to a unit fixed per uniform name. */
  tex(n: string, t: WebGLTexture | null) {
    let u = this.units.get(n)
    if (u === undefined) {
      u = this.units.size
      this.units.set(n, u)
    }
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + u)
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.uniform1i(this.loc(n), u)
    return this
  }
}

export interface Target {
  tex: WebGLTexture
  fbo: WebGLFramebuffer
  w: number
  h: number
}

export interface Format {
  internal: number
  format: number
  type: number
}

export function createTarget(gl: GL, w: number, h: number, fmt: Format, filter: number): Target {
  const tex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internal, w, h, 0, fmt.format, fmt.type, null)
  const fbo = gl.createFramebuffer()!
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  gl.viewport(0, 0, w, h)
  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)
  return { tex, fbo, w, h }
}

export function deleteTarget(gl: GL, t: Target | null) {
  if (!t) return
  gl.deleteTexture(t.tex)
  gl.deleteFramebuffer(t.fbo)
}

export class PingPong {
  read: Target
  write: Target
  constructor(gl: GL, w: number, h: number, fmt: Format, filter: number) {
    this.read = createTarget(gl, w, h, fmt, filter)
    this.write = createTarget(gl, w, h, fmt, filter)
  }
  swap() {
    const t = this.read
    this.read = this.write
    this.write = t
  }
  dispose(gl: GL) {
    deleteTarget(gl, this.read)
    deleteTarget(gl, this.write)
  }
}

/** Draws the fullscreen triangle into a target (or the canvas when null). */
export function blit(gl: GL, target: Target | null, w?: number, h?: number) {
  if (target) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
    gl.viewport(0, 0, target.w, target.h)
  } else {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, w ?? gl.drawingBufferWidth, h ?? gl.drawingBufferHeight)
  }
  gl.drawArrays(gl.TRIANGLES, 0, 3)
}

export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "")
  if (h.length === 3) h = h.split("").map((x) => x + x).join("")
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255]
}
