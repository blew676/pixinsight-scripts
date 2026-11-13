# ContinuumTools for PixInsight

Four scripts for PixInsight 1.9.4+ (V8 engine):

| Script | What it does |
|---|---|
| **Narrowband Continuum Subtraction** | Removes the continuum (starlight, dust, reflection) from Hα / OIII / SII using a broadband image, without creating black star holes. |
| **Broadband Line Removal** | Removes emission-line light (Hα + [NII], OIII, Hβ) from R / G / B, leaving only the continuum: dust, reflection nebulae, IFN, stars. |
| **Star Hole Repair** | Finds and fills the dark holes that over-subtracted stars leave in existing continuum-subtracted images (like `NB_OLD`). |
| **Add Narrowband to RGB** | Adds stretched, continuum-subtracted Hα / OIII / SII to a stretched RGB or LRGB image with a soft addition that never clips, with a live preview. |

## Install

From the update repository, which keeps them up to date:

1. In PixInsight: **Resources > Updates > Manage Repositories**, **Add**, enter `https://pixinsight.blastrophoto.com/`, then **OK**.
2. **Resources > Updates > Check for Updates**, apply, and let PixInsight restart.
3. The tools appear under **Script > ContinuumTools**.

Or by hand: **Script > Feature Scripts...**, **Add**, pick this `ContinuumTools` folder, then **Done**.

The scripts are not code-signed yet. If PixInsight complains, allow unsigned scripts or run them once with **Script > Run Script File...**.

## 1. Narrowband Continuum Subtraction

Inputs: the narrowband master and the broadband master, **both linear, with stars, registered and cropped identically**. Use the 32-bit XISF masters if you can; 16-bit TIFF exports lose faint signal.

1. **Narrowband** = Hα (or OIII / SII). **Continuum** = R for Hα and SII, G or B for OIII. For a color continuum image, pick the channel.
2. Leave the two *starless* selectors empty: StarXTerminator makes starless copies once per session (about 10 s each here). You can also select starless images you already have.
3. Click **Measure from stars**. The scale factor *k* is the median Hα/R flux ratio of a few thousand isolated stars. On sh2-155 (Antlia 3 nm Hα 600 s vs V-Pro R 180 s) it is **k = 0.143**.
4. Click **Update preview** and move *k* if you like. Too high darkens the nebula and eats faint emission; too low leaves dust glow.
5. Click **Create image**: `<narrowband>_CS`, linear, starless. Tick **Keep the narrowband stars** if you want natural Hα stars back in the result.

**Why the old starless runs came out flat.** The SetiAstro ContinuumSubtraction script calibrates the two channels against each other before subtracting:
- With stars, it calibrates on the stars, which is correct. Then it clips everything below zero, and those clipped stars are the black holes.
- Starless, it calibrates on the brightest 200 px patch, which is the brightest *emission*. The R filter also passes Hα, so this scales R up until it cancels the nebula itself.

This tool always measures *k* on the stars and only subtracts on the starless images.

The optional **Line in continuum c** only rescales the result by 1/(1 − k·c). Leave it at 0 unless you need flux-calibrated output.

## 2. Broadband Line Removal

Inputs: a linear broadband image (mono R/G/B or RGB, stars are fine) and the continuum-subtracted line image(s) from tool 1. Starless line images keep the broadband stars untouched.

1. **Broadband** = R, **Hα line image** = `Ha_CS`. For an RGB target, add an **OIII line image** too.
   - The R channel gets Hα.
   - G and B get OIII.
   - B also gets Hβ, scaled from Hα.
2. Exposure times are read from EXPTIME / EXPOSURE. TIFFs have no keywords, so type them in.
3. **From exposures** sets amount = c / (1 − k·c), where:
   - c = (t_BB / t_NB) × F, and F is the filter factor.
   - k is read from the line image's history.
   - F for R ← Hα defaults to 1.40: a wide R filter passes the [NII] lines, which a 3 nm Hα filter mostly rejects.
4. **From image** estimates the amount from the image itself, using a robust band-pass regression. On sh2-155 the two estimates agree: **0.447** from exposures and **0.461** from the image.
5. Check the preview: the bright Hα fronts should vanish without leaving a dark imprint. Toggle **Show original** to compare.
6. **Create image**: `<broadband>_continuum`.

F defaults for the other channels (filter dependent, so tune with the preview):
- OIII → G: 0.5
- OIII → B: 1.0
- Hβ → B: 0.30

