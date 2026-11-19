// The showreel frame: one textured quad drawn into a rounded rect, cover-fitted
// to whatever size the rect has right now (a small card, the framed reel, the
// whole screen). Pixelation is a dissolve, not a filter: every block flips to
// its own colour when the amount passes its random threshold, and blocks come
// in two sizes, so the picture breaks up and resolves in chunks.

const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uTexSize;
uniform vec2 uRes;      // device px
uniform vec4 uRect;     // device px, top-left origin: x, y, w, h
uniform float uRadius;  // device px
uniform float uPix;     // device px, the small block
uniform float uAmt;     // 0 sharp .. 1 every block pixelated
uniform float uSweep;   // extra pixelation toward the left edge
uniform float uSeed;
uniform float uLodBias;
uniform float uBright;  // 1 picture .. 0 black (the zoom into the player fades through black)
out vec4 o;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float sdRound(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
vec2 cover(vec2 uv) {
  float ra = uRect.z / uRect.w;
  float ta = uTexSize.x / uTexSize.y;
  if (ra > ta) uv.y = (uv.y - 0.5) * (ta / ra) + 0.5;
  else uv.x = (uv.x - 0.5) * (ra / ta) + 0.5;
  return uv;
}
void main() {
  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 c = uRect.xy + uRect.zw * 0.5;
  float d = sdRound(frag - c, uRect.zw * 0.5, uRadius);
  float a = clamp(0.5 - d, 0.0, 1.0);
  if (a <= 0.0) { o = vec4(0.0); return; }
  vec2 local = frag - uRect.xy;

  // two block sizes: big cells either stay whole or split into four
  float big = uPix * 2.0;
  float hb = hash(floor(local / big) + uSeed);
  float size = hb < 0.42 ? big : uPix;
  vec2 cell = floor(local / size);
  float h = hash(cell * 1.37 + size * 0.11 + uSeed);
  float xn = local.x / uRect.z;
  float amt = clamp(uAmt + (0.5 - xn) * uSweep, 0.0, 1.0);
  bool px = h < amt * 1.001;
  vec2 sp = px ? (cell + 0.5) * size : local;
  float bsize = px ? size : 0.0;
  vec2 uv = cover(clamp(sp / uRect.zw, 0.0, 1.0));
  // blocks read the averaged colour of the area they cover (a mip), not one texel
  float texPerPx = (uTexSize.x / uRect.z) * min(1.0, (uRect.z / uRect.w) / (uTexSize.x / uTexSize.y));
  float lod = px ? max(0.0, log2(bsize * texPerPx) - uLodBias) : 0.0;
  vec3 col = textureLod(uTex, uv, lod).rgb * uBright;
  o = vec4(col * a, a);
}`

export interface ReelRect {
  x: number
  y: number
  w: number
  h: number
  r: number
}

export class VideoGL {
  private gl: WebGL2RenderingContext | null
  private ctx2d: CanvasRenderingContext2D | null = null
  private prog: WebGLProgram | null = null
  private tex: WebGLTexture | null = null
  private loc: Record<string, WebGLUniformLocation | null> = {}
  private texW = 16
  private texH = 9
  private hasFrame = false
  private fresh = false
  private posterDone = false
  private dpr = 1
  private W = 1
  private H = 1
  private cssW = 1
  private cssH = 1
  seed = Math.random() * 100

  constructor(
    private canvas: HTMLCanvasElement,
    private video: HTMLVideoElement,
    private poster: HTMLImageElement,
  ) {
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false })
    this.gl = gl
    if (!gl) {
      this.ctx2d = canvas.getContext("2d")
      return
    }
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader")
      return s
    }
    const p = gl.createProgram()!
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS))
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || "link")
    this.prog = p
    for (const n of ["uTex", "uTexSize", "uRes", "uRect", "uRadius", "uPix", "uAmt", "uSweep", "uSeed", "uLodBias", "uBright"])
      this.loc[n] = gl.getUniformLocation(p, n)
    gl.bindVertexArray(gl.createVertexArray())
    this.tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([10, 10, 11, 255]))

    // only upload when the decoder has a new frame
    const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }
    if (v.requestVideoFrameCallback) {
      const onFrame = () => {
        this.fresh = true
        v.requestVideoFrameCallback!(onFrame)
      }
      v.requestVideoFrameCallback(onFrame)
    }
  }

  resize(cssW: number, cssH: number, dpr: number) {
    this.cssW = cssW
    this.cssH = cssH
    this.dpr = dpr
    this.W = Math.max(1, Math.round(cssW * dpr))
    this.H = Math.max(1, Math.round(cssH * dpr))
    this.canvas.width = this.W
    this.canvas.height = this.H
  }

  private upload(src: TexImageSource, w: number, h: number) {
    const gl = this.gl!
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)
    gl.generateMipmap(gl.TEXTURE_2D)
    this.texW = w
    this.texH = h
  }

  private feed() {
    const v = this.video
    if (v.readyState >= 2 && v.videoWidth) {
      const rvfc = typeof (v as any).requestVideoFrameCallback === "function"
      if (this.fresh || !this.hasFrame || (!rvfc && !v.paused)) {
        this.fresh = false
        this.hasFrame = true
        this.upload(v, v.videoWidth, v.videoHeight)
      }
      return
    }
    if (!this.posterDone && this.poster.complete && this.poster.naturalWidth) {
      this.posterDone = true
      this.upload(this.poster, this.poster.naturalWidth, this.poster.naturalHeight)
    }
  }

  clear() {
    if (this.gl) {
      this.gl.viewport(0, 0, this.W, this.H)
      this.gl.clearColor(0, 0, 0, 0)
      this.gl.clear(this.gl.COLOR_BUFFER_BIT)
    } else this.ctx2d?.clearRect(0, 0, this.W, this.H)
  }

  render(r: ReelRect, pix: number, amt: number, sweep: number, bright = 1) {
    if (r.w < 1 || r.h < 1) return this.clear()
    const d = this.dpr
    if (!this.gl) return this.render2d(r)
    const gl = this.gl
    this.feed()
    gl.viewport(0, 0, this.W, this.H)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(this.prog)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.uniform1i(this.loc.uTex, 0)
    gl.uniform2f(this.loc.uTexSize, this.texW, this.texH)
    gl.uniform2f(this.loc.uRes, this.W, this.H)
    gl.uniform4f(this.loc.uRect, r.x * d, r.y * d, r.w * d, r.h * d)
    gl.uniform1f(this.loc.uRadius, Math.min(r.r, r.w / 2, r.h / 2) * d)
    gl.uniform1f(this.loc.uPix, Math.max(2, pix * d))
    gl.uniform1f(this.loc.uAmt, amt)
    gl.uniform1f(this.loc.uSweep, sweep)
    gl.uniform1f(this.loc.uSeed, this.seed)
    gl.uniform1f(this.loc.uLodBias, 0.6)
    gl.uniform1f(this.loc.uBright, bright)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  /** No WebGL2: the plain picture, cover-fitted and clipped. */
  private render2d(r: ReelRect) {
    const c = this.ctx2d
    if (!c) return
    const d = this.dpr
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.clearRect(0, 0, this.W, this.H)
    const src: CanvasImageSource = this.video.readyState >= 2 ? this.video : this.poster
    const sw = this.video.readyState >= 2 ? this.video.videoWidth : this.poster.naturalWidth
    const sh = this.video.readyState >= 2 ? this.video.videoHeight : this.poster.naturalHeight
    if (!sw || !sh) return
    c.save()
    c.scale(d, d)
    c.beginPath()
    c.roundRect(r.x, r.y, r.w, r.h, Math.min(r.r, r.w / 2, r.h / 2))
    c.clip()
    const s = Math.max(r.w / sw, r.h / sh)
    c.drawImage(src, r.x + (r.w - sw * s) / 2, r.y + (r.h - sh * s) / 2, sw * s, sh * s)
    c.restore()
  }

  get width() {
    return this.cssW
  }
  get height() {
    return this.cssH
  }
}
