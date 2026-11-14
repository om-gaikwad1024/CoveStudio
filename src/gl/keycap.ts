// The glass keycap, ported from the BerylCap component (raymarched WebGL2).
// Changes from the original:
//  - renders into its own target sized to the hero's key slot, with alpha, so
//    the page's composite can lay it in front of the wordmark;
//  - the light that passes through the glass now carries the real scene behind
//    it (text + ink), bent per wavelength, so the type refracts and splits;
//  - lights retuned toward the pink / violet holographic cap of the brand board;
//  - motion state lives in a plain class driven by the stage's single loop.

import { GL, Program, Target, blit, createTarget, deleteTarget, hexToRgb } from "./gl"

const EYE = 13

const makeFrag = (NS: number, AA: number, HALO: boolean, EV = 7, STEPS = 40) => `#version 300 es
precision highp float;
out vec4 outColor;

uniform vec2 uCentre;
uniform float uPx;
uniform vec2 uRoll;
uniform mat3 uInv;
uniform vec3 uOff;
uniform vec3 uTarget;
uniform float uElev;
uniform vec4 uShape;
uniform vec3 uDish;
uniform vec2 uWall;
uniform vec2 uIor;
uniform sampler2D uEnv;
uniform vec3 uKeyCol;
uniform vec3 uPtr;
uniform float uPtrGain;
uniform float uRim;
uniform float uRimPow;
uniform float uGlow;
uniform sampler2D uLegend;
uniform vec3 uLegendCol;
uniform float uLegendSize;
uniform float uLegLod;
uniform float uLegendGlow;
uniform vec3 uTintGlass;
uniform vec3 uScatterCol;
uniform float uScatter;
// scene behind the key, for refraction
uniform sampler2D uScene;
uniform vec2 uOrigin;   // device px of this target's bottom-left on the screen
uniform vec2 uScreen;   // screen size in device px
uniform float uFragScale; // screen device px per target px
uniform float uRefr;    // px of screen shift per unit of bend
uniform float uSceneGain;

const float PI = 3.14159265;
const float TAU = 6.28318531;
const int NS = ${NS};
const float EYE = ${EYE.toFixed(1)};
const float BOTTOM_ROUND = 0.03;
const int EV = ${EV};

float smax(float a, float b, float k) {
    float h = max(k - abs(a - b), 0.0) / k;
    return max(a, b) + h * h * k * 0.25;
}

float sdFrustum(vec3 p, float bw, float s, float h, float r, float eTop, float eBot, bool open) {
    float y = clamp(p.y, 0.0, h);
    float w = bw - s * y;
    float corner = min(r * (1.0 - 0.3 * y / h), w * 0.95);
    vec2 q = abs(p.xz) - vec2(w - corner);
    float dSide = (length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - corner) / sqrt(1.0 + s * s);
    float dY = open ? p.y - h : abs(p.y - h * 0.5) - h * 0.5;
    float e = p.y > h * 0.5 ? eTop : eBot;
    vec2 m = vec2(dSide + e, dY + e);
    return length(max(m, 0.0)) + min(max(m.x, m.y), 0.0) - e;
}

float sdCap(vec3 p) {
    float bw = uShape.x;
    float h = uShape.z;
    float s = (bw - uShape.y) / h;
    float d = sdFrustum(p, bw, s, h, uShape.w, uDish.z, BOTTOM_ROUND, false);
    d = smax(d, -(length(p - vec3(0.0, h + 3.0 - uDish.y, 0.0)) - 3.0), 0.05);
    if (uWall.x > 0.0) d = max(d, -sdFrustum(p, bw - uWall.x, s, uWall.y, max(uShape.w - uWall.x, 0.02), 0.05, 0.0, true));
    return d;
}

float exitT(vec3 p, vec3 d) {
    float bw = uShape.x;
    float h = uShape.z;
    float s = (bw - uShape.y) / h;
    float t = 1e4;
    float dn = d.x + s * d.y;
    if (dn > 0.0) t = min(t, (bw - p.x - s * p.y) / dn);
    dn = -d.x + s * d.y;
    if (dn > 0.0) t = min(t, (bw + p.x - s * p.y) / dn);
    dn = d.z + s * d.y;
    if (dn > 0.0) t = min(t, (bw - p.z - s * p.y) / dn);
    dn = -d.z + s * d.y;
    if (dn > 0.0) t = min(t, (bw + p.z - s * p.y) / dn);
    if (d.y < 0.0) t = min(t, -p.y / d.y);
    if (d.y > 0.0) t = min(t, (h - p.y) / d.y);
    vec3 oc = p - vec3(0.0, h + 3.0 - uDish.y, 0.0);
    float b = dot(oc, d);
    float disc = b * b - (dot(oc, oc) - 9.0);
    if (disc > 0.0) {
        float t0 = -b - sqrt(disc);
        if (t0 > 0.0) t = min(t, t0);
    }
    return max(t, 0.0);
}

void halfSpace(vec3 nrm, float o, vec3 p, vec3 d, bool isFloor, inout vec2 tt, inout bvec2 fl) {
    float nd = dot(nrm, d);
    float np = dot(nrm, p);
    if (abs(nd) < 1e-6) {
        if (np > o) tt.x = 1e5;
        return;
    }
    float t = (o - np) / nd;
    if (nd > 0.0) {
        if (t < tt.y) { tt.y = t; fl.y = isFloor; }
    } else if (t > tt.x) {
        tt.x = t; fl.x = isFloor;
    }
}

vec2 cavity(vec3 p, vec3 d, out bvec2 fl) {
    float s = (uShape.x - uShape.y) / uShape.z;
    float bi = uShape.x - uWall.x;
    vec2 tt = vec2(-1e4, 1e4);
    fl = bvec2(false);
    halfSpace(vec3(1.0, s, 0.0), bi, p, d, false, tt, fl);
    halfSpace(vec3(-1.0, s, 0.0), bi, p, d, false, tt, fl);
    halfSpace(vec3(0.0, s, 1.0), bi, p, d, false, tt, fl);
    halfSpace(vec3(0.0, s, -1.0), bi, p, d, false, tt, fl);
    halfSpace(vec3(0.0, 1.0, 0.0), uWall.y, p, d, false, tt, fl);
    halfSpace(vec3(0.0, -1.0, 0.0), 0.0, p, d, true, tt, fl);
    return tt;
}

vec3 calcN(vec3 p, float e) {
    const vec2 k = vec2(1.0, -1.0);
    return normalize(
        k.xyy * sdCap(p + k.xyy * e) +
        k.yyx * sdCap(p + k.yyx * e) +
        k.yxy * sdCap(p + k.yxy * e) +
        k.xxx * sdCap(p + k.xxx * e));
}

// The studio is baked into a panorama once per frame (see ENV_FS);
// here it is a single fetch per ray instead of a dozen procedural strips.
vec3 env(vec3 d) {
    float az0 = atan(d.x, d.z);
    float el = asin(clamp(d.y, -1.0, 1.0));
    return textureLod(uEnv, vec2(az0 / TAU + 0.5, el / PI + 0.5), 0.0).rgb;
}

// The page behind the key, displaced by how far the ray was bent.
vec3 backdrop(vec3 dW, vec3 rdW, vec3 right, vec3 up, vec2 frag) {
    vec3 b = dW - rdW;
    vec2 off = vec2(dot(b, right), dot(b, up)) * uRefr;
    vec2 uv = (uOrigin + frag * uFragScale + off) / uScreen;
    return textureLod(uScene, uv, 0.0).rgb * uSceneGain;
}

vec4 sampleAt(vec2 frag, out float sig) {
    sig = 0.0;
    vec2 uv = (frag - uCentre) / uPx;
    uv = mat2(uRoll.x, uRoll.y, -uRoll.y, uRoll.x) * uv;
    float se = sin(uElev);
    float ce = cos(uElev);
    vec3 fwd = -vec3(0.0, se, ce);
    vec3 up = vec3(0.0, ce, -se);
    vec3 right = vec3(1.0, 0.0, 0.0);
    vec3 rdW = normalize(vec3(uv.x, 0.0, 0.0) + up * uv.y + fwd * EYE);
    vec3 roW = uTarget - fwd * EYE;
    mat3 toW = transpose(uInv);
    vec3 ro = uInv * (roW - uOff);
    vec3 rd = uInv * rdW;
    // screen-axis vectors for the backdrop, unrolled
    vec3 sRight = vec3(uRoll.x, 0.0, 0.0) + up * uRoll.y;
    vec3 sUp = vec3(-uRoll.y, 0.0, 0.0) + up * uRoll.x;

    float bw = uShape.x;
    float h = uShape.z;
    float pxW = 1.0 / uPx;
    vec3 col = vec3(0.0);
    float hitA = 0.0;
    float legA = 0.0;
    vec3 legC = vec3(0.0);

    float mg = 0.2;
    vec3 inv = 1.0 / rd;
    vec3 t0 = (vec3(-bw - mg, -mg, -bw - mg) - ro) * inv;
    vec3 t1 = (vec3(bw + mg, h + mg, bw + mg) - ro) * inv;
    vec3 tmn = min(t0, t1);
    vec3 tmx = max(t0, t1);
    float tN = max(max(tmn.x, tmn.y), max(tmn.z, 0.0));
    float tF = min(min(tmx.x, tmx.y), tmx.z);

    if (tN < tF) {
        float t = 0.0;
        float minD = 1e9;
        bool hit = false;
        float eps = max(0.0004, pxW * 0.3);
        float s = (bw - uShape.y) / h;
        vec2 hc = vec2(-1e4, 1e4);
        bvec2 fl = bvec2(false);
        halfSpace(vec3(1.0, s, 0.0), bw, ro, rd, false, hc, fl);
        halfSpace(vec3(-1.0, s, 0.0), bw, ro, rd, false, hc, fl);
        halfSpace(vec3(0.0, s, 1.0), bw, ro, rd, false, hc, fl);
        halfSpace(vec3(0.0, s, -1.0), bw, ro, rd, false, hc, fl);
        halfSpace(vec3(0.0, 1.0, 0.0), h, ro, rd, false, hc, fl);
        halfSpace(vec3(0.0, -1.0, 0.0), 0.0, ro, rd, false, hc, fl);
        if (hc.x < hc.y && hc.y > 0.0) {
            t = max(hc.x, 0.0);
            for (int i = 0; i < ${STEPS}; i++) {
                float d = sdCap(ro + rd * t);
                minD = min(minD, d);
                if (d < eps) { hit = true; break; }
                t += d;
                if (t > hc.y) break;
            }
        }
        if (${HALO ? 'true' : 'false'} && !hit && uGlow > 0.0 && minD > pxW * 3.0) {
            float tg = tN;
            for (int i = 0; i < 28; i++) {
                float d = sdCap(ro + rd * tg);
                minD = min(minD, d);
                tg += max(d * 0.8, pxW * 0.5);
                if (tg > tF) break;
            }
        }
        if (hit) {
            vec3 p = ro + rd * t;
            float ne = max(0.0015, pxW * 0.8);
            vec3 n = calcN(p, ne);
            float cosi = clamp(dot(n, -rd), 0.0, 1.0);
            float ior = uIor.x;

            vec3 d = refract(rd, n, 1.0 / ior);
            vec3 q = p - n * 0.002;
            bool inGlass = true;
            vec3 evN[EV];
            int evK[EV];
            int nev = 0;
            int fate = 0;
            float path = 0.0;
            for (int i = 0; i < EV; i++) {
                bvec2 fl;
                if (inGlass) {
                    float tO = exitT(q, d);
                    float tC = 1e4;
                    if (uWall.x > 0.0) {
                        vec2 c = cavity(q, d, fl);
                        if (c.x <= c.y && c.x > 0.0 && !fl.x) tC = c.x;
                    }
                    float tt = min(tO, tC);
                    q += d * tt;
                    path += tt;
                    vec3 nn = calcN(q, ne);
                    evN[i] = nn;
                    nev = i + 1;
                    vec3 ex = refract(d, -nn, ior);
                    if (dot(ex, ex) < 1e-4) {
                        evK[i] = 0;
                        d = reflect(d, nn);
                        q -= nn * 0.002;
                        continue;
                    }
                    evK[i] = 1;
                    d = ex;
                    if (tC < tO) {
                        inGlass = false;
                        q += nn * 0.002;
                    } else {
                        fate = 1;
                        break;
                    }
                } else {
                    vec2 c = cavity(q, d, fl);
                    if (fl.y) { fate = 2; break; }
                    q += d * c.y;
                    vec3 nn = calcN(q, ne);
                    evN[i] = nn;
                    evK[i] = 2;
                    nev = i + 1;
                    d = refract(d, nn, 1.0 / ior);
                    q -= nn * 0.002;
                    inGlass = true;
                }
            }

            sig = 1.0 + float(nev) + 10.0 * float(fate);

            vec3 tr = vec3(0.0);
            vec3 wsum = vec3(0.0);
            for (int k = 0; k < NS; k++) {
                float f = float(k) / float(NS - 1);
                vec3 w = clamp(abs(fract(f * 0.72 + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
                float ik = ior + uIor.y * (f * 2.0 - 1.0);
                vec3 dk = refract(rd, n, 1.0 / ik);
                for (int i = 0; i < EV; i++) {
                    if (i >= nev) break;
                    vec3 nn = evN[i];
                    if (evK[i] == 0) {
                        dk = reflect(dk, nn);
                    } else if (evK[i] == 1) {
                        vec3 ex = refract(dk, -nn, ik);
                        dk = dot(ex, ex) < 1e-4 ? reflect(dk, nn) : ex;
                    } else {
                        dk = refract(dk, nn, 1.0 / ik);
                    }
                }
                vec3 dW = toW * dk;
                vec3 c = env(dW);
                if (fate != 0) c += backdrop(dW, rdW, sRight, sUp, frag);
                tr += w * c * (fate == 0 ? 0.3 : 1.0);
                wsum += w;
            }
            tr /= wsum;
            tr *= mix(vec3(1.0), uTintGlass, clamp(path / 1.6, 0.0, 1.0));
            // Light scattered inside the body: the cap glows from within,
            // hotter toward its top where the print sits.
            float within = (1.0 - exp(-path * 1.6)) * (0.55 + 0.45 * smoothstep(0.0, h, p.y));
            tr += uScatterCol * uScatter * within;

            vec3 refl = env(toW * reflect(rd, n));
            float F = 0.04 + 0.96 * pow(1.0 - cosi, 5.0);
            col = tr * (1.0 - F) + refl * F;

            float g = 1.0 - cosi;
            col += vec3(pow(g, uRimPow * 1.08), pow(g, uRimPow), pow(g, uRimPow * 0.92)) * uRim;

            vec2 nh = abs(n.xz);
            float vert = smoothstep(0.45, 0.8, min(nh.x, nh.y) / max(max(nh.x, nh.y), 1e-3)) * (1.0 - smoothstep(0.45, 0.7, n.y));
            float lip = smoothstep(0.32, 0.5, n.y) * (1.0 - smoothstep(0.86, 0.95, n.y)) * step(h * 0.75, p.y);
            float base = smoothstep(0.1, 0.4, -n.y) * step(p.y, 0.1);
            float edge = max(max(vert, lip), base * 0.5);
            col += edge * (vec3(0.95, 0.85, 1.0) * 0.9 + tr) * uRim;

            vec2 dp = (frag - uPtr.xy) / uPtr.z;
            float pool = exp(-dot(dp, dp));
            col += uKeyCol * uPtrGain * pool * (0.2 + edge * 1.4 + F * 2.5 + exp(-dot(dp, dp) * 12.0) * 0.35);

            if (n.y > 0.6 && p.y > h * 0.85) {
                vec2 tuv = p.xz / uLegendSize + 0.5;
                if (tuv.x > 0.0 && tuv.x < 1.0 && tuv.y > 0.0 && tuv.y < 1.0) {
                    float fade = smoothstep(0.6, 0.8, n.y);
                    vec4 pr = textureLod(uLegend, tuv, uLegLod);
                    legA = pr.a * fade;
                    legC = uLegendCol;
                    float halo = textureLod(uLegend, tuv, uLegLod + 3.0).a * fade;
                    float halo2 = textureLod(uLegend, tuv, uLegLod + 5.0).a * fade;
                    col += legC * (halo * 0.35 + halo2 * 0.25) * uLegendGlow;
                }
            }
            hitA = 1.0;
        } else {
            col = vec3(0.95, 0.75, 1.0) * uGlow * exp(-max(minD, 0.0) / (0.035 + pxW));
        }
    }

    col = 1.0 - exp(-col * 1.35);
    col = mix(col, legC, legA);
    return vec4(col, hitA);
}

const vec2 RG[5] = vec2[5](vec2(0.0), vec2(0.125, 0.375), vec2(-0.375, 0.125), vec2(0.375, -0.125), vec2(-0.125, -0.375));

void main() {
    vec2 frag = gl_FragCoord.xy;
    vec4 outC = vec4(0.0);
    float n = 0.0;
    bool edge = false;
    for (int i = 0; i < ${AA}; i++) {
        float sg;
        vec4 c = sampleAt(frag + RG[i], sg);
        if (i == 0) {
            vec3 fc = fwidth(c.rgb);
            edge = fwidth(sg) > 0.5 || max(fc.r, max(fc.g, fc.b)) > 0.12 || fwidth(c.a) > 0.0;
        }
        outC += c;
        n += 1.0;
        if (!edge) break;
    }
    outC /= n;
    // premultiplied: glass pixels are opaque, the halo adds light (alpha 0)
    outColor = vec4(outC.rgb, outC.a);
}`