## 3. Star Hole Repair

Inputs: the image with holes (linear or stretched, mono or color). Two optional images help a lot:
- **Star reference**: an image *with* stars, registered to the target, for example the R master.
- **Guide**: a starless image, for example the Hα starless image that tool 1 leaves open.

1. Click **Detect**. Green circles will be repaired; red ones are dark structure that is left alone. **Click a circle to flip it.**
2. Click **Preview repair**, then toggle **Show repaired** to compare.
3. Click **Apply**. You get a new `<target>_repaired` image, or the target is modified in place (undoable). Optionally a `<target>_holemask` too.

How holes are separated from real dark nebulae:
- The hole must be compact and clipped to near black.
- With a reference, a star must sit at the hole's centre, bright enough for the hole's size. The star must exceed about 5 × r² in noise units, where r is the hole radius in px.

How holes are filled:
- **With a guide:** the guide's structure is fitted locally to the target's brightness.
- **Without a guide:** a smooth membrane fill, with texture borrowed from a clean nearby patch.

Results on sh2-155 `NB_OLD`, with R as reference and Hα starless as guide:
- **945 holes** detected and repaired in about 5 s, including the small top-right ones that were never healed by hand.
- The dark patch at the bottom edge is real structure, present in Hα and R too, so it is left alone.
- Without a reference, detection uses shape only. It works, but misses more holes and is less selective.

## 4. Add Narrowband to RGB

Inputs: a **stretched** RGB or LRGB image and one or more **stretched** continuum-subtracted narrowband images (Hα, OIII, SII), all registered. You process the RGB and the narrowband separately, then add the narrowband when you like.

Each line is added with this PixelMath, where W is the channel's weight:

```
$T * ~W + W * mtf(~m, (mtf(m, $T) + mtf(m, NB)))
```

The defaults reproduce the original recipes exactly. This was checked against PixelMath itself on the sh2-155 data: largest difference 6 × 10⁻⁸.

| Line | R | G | B |
|---|---|---|---|
| Hα | 1.0 | 0.0 | 0.05 |
| OIII | 0.0 | 1.0 | 1.5 |
| SII (starting point) | 1.0 | 0.2 | 0.0 |

All lines share m = 0.999. Lines are applied in the order Hα, OIII, SII, just like running the PixelMath instances one after another.

**What the formula does.** `mtf(m, ·)` and `mtf(~m, ·)` are a transform and its inverse, so the images are added in the transformed space. With m near 1 that space is x/(1 − x), the "odds". Faint signal therefore adds almost linearly, but nothing can pass white: bright nebula and star cores roll off smoothly instead of clipping. The weights then decide how much of that sum goes into R, G and B:
- 1 = all of it.
- 0 = none.
- Above 1 = more (the 1.5 in B is what makes OIII teal).
- Below 0 = takes it away.

What the tool adds on top of the PixelMath (defaults leave them neutral):
- **Live preview** with every control, and **Show original** to compare.
- **Strength** per line. It scales the narrowband inside the soft addition, so it changes how bright the line is without changing its colour. The R/G/B weights change both.
- **Black point** per line. A narrowband image's background level gets added to the RGB background too, as a red (Hα) or teal (OIII) veil. The black point is subtracted first; **Auto** measures it from the image's darkest areas. A starless CS image whose dark areas are already clipped to 0 needs none (NB_ha measures 0).
- **m** as a control: 0.999 is the original soft addition, 0.5 is a plain addition that clips.
- All lines in one pass, as a new image or applied to the target (undoable). An active mask on the target is honoured either way, as PixelMath would.

## Files

```
NarrowbandContinuumSubtraction.js   menu script (tool 1)
BroadbandLineRemoval.js             menu script (tool 2)
StarHoleRepair.js                   menu script (tool 3)
AddNarrowbandToRGB.js               menu script (tool 4)
lib/CTCore.js                       shared: statistics, star photometry, StarX wrapper, preview control, UI helpers
lib/CTRepair.js                     hole detection and repair engine
lib/NBCSEngine.js, NBCSDialog.js    tool 1
lib/BBLREngine.js, BBLRDialog.js    tool 2
lib/SHREngine.js,  SHRDialog.js     tool 3
lib/NBAddEngine.js, NBAddDialog.js  tool 4
tests/                              headless development tests (run_test.ps1 <test> <outdir>); they read the sh2-155 masters
```

Settings (except k, which is always re-measured) are remembered between sessions.
