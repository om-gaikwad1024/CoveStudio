import { spectrumGlsl } from "../palette"

// Fragment shaders for the page passes:
//   COMPOSITE  – the ink trail: white liquid, dragged type and edge colour, solved for the page's "difference" blend
//   LOADER     – the opening micro-story, drawn over everything until it lets go

const HEAD = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
`

const COMMON = `
${spectrumGlsl("PAL")}
float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
// The brand spectrum, in order: pink, orange, lime, green, blue, violet.
vec3 spectrum(float t) {
    t = fract(t) * 8.0;
    int i = int(floor(t));
    float f = fract(t);
    f = f * f * (3.0 - 2.0 * f);
    return mix(PAL[i % 8], PAL[(i + 1) % 8], f);
}
`

/** Ink coverage from dye density: a hard liquid edge, anti-aliased by its own slope. */
const INK = `
uniform float uThreshold;
uniform vec2 uDyeTexel;
// Dye read through a soft tent so the liquid edge is round, never stringy.
vec4 dyeSoft(sampler2D t, vec2 uv) {
    vec2 o = uDyeTexel * 0.85;
    return texture(t, uv) * 0.36
        + (texture(t, uv + vec2(o.x, o.y)) + texture(t, uv + vec2(-o.x, o.y))
         + texture(t, uv + vec2(o.x, -o.y)) + texture(t, uv + vec2(-o.x, -o.y))) * 0.16;
}
float inkCover(float d) {
    float w = max(fwidth(d) * 0.75, 0.002);
    return smoothstep(uThreshold - w, uThreshold + w, d);
}
`

export const COMPOSITE_FS =
  HEAD +
  COMMON +
  INK +
  `
uniform sampler2D uDye;
uniform sampler2D uMask;
uniform sampler2D uOffset;  // drag field: where the page here was carried from
uniform vec2 uRes;          // device px
uniform vec3 uBase;
uniform float uTime;
uniform float uDpr;
uniform float uSeed;
uniform float uGrain;

// ---- live marks the static mask cannot hold ----
// The wordmark: its silhouette through the inverse of its on-screen
// perspective (a homography from device px to the image's 0..1 square).
uniform sampler2D uMarkTex;
uniform mat3 uMarkInv;
uniform float uMarkOn;      // opacity
uniform float uMarkClip;    // u beyond which the entrance wipe still hides it
uniform float uMarkLod;
// The globe: a wireframe drawn as ellipse distances in its own svg units.
uniform vec4 uGlobe;        // origin x, y (device px, GL), scale (device px per unit), opacity
uniform vec3 uGlobeMer;     // half-widths of the three meridians

float ellDist(vec2 p, vec2 r) {
    r = max(r, vec2(0.05));
    float k1 = length(p / r);
    float k2 = length(p / (r * r));
    return k1 * (k1 - 1.0) / max(k2, 1e-4);
}
float lineCov(float d, float w, float aa) { return 1.0 - smoothstep(w - aa, w + aa, abs(d)); }

float liveMarks(vec2 frag) {
    float m = 0.0;
    if (uMarkOn > 0.0) {
        vec3 q = uMarkInv * vec3(frag, 1.0);
        vec2 uv = q.xy / q.z;
        if (uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0 && uv.x <= uMarkClip)
            m = textureLod(uMarkTex, uv, uMarkLod).a * uMarkOn;
    }
    if (uGlobe.w > 0.0) {
        vec2 p = (frag - uGlobe.xy) / uGlobe.z;  // svg units, y up, centred
        if (abs(p.x) < 47.0 && abs(p.y) < 23.0) {
            float aa = 0.75 / uGlobe.z;
            float w = 1.0;
            float g = lineCov(ellDist(p, vec2(44.0, 20.0)), w, aa);
            g = max(g, lineCov(p.y, w, aa) * step(abs(p.x), 44.0));
            g = max(g, lineCov(abs(p.y) - 10.0, w, aa) * step(abs(p.x), 38.1));
            g = max(g, lineCov(ellDist(p, vec2(uGlobeMer.x, 20.0)), w, aa));
            g = max(g, lineCov(ellDist(p, vec2(uGlobeMer.y, 20.0)), w, aa));
            g = max(g, lineCov(ellDist(p, vec2(uGlobeMer.z, 20.0)), w, aa));
            m = max(m, g * uGlobe.w);
        }
    }
    return m;
}

float maskAt(vec2 uv) { return max(texture(uMask, uv).r, liveMarks(uv * uRes)); }