// Bakes the studio around the key into an equirectangular panorama:
// u = azimuth, v = elevation. Rebuilt every frame (it is tiny) so the
// softboxes can sway and the pointer light can follow the cursor.
const ENV_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform float uEnvRot;
uniform vec3 uC0;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;
uniform vec4 uAz;
uniform vec3 uKeyCol;
uniform vec2 uKeyDir;
uniform vec4 uPL;
uniform float uLight;
const float PI = 3.14159265;
const float TAU = 6.28318531;
vec3 strip(float az, float el, vec3 c, float a0, float e0, float ang, float len, float wid) {
    vec2 q = vec2((mod(az - a0 + PI, TAU) - PI) * cos(e0), el - e0);
    float ca = cos(ang);
    float sa = sin(ang);
    vec2 r = vec2(ca * q.x + sa * q.y, ca * q.y - sa * q.x);
    float along = 1.0 - smoothstep(len * 0.55, len, abs(r.x));
    float x = abs(r.y) / wid;
    float body = 1.0 - smoothstep(0.45, 1.0, x);
    float core = exp(-x * x * 6.0);
    float ramp = 0.65 + 0.35 * r.x / len;
    return c * along * ramp * (body * 0.3 + core * 2.4);
}

vec3 env(vec3 d) {
    float el = asin(clamp(d.y, -1.0, 1.0));
    float az0 = atan(d.x, d.z);
    float az = az0 - uEnvRot;
    vec3 c = vec3(0.012, 0.003, 0.02) + vec3(0.09, 0.015, 0.11) * smoothstep(-0.2, 0.9, d.y);
    float r = 0.01745;
    vec3 s = strip(az, el, uC0, uAz.x, -36.0 * r, 0.2, 0.3, 0.09);
    s += strip(az, el, uC0, uAz.x + 33.0 * r, -42.0 * r, 1.45, 0.3, 0.04);
    s += strip(az, el, uC0, uAz.x, -70.0 * r, 0.0, 0.6, 0.035) * 0.35;
    s += strip(az, el, uC1, uAz.y, -42.0 * r, 1.5707, 0.35, 0.03);
    s += strip(az, el, uC1, uAz.y + 20.0 * r, -49.0 * r, 1.5707, 0.1, 0.03);
    s += strip(az, el, uC1, uAz.y + 130.0 * r, 20.0 * r, 1.3, 0.7, 0.08);
    s += strip(az, el, uC2, uAz.z, -45.0 * r, 1.5707, 0.3, 0.018) * 0.6;
    s += strip(az, el, uC2, uAz.z, 38.0 * r, 0.05, 1.0, 0.1);
    s += strip(az, el, uC3, uAz.w, -30.0 * r, 1.5707, 0.45, 0.1) * 0.04;
    s += strip(az, el, uC3, uAz.w - 123.0 * r, 20.0 * r, 1.5, 0.75, 0.05);
    s += strip(az, el, vec3(1.0), uAz.x + 28.0 * r, -55.0 * r, 0.05, 0.3, 0.025) * 1.2;
    s += strip(az, el, vec3(1.0), uAz.x + 43.0 * r, -40.0 * r, 1.5707, 0.3, 0.012);
    s += strip(az, el, vec3(1.0), uAz.z, 47.0 * r, 0.0, 0.6, 0.02) * 0.8;
    s += strip(az, el, vec3(1.0), uAz.x - 8.0 * r, -25.0 * r, 1.45, 0.3, 0.02);
    c += s * uLight;
    if (uPL.z > 0.0) {
        c += strip(az0, el, uKeyCol, PI - uPL.x, -40.0 * r + uPL.y, 1.5707, 0.35, 0.05) * uPL.z * 1.4;
        c += strip(az0, el, uKeyCol, uPL.x, 35.0 * r + uPL.y, 0.0, 0.3, 0.08) * uPL.z * 0.9;
    }
    c += strip(az0, el, uKeyCol, uKeyDir.x, uKeyDir.y, 0.0, 0.3, 0.12) * 1.2;
    return c;
}


