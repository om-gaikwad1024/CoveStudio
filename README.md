# Cove Studio

Marketing studio site. Vite + TypeScript, raw WebGL2, GSAP for DOM timing. No framework.

## Run

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm run build      # type-checks, then builds to dist/
npm run preview    # serves dist/ on :4173
```

In dev, `?freeze=0.6` holds the loader at that second, and `window.__cove` exposes the stage.

## Deploy (Vercel)

Import the folder as a project (or run `vercel` in it). `vercel.json` sets the Vite build, `dist/` as
output and long-cache headers for hashed assets. No env vars.

## How the hero is built

One fixed WebGL canvas sits over the page (`pointer-events: none`) and owns every effect; the DOM keeps
the real, accessible text.

| File | Role |
| --- | --- |
| `src/gl/stage.ts` | the single loop: pointer → fluid, punch detection, passes, GPU tiering and quality ladder |
| `src/palette.ts` | the brand palette (from `Image/brand-board.webp`, see `PALETTE.md`), shared with the shaders |
| `src/gl/fluid.ts` | GPU stable-fluids: velocity + dye; no swirl, light surface tension so the trail behaves like mercury; stamps drawn additively inside their bounding box |
| `src/gl/keycap.ts` | the glass key (ported BerylCap raymarcher), studio lights baked to a panorama each frame, refracts the page behind it |
| `src/gl/passes.ts` | scene (what the glass sees), composite (white ink, inverted marks, punch shockwave, materialise), loader (white → black halftone flood) |
| `src/gl/mask.ts` | paints the page's still white marks (type, pills, logo) into a texture so the ink can invert them |
| `public/img/cove-reel.webp` | the brand reel (from `Image/Cove_Studio_GIF.gif`, re-timed to 150 ms a frame) played inside the CD case while it is hovered |
| `src/hero.ts` | wireframe globe, spring 3D tilt (wordmark, CD case), and the GPU "live marks" for things that move every frame |

Moving marks (the tilted wordmark, the spinning globe) are not repainted into the mask; the shader draws
them itself — the wordmark through a homography of its on-screen perspective, the globe as ellipse
distances — so the ink inverts them exactly at no CPU cost.

Trail: a flat, plain-edged white liquid that evaporates the way buttermax.net's does — measured there
at slow, medium and fast pointer speeds. Ink is eaten away at a steady rate (with a little spatial
variation), so the outline creeps inward from the moment it is laid, thin parts pinch off into beads
and strands, thick cores shrink last; everything is gone ~1 s after the pointer stops. Slow movement
makes one fat blob riding the cursor, medium a tadpole (fat head, tapering tail), fast a long even band
that collapses into strands. Type under the liquid is dragged a little with the flow and slides back.
Where the trail's edge cuts a letter, the cut carries a slowly drifting band of palette colour.

Punch: the trail runs under the key. Arriving on the key faster than ~900 px/s (or clicking it) sends a
single shockwave ring from the point of contact — a white-hot bloom where it landed, a hot crest that
cools orange → pink → violet as it crosses the cap, a short scorched wake behind it, and the glass bends
as the crest passes (~0.46 s). The key recoils.

Performance: integrated / mobile GPUs start at a 1x canvas with the lean glass shader, rendering the key
at ~0.7 resolution with edge anti-aliasing and a Catmull-Rom upsample; dedicated GPUs at 1.5x with the
full spectral shader. The ladder watches frame times against the display's own refresh and steps the
key's samples, then its resolution, then the canvas density. Measured on Intel Iris Xe at 1600×743 under
heavy ink and hover: 59.5 fps, p95 16.8 ms.