void main() {
    vec2 frag = gl_FragCoord.xy;
    vec2 uv = frag / uRes;
    // most of the screen is quiet: no liquid near, one fetch and out
    if (texture(uDye, uv).r < uThreshold - 0.12) {
        o = vec4(0.0);
        return;
    }
    float d = texture(uDye, uv).r;   // the fluid's surface tension already rounds the field
    float ink = inkCover(d);

    // What the trail shows inside itself, as it always has: a flat white
    // liquid; type inside it flips to the base colour, and the page under the
    // liquid is read where the flow dragged it from, so letters smear and curl
    // with the trail, then slide back as it relaxes. Where the liquid's edge
    // crosses a letter, the cut carries a slowly drifting band of palette colour.
    float mCur = maskAt(uv);
    float mDrag = maskAt(uv + texture(uOffset, uv).xy);
    float ePx = (d - uThreshold) / max(fwidth(d), 1e-5);   // px inside the edge
    float k = ePx / (7.0 * uDpr);
    float fringe = mDrag * step(0.0, ePx) * (1.0 - smoothstep(0.55, 1.0, k));
    float drift = uTime * 0.045 + (frag.x + frag.y) / (2600.0 * uDpr) + k * 0.1;
    vec3 letter = mix(uBase, spectrum(drift), fringe);
    vec3 want = mix(vec3(1.0), letter, mDrag);

    // The canvas is blended over the page in "difference" (one rule for the
    // whole site: whatever is under the ink inverts). So draw the colour that,
    // differenced with the page here, gives what we want to see: over the hero's
    // black ground that is the colour itself; over its white type, its inverse.
    // Where there are no marks (everywhere past the hero) this is plain white,
    // and the page simply inverts: lime turns deep blue, black type turns white.
    vec3 col = mix(want, 1.0 - want, mCur);

    float g = hash12(frag + uSeed * 17.0) - 0.5;
    col = clamp(col + g * uGrain, 0.0, 1.0);
    o = vec4(col * ink, ink);
}`

export const LOADER_FS =
  HEAD +
  COMMON +
  `
uniform vec2 uRes;      // device px
uniform float uDpr;
uniform float uT;       // seconds into the sequence (<0 while waiting)
uniform float uBurstAt; // when the dots start to run
uniform float uSpeed;   // device px per second of the front

const vec3 BLACK = vec3(0.039, 0.039, 0.043);

float smin(float a, float b, float k) {
    float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
}

// Halftone field on a 45 degree lattice; each dot's radius follows a travelling
// front. Tighter along one diagonal, so growing dots bead into wavy bands (the
// brand's slashes) before they flood.
float halftone(vec2 p, float front, float spacing) {
    mat2 rot = mat2(0.7071, 0.7071, -0.7071, 0.7071);
    vec2 q = rot * p;
    vec2 sp = vec2(spacing * 0.78, spacing * 1.3);
    vec2 cell = floor(q / sp);
    float d = 1e5;
    for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
            vec2 c = (cell + vec2(float(i), float(j)) + 0.5) * sp;
            vec2 wp = transpose(rot) * c;
            float dist = length(wp);
            float r = clamp((front - dist) * 0.075, 0.0, spacing * 1.1);
            if (r <= 0.0) continue;
            r *= 0.9 + 0.1 * sin(dist * 0.045 + uT * 9.0 + c.x * 0.02);
            d = smin(d, length(q - c) - r, spacing * 0.4);
        }
    }
    return d;
}

void main() {
    vec2 frag = gl_FragCoord.xy;
    float s = uDpr;
    vec2 p = frag - uRes * 0.5;
    float t = uT;
    float aa = 1.0;

    // the cat drops into a single black bead
    float bead = smoothstep(0.08, uBurstAt, t) * 11.0 * s;
    float d = length(p) - bead;
    vec3 rimA = vec3(0.0);
    float ring = 0.0;
    float outer = 0.0;

    // then the bead runs outward as liquid halftone with spectrum rims
    if (t > uBurstAt) {
        float spacing = 30.0 * s;
        float front = (t - uBurstAt) * uSpeed;
        d = smin(halftone(p, front, spacing), d, 8.0 * s);
        ring = smoothstep(-3.5 * s, -1.5 * s, d) * (1.0 - smoothstep(0.5 * s, 2.5 * s, d));
        outer = smoothstep(0.5 * s, 2.0 * s, d) * (1.0 - smoothstep(2.0 * s, 4.0 * s, d));
    }
    float fill = 1.0 - smoothstep(-aa, aa, d);
    float band = length(p) / (180.0 * s) - t * 0.8;
    // premultiplied over the white ground: black fill, spectrum rims at its edge
    vec3 col = spectrum(band) * ring * 0.95 + spectrum(band + 0.5) * outer * 0.8;
    float alpha = clamp(ring * 0.95 + outer * 0.8, 0.0, 1.0);
    col = mix(col, BLACK, fill);
    alpha = max(alpha, fill);

    float g = hash12(frag + t * 60.0) - 0.5;
    col += g * 0.035 * alpha;
    o = vec4(col, alpha);
}`