void main() {
    float az0 = (vUv.x - 0.5) * TAU;
    float el = (vUv.y - 0.5) * PI;
    vec3 d = vec3(cos(el) * sin(az0), sin(el), cos(el) * cos(az0));
    o = vec4(env(d), 1.0);
}`

const D2R = Math.PI / 180
const PRINT_TEX = 1024
const MARK_SHARE = 0.64
const LIGHT_SWAY = 22 * D2R
const TOP_ROUND = 0.07

const clampN = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function bezier(x1: number, y1: number, x2: number, y2: number, x: number) {
  let lo = 0
  let hi = 1
  let t = x
  for (let i = 0; i < 20; i++) {
    const bx = 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t
    if (bx < x) lo = t
    else hi = t
    t = (lo + hi) / 2
  }
  return 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t
}

/** Look of the cap. Tuned against the brand-board hero. */
export const KEY_LOOK = {
  turn: 28,
  elevation: 40,
  capHeight: 64,
  topRatio: 70,
  cornerRadius: 9,
  dishDepth: 4,
  wall: 11,
  tiltRange: 9,
  nodRange: 4,
  bobAmount: 4,
  driftPeriod: 8.5,
  lightPeriod: 12,
  pressInterval: 7,
  pressDepth: 9,
  pressTilt: 2,
  pressDamping: 0.5,
  ior: 1.52,
  dispersion: 0.085,
  light: 3.5,
  rim: 0.95,
  rimPow: 3,
  glow: 0.07,
  // pink / violet / blue softboxes, a warm orange kicker low
  c0: "#FD2BC8", // Hot Magenta
  a0: 172,
  c1: "#A100FF", // Violet
  a1: 152,
  c2: "#0057FF", // Blue
  a2: 186,
  c3: "#FF7A00", // Orange
  a3: 183,
  keyColor: "#FFD9F4",
  keyAngle: 0,
  keyHeight: 65,
  tintGlass: "#FD6BD6",
  scatterColor: "#FD2BC8",
  scatter: 0.42,
  roll: -9,
  legendGlow: 1.25,
}

export interface PointerState {
  x: number // css px, viewport
  y: number
  over: boolean // pointer is inside the window
  down: boolean
}

/** Device pixels the raymarch may spend at full quality; the slot scales to fit. */
const KEY_BUDGET = 440_000

export class KeyCap {
  private hq: Program
  private lq: Program
  private envP: Program
  private env: Target
  private legendTex: WebGLTexture
  /** 0.5..1 multiplier on the key's resolution, lowered by the stage on slow frames */
  quality = 1
  /** fewer spectral samples and no edge resampling */
  low = false
  target: Target | null = null
  private inv = new Float32Array(9)
  private st = { t: 0, press: 0, pv: 0, over: 0, rest: 0, lx: 0, ly: 0, lvx: 0, lvy: 0, gx: 0, gy: 0 }
  private legendReady = false
  /** css px rect of the slot on screen */
  rect = { x: 0, y: 0, w: 1, h: 1 }
  scale = 1
  private dpr = 1
  private envFrame = 0
  /** 0..1, how present the key is (the stage animates it in) */
  presence = 1
  /** extra hover energy the stage can read (0..1) */
  get hover() {
    return this.st.over
  }
  get pressAmt() {
    return this.st.press
  }

  constructor(private gl: GL, private reduced: () => boolean) {
    // both variants compile up front, behind the loader, so a later switch never stutters
    this.hq = new Program(gl, makeFrag(6, 5, true))
    this.lq = new Program(gl, makeFrag(3, 2, false, 3, 28))
    this.envP = new Program(gl, ENV_FS)
    this.env = createTarget(gl, 384, 192, { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT }, gl.LINEAR)
    gl.bindTexture(gl.TEXTURE_2D, this.env.tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
    this.legendTex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.legendTex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]))
  }

  /**
   * A blow from the pointer: the cap ducks into the press and swings away from
   * the direction of travel, then the springs bring it home.
   */
  punch(dx: number, dy: number, strength: number) {
    const st = this.st
    st.pv += 9 * strength
    st.lvx += dx * 7 * strength
    st.lvy -= dy * 7 * strength
  }

  /** Dev: swap the low-quality variant to profile shader cost. */
  variant(ns: number, aa: number, halo: boolean, ev: number, steps: number) {
    this.lq = new Program(this.gl, makeFrag(ns, aa, halo, ev, steps))
    this.low = true
  }

  setMark(img: HTMLImageElement) {
    const c = document.createElement("canvas")
    c.width = c.height = PRINT_TEX
    const ctx = c.getContext("2d")!
    const N = PRINT_TEX
    const iw = img.naturalWidth || 1
    const ih = img.naturalHeight || 1
    const f = (N * MARK_SHARE) / Math.max(iw, ih)
    ctx.translate(N / 2, N / 2)
    ctx.drawImage(img, (-iw * f) / 2, (-ih * f) / 2, iw * f, ih * f)
    ctx.globalCompositeOperation = "source-in"
    ctx.fillStyle = "#fff"
    ctx.fillRect(-N, -N, 2 * N, 2 * N)
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.legendTex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c)
    gl.generateMipmap(gl.TEXTURE_2D)
    this.legendReady = true
  }

  /** Slot rect in css px and the device scale; reallocates the target when needed. */
  layout(x: number, y: number, w: number, h: number, dpr: number) {
    this.rect = { x, y, w, h }
    const budget = Math.sqrt(KEY_BUDGET / Math.max(1, w * h))
    const scale = Math.max(0.35, Math.min(dpr * 2, budget) * this.quality)
    this.scale = scale
    this.dpr = dpr
    const W = Math.max(1, Math.round(w * scale))
    const H = Math.max(1, Math.round(h * scale))
    if (!this.target || this.target.w !== W || this.target.h !== H) {
      deleteTarget(this.gl, this.target)
      const gl = this.gl
      this.target = createTarget(gl, W, H, { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE }, gl.LINEAR)
    }
  }

  /** Advances the motion state. Pointer is in viewport css px. */
  update(dt: number, ptr: PointerState) {
    const A = KEY_LOOK
    const st = this.st
    const reduced = this.reduced()
    const R = this.rect
    const rate = reduced ? 0 : 1
    st.t += dt * rate

    const on = ptr.over
    const e = A.elevation * D2R
    const ce = Math.cos(e)
    const se = Math.sin(e)
    const bw = 1
    const tw = A.topRatio / 100
    const hh = (2 * A.capHeight) / 100
    const hU = hh * ce + (tw + bw) * Math.SQRT2 * se
    const sizePx = this.sizePx()
    const keyR = Math.max(10, sizePx * 0.5)
    // pointer relative to the key's centre in key radii (y up)
    const cx = R.x + R.w / 2
    const cy = R.y + R.h / 2
    const kx = (ptr.x - cx) / keyR
    const ky = -(ptr.y - cy) / keyR
    const dist = Math.hypot(kx, ky)
    const near = on ? Math.exp(-Math.pow(Math.max(0, dist - 1) / 1.8, 2)) : 0
    const restOn = on && dist < 1.0 ? 1 : 0
    const tx = on ? clampN(kx / 1.3, -1, 1) * near : 0
    const ty = on ? clampN(ky / 1.3, -1, 1) * near : 0
    st.over += (near - st.over) * (1 - Math.exp(-dt * 6))
    st.rest += (restOn - st.rest) * (1 - Math.exp(-dt * 9))
    const w0 = 7
    st.lvx += (w0 * w0 * (tx - st.lx) - 2 * w0 * 0.7 * st.lvx) * dt
    st.lvy += (w0 * w0 * (ty - st.ly) - 2 * w0 * 0.7 * st.lvy) * dt
    st.lx += st.lvx * dt
    st.ly += st.lvy * dt
    // glint follows the cursor in slot-normalised coords (-1..1, y up)
    const gx0 = on ? clampN(((ptr.x - R.x) / R.w) * 2 - 1, -1.5, 1.5) : 0
    const gy0 = on ? clampN(1 - ((ptr.y - R.y) / R.h) * 2, -1.5, 1.5) : 0
    const kf = 1 - Math.exp(-dt * 14)
    st.gx += (gx0 - st.gx) * kf
    st.gy += (gy0 - st.gy) * kf

    const ph = st.t % A.pressInterval
    let drive = -1
    if (!reduced && ph < 0.2) drive = ph < 0.12 ? bezier(0.55, 0, 1, 0.45, ph / 0.12) : 1
    const target = reduced ? 0 : ptr.down && st.rest > 0.5 ? 1 : st.rest * 0.32
    if (reduced) {
      st.press = 0
      st.pv = 0
    } else if (drive >= 0 && drive >= st.press) {
      st.press = drive
      st.pv = 0
    } else {
      const k0 = 14
      const z = A.pressDamping
      const n = 4
      const hs = dt / n
      for (let i = 0; i < n; i++) {
        const a = -k0 * k0 * (st.press - target) - 2 * z * k0 * st.pv
        st.pv += a * hs
        st.press += st.pv * hs
      }
    }
    this._hU = hU
  }
  private _hU = 1

  sizePx() {
    // the cap fills ~64% of the slot's height, leaving room for lean and halo
    return Math.min(this.rect.h * 0.64, this.rect.w * 0.6)
  }

  render(scene: Target, screenW: number, screenH: number, hoverHeat: number) {
    if (!this.target) return
    const gl = this.gl
    const A = KEY_LOOK
    const st = this.st
    const reduced = this.reduced()
    const T = st.t
    const hv = 1
    const lean = st.over * hv
    const calm = 1 - 0.65 * clampN(st.over, 0, 1)
    const Pd = A.driftPeriod
    const yaw = A.turn + A.tiltRange * calm * Math.sin((2 * Math.PI * T) / Pd) + lean * 30 * st.lx
    const nod = A.nodRange * calm * Math.sin((2 * Math.PI * T) / (Pd * 0.75)) - lean * 18 * st.ly + A.pressTilt * st.press
    const e = A.elevation * D2R
    const ce = Math.cos(e)
    const bw = 1
    const tw = A.topRatio / 100
    const hh = (2 * A.capHeight) / 100
    const hU = this._hU
    const ty0 = (hh * ce + (tw - bw) * Math.SQRT2 * Math.sin(e)) / (2 * ce)
    const bob = hU * (A.bobAmount / 100) * Math.sin((2 * Math.PI * T) / (Pd * 0.5)) * calm
    const lift = hU * 0.05 * Math.max(0, st.over - st.rest)
    const pull = 0.1 * bw * st.lx * lean
    const drop = hU * (A.pressDepth / 100) * st.press

    const cy = Math.cos(yaw * D2R)
    const sy = Math.sin(yaw * D2R)
    const cx = Math.cos(nod * D2R)
    const sx = Math.sin(nod * D2R)
    const inv = this.inv
    inv[0] = cy
    inv[1] = 0
    inv[2] = sy
    inv[3] = sx * sy
    inv[4] = cx
    inv[5] = -sx * cy
    inv[6] = -cx * sy
    inv[7] = sx
    inv[8] = cx * cy

    const W = this.target.w
    const H = this.target.h
    const sizePx = this.sizePx()
    // presence scales the key up from nothing as it materialises
    const pres = 0.82 + 0.18 * this.presence
    const pxU = ((sizePx * this.scale) / hU) * pres
    const face = 2 * tw
    const sp = A.dispersion * (1 + 0.4 * clampN(st.press, 0, 1)) * (1 + 0.9 * st.over) * (1 + 0.8 * hoverHeat)
    const roll = A.roll * D2R

    // 1 · bake the studio; the softboxes drift slowly, so every other frame is
    //     plenty: the lights are seen only in reflection
    this.envFrame++
    const bake = this.envFrame % 2 === 0 || this.envFrame < 3
    const ev = this.envP.use()
    ev.f1("uEnvRot", LIGHT_SWAY * Math.sin((2 * Math.PI * T) / A.lightPeriod) + lean * 0.4 * st.lx)
    ev.v3("uC0", hexToRgb(A.c0))
    ev.v3("uC1", hexToRgb(A.c1))
    ev.v3("uC2", hexToRgb(A.c2))
    ev.v3("uC3", hexToRgb(A.c3))
    ev.f4("uAz", A.a0 * D2R, A.a1 * D2R, A.a2 * D2R, A.a3 * D2R)
    ev.v3("uKeyCol", hexToRgb(A.keyColor))
    ev.f2("uKeyDir", A.keyAngle * D2R, A.keyHeight * D2R)
    ev.f4("uPL", st.lx * 0.7, st.ly * 0.35, reduced ? 0 : st.over, 0)
    ev.f1("uLight", A.light * (1 + 0.3 * st.over))
    gl.disable(gl.BLEND)
    if (bake) blit(gl, this.env)

    // 2 · march the glass
    const p = (this.low ? this.lq : this.hq).use()
    const R = this.rect
    p.f3("uPtr", (st.gx * 0.5 + 0.5) * W, (st.gy * 0.5 + 0.5) * H, Math.max(8, sizePx * this.scale * 0.32))
    p.f1("uPtrGain", reduced ? 0 : st.over)
    p.f2("uCentre", W * 0.5, H * 0.5)
    p.f1("uPx", pxU)
    p.f2("uRoll", Math.cos(roll), Math.sin(roll))
    p.m3("uInv", inv)
    p.f3("uOff", pull, bob + lift - drop, 0)
    p.f3("uTarget", 0, ty0, 0)
    p.f1("uElev", e)
    p.f4("uShape", bw, tw, hh, (A.cornerRadius / 100) * 2)
    const dish = (A.dishDepth / 100) * 2
    p.f3("uDish", 3.0, dish, TOP_ROUND)
    const wall = (A.wall / 100) * bw
    p.f2("uWall", wall, wall > 0 ? hh - dish - wall : 0)
    p.f2("uIor", A.ior, sp)
    p.v3("uKeyCol", hexToRgb(A.keyColor))
    p.f1("uRim", A.rim * (1 + 0.3 * clampN(st.press, 0, 1)) * (1 + 0.35 * st.over))
    p.f1("uRimPow", A.rimPow)
    p.f1("uGlow", A.glow * (1 + 0.5 * st.over))
    p.v3("uLegendCol", [1, 1, 1])
    p.f1("uLegendSize", face)
    p.f1("uLegLod", Math.max(0, Math.log2(((PRINT_TEX / face) * 0.75) / Math.max(1e-3, pxU))))
    p.f1("uLegendGlow", this.legendReady ? A.legendGlow * (1 + 0.6 * st.over + 0.8 * st.press) : 0)
    p.v3("uTintGlass", hexToRgb(A.tintGlass))
    p.v3("uScatterCol", hexToRgb(A.scatterColor))
    p.f1("uScatter", A.scatter * (1 + 0.5 * st.over + 0.6 * st.press))
    p.tex("uLegend", this.legendTex)
    p.tex("uScene", scene.tex)
    p.tex("uEnv", this.env.tex)
    p.f1("uFragScale", this.dpr / this.scale)
    // target's bottom-left in device px, GL convention (y up)
    p.f2("uOrigin", R.x * this.dpr, screenH - (R.y + R.h) * this.dpr)
    p.f2("uScreen", screenW, screenH)
    p.f1("uRefr", sizePx * this.dpr * 0.55)
    p.f1("uSceneGain", 0.95)

    gl.disable(gl.BLEND)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target.fbo)
    gl.viewport(0, 0, W, H)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    blit(gl, this.target)
  }
}
