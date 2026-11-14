import { spectrumGlsl } from "../palette"

// Fragment shaders for the page passes:
//   SCENE      – the page as the key sees it behind its glass (type + ink)
//   COMPOSITE  – what lands on screen: ink, inverted type, the key, its heat
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

export const SCENE_FS =
  HEAD +
  INK +
  `
uniform sampler2D uDye;
uniform sampler2D uMask;
uniform vec3 uInk;
uniform vec3 uBase;
uniform float uSceneScale;  // screen device px per scene px

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

void main() {
    float d = dyeSoft(uDye, vUv).r;
    float m = max(texture(uMask, vUv).r, liveMarks(gl_FragCoord.xy * uSceneScale));
    float ink = inkCover(d);
    vec3 page = mix(uBase, vec3(1.0), m);
    vec3 inked = mix(uInk, uBase, m);
    o = vec4(mix(page, inked, ink), 1.0);
}`

export const COMPOSITE_FS =
  HEAD +
  COMMON +
  INK +
  `
uniform sampler2D uDye;
uniform sampler2D uVel;
uniform sampler2D uMask;
uniform sampler2D uKey;
uniform sampler2D uOffset;  // drag field: where the page here was carried from
uniform vec2 uRes;          // device px
uniform vec4 uKeyRect;      // device px, GL origin (x, y, w, h)
uniform vec3 uInk;
uniform vec3 uBase;
uniform float uTime;
uniform float uDpr;
uniform float uIntro;       // key materialisation 0..1
uniform float uSeed;
uniform float uGrain;
// Punch shockwaves on the glass: (x, y) device px GL origin, age in s, strength
uniform vec4 uWave[3];
uniform float uWaveReach;   // device px the ring travels before it is spent

// Heat of a ring as it travels: white-hot at the blow, orange, then pink and
// violet as it cools toward the far side.
vec3 heatRamp(float h) {
    h = clamp(h, 0.0, 1.0);
    vec3 cold = vec3(0.42, 0.12, 0.95);
    vec3 pink = vec3(1.0, 0.18, 0.62);
    vec3 orange = vec3(1.0, 0.42, 0.05);
    vec3 amber = vec3(1.0, 0.78, 0.32);
    vec3 white = vec3(1.0, 0.98, 0.92);
    if (h < 0.3) return mix(cold, pink, h / 0.3);
    if (h < 0.6) return mix(pink, orange, (h - 0.3) / 0.3);
    if (h < 0.85) return mix(orange, amber, (h - 0.6) / 0.25);
    return mix(amber, white, (h - 0.85) / 0.15);
}

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

// Catmull-Rom in five bilinear taps: the key is rendered below screen
// resolution on lean GPUs, and this upsample keeps its edges crisp.
uniform vec2 uKeyTexSize;
vec4 keySharp(vec2 uv) {
    vec2 sp = uv * uKeyTexSize;
    vec2 t1 = floor(sp - 0.5) + 0.5;
    vec2 f = sp - t1;
    vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
    vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
    vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
    vec2 w3 = f * f * (-0.5 + 0.5 * f);
    vec2 w12 = w1 + w2;
    vec2 t0 = (t1 - 1.0) / uKeyTexSize;
    vec2 t3 = (t1 + 2.0) / uKeyTexSize;
    vec2 t12 = (t1 + w2 / w12) / uKeyTexSize;
    vec4 r = texture(uKey, vec2(t12.x, t0.y)) * (w12.x * w0.y)
           + texture(uKey, vec2(t0.x, t12.y)) * (w0.x * w12.y)
           + texture(uKey, t12) * (w12.x * w12.y)
           + texture(uKey, vec2(t3.x, t12.y)) * (w3.x * w12.y)
           + texture(uKey, vec2(t12.x, t3.y)) * (w12.x * w3.y);
    float wsum = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
    return clamp(r / wsum, 0.0, 1.0);
}

float maskAt(vec2 uv) { return max(texture(uMask, uv).r, liveMarks(uv * uRes)); }

void main() {
    vec2 frag = gl_FragCoord.xy;
    vec2 uv = frag / uRes;
    // Most of the screen is quiet: no liquid near, no key. One fetch and out.
    // (the margin keeps every quad near a visible edge on the full path)
    vec2 kq0 = (frag - uKeyRect.xy) / uKeyRect.zw;
    bool inKey = uIntro > 0.0 && kq0.x >= 0.0 && kq0.y >= 0.0 && kq0.x <= 1.0 && kq0.y <= 1.0;
    if (!inKey && texture(uDye, uv).r < uThreshold - 0.12) {
        o = vec4(0.0);
        return;
    }
    vec4 dye = texture(uDye, uv);   // the fluid's surface tension already rounds the field
    float d = dye.r;
    float ink = inkCover(d);

    // A flat liquid: no shading, no depth, just the white of the trail.
    // Type inside the ink flips to the base colour. Where the liquid's edge
    // crosses a letter, the cut carries a band of palette colour - a gradient
    // that drifts slowly from one colour to the next, never flashing (the
    // edge outside letters stays plain).
    // the page under the liquid is read where the flow dragged it from, so
    // letters smear and curl with the trail, then slide back as it relaxes
    float m = maskAt(uv + texture(uOffset, uv).xy);
    float ePx = (d - uThreshold) / max(fwidth(d), 1e-5);   // px inside the edge
    float B = 7.0 * uDpr;
    float k = ePx / B;
    float fringe = m * step(0.0, ePx) * (1.0 - smoothstep(0.55, 1.0, k));
    float drift = uTime * 0.045 + (frag.x + frag.y) / (2600.0 * uDpr) + k * 0.1;
    vec3 fc = spectrum(drift);
    vec3 letter = mix(uBase, fc, fringe);
    vec3 col = mix(uInk, letter, m) * ink;
    float a = ink;
    float keyCover = 0.0;

    // ---- the key ----
    vec2 kuv = (frag - uKeyRect.xy) / uKeyRect.zw;
    if (kuv.x >= 0.0 && kuv.y >= 0.0 && kuv.x <= 1.0 && kuv.y <= 1.0 && uIntro > 0.0) {
        // Materialise: a dithered, scanned ghost resolves into glass with an RGB tear.
        float tear = (1.0 - smoothstep(0.55, 1.0, uIntro)) * 26.0 * uDpr;
        vec2 to = vec2(tear / uKeyRect.z, 0.0);
        // Shockwaves: a single ring runs out from where the glass was hit,
        // bending the glass as it passes and cooling as it goes. Inside the
        // ring the glass is scorched dark violet for a beat; that contrast is
        // what makes the hot crest read as a blow.
        vec2 bend = vec2(0.0);
        vec3 waveCol = vec3(0.0);
        float scorch = 0.0;
        vec3 scorchCol = vec3(0.0);
        for (int i = 0; i < 3; i++) {
            vec4 W = uWave[i];
            if (W.w <= 0.0 || W.z < 0.0 || W.z > 0.6) continue;
            float life = W.z / 0.46;                       // 0 -> 1 across the key
            float lt = min(life, 1.0);
            float R = uWaveReach * (1.0 - pow(1.0 - lt, 2.4));
            vec2 dv = frag - W.xy;
            float dist = length(dv);
            vec2 n = dist > 0.5 ? dv / dist : vec2(0.0);
            float width = mix(16.0, 46.0, lt) * uDpr;
            float x = (dist - R) / width;
            // hot leading edge, a softer trailing shoulder
            float ring = exp(-x * x * (x > 0.0 ? 3.2 : 1.1));
            float push = x * exp(-x * x * 1.4);
            float fade = (1.0 - smoothstep(0.5, 1.0, life)) * W.w;
            bend += n * push * 16.0 * uDpr * fade;
            float heat = (1.0 - lt) * (0.6 + 0.4 * W.w);
            // the blow itself: a white-hot bloom where it landed, first frames only
            float bloom = exp(-dot(dv, dv) / pow(uWaveReach * 0.2, 2.0)) * (1.0 - smoothstep(0.0, 0.3, life));
            waveCol += heatRamp(heat) * ring * fade * 2.9 + vec3(1.0, 0.92, 0.78) * bloom * W.w * 2.4;
            // scorched wake behind the crest, cooling as the ring moves on
            float wake = smoothstep(R + width * 0.2, R - width * 4.0, dist) * (1.0 - smoothstep(0.15, 1.0, life)) * W.w;
            scorch = max(scorch, wake * 0.75);
            scorchCol = mix(vec3(0.35, 0.04, 0.32), vec3(0.16, 0.05, 0.4), lt);
        }
        vec2 kb = kuv - bend / uKeyRect.zw;
        vec4 k = keySharp(kb);
        // the crest splits light
        if (dot(bend, bend) > 0.01) {
            k.r = texture(uKey, kb - bend * 0.5 / uKeyRect.zw).r;
            k.b = texture(uKey, kb + bend * 0.5 / uKeyRect.zw).b;
        }
        // Grade the glass: deeper and more saturated, a touch darker in the
        // body, so the lit print and the bevels stand out and the cat glows.
        float kl = dot(k.rgb, vec3(0.299, 0.587, 0.114));
        vec3 kg = mix(vec3(kl), k.rgb, 1.25);
        kg = max((kg - 0.5) * 1.16 + 0.5 - 0.035, 0.0);
        // keep the brightest highlights (the print, the rim lights) at full strength
        kg = mix(kg, k.rgb, smoothstep(0.82, 1.0, kl));
        k.rgb = kg * k.a + k.rgb * (1.0 - k.a);
        vec3 kc = mix(k.rgb, k.rgb * scorchCol * 2.2, scorch * k.a);
        // screen the heat in, so the crest burns toward white without clipping flat
        vec3 hw = clamp(waveCol * k.a, 0.0, 1.0);
        kc = 1.0 - (1.0 - kc) * (1.0 - hw);
        float ka = k.a;
        if (tear > 0.001) {
            vec4 kR = texture(uKey, kb + to);
            vec4 kB = texture(uKey, kb - to);
            kc.r = kR.r;
            kc.b = kB.b;
            ka = max(ka, max(kR.a, kB.a));
        }

        // Ghost phase.
        float ghost = 1.0 - smoothstep(0.35, 0.75, uIntro);
        if (ghost > 0.0) {
            float scan = step(0.5, fract(frag.y / (2.0 * uDpr)));
            float dither = step(hash12(floor(frag / uDpr)), 0.55);
            vec3 holo = vec3(0.92, 0.9, 1.0) * (0.25 + 0.75 * scan) * dither;
            float ga = k.a * scan * 0.55 * smoothstep(0.0, 0.25, uIntro);
            kc = mix(kc, holo * k.a, ghost);
            ka = mix(ka, ga, ghost);
        }
        // Flash of spectrum as it lands.
        float flash = smoothstep(0.5, 0.7, uIntro) * (1.0 - smoothstep(0.7, 1.0, uIntro));
        kc += spectrum(kuv.y * 1.5 + uTime * 0.6) * flash * 0.45 * k.a;

        keyCover = ka;
        col = kc + col * (1.0 - ka);
        a = ka + a * (1.0 - ka);
    }

    // Grit on the polish: fine grain wherever we draw.
    float g = hash12(frag + uSeed * 17.0) - 0.5;
    col += g * uGrain * a * (1.0 - 0.75 * keyCover);
    o = vec4(clamp(col, 0.0, 1.0), clamp(a, 0.0, 1.0));
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
