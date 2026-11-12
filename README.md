# PixInsight scripts by Blastrophoto

Free scripts for PixInsight, served as a PixInsight update repository at
**https://pixinsight.blastrophoto.com/**, so PixInsight installs them and keeps them up to date.

## Install

1. In PixInsight, open **Resources › Updates › Manage Repositories**.
2. Press **Add**, enter `https://pixinsight.blastrophoto.com/` and press **OK**.
3. Open **Resources › Updates › Check for Updates**, apply the updates and let PixInsight restart.

The scripts are not signed yet. Until they are, PixInsight may warn that the repository is not
signed: accept to go on. If a script then will not run, tick **Allow execution of unsigned
scripts** under **Edit › Preferences › Security**.

## The scripts

| Script | Menu | What it does |
|---|---|---|
| [ContinuumTools](ContinuumTools/README.md) | Script › ContinuumTools | Narrowband Continuum Subtraction, Broadband Line Removal and Star Hole Repair: continuum subtraction without black star holes, emission-line light taken out of R, G and B, and holes in older results filled. PixInsight 1.9.4 or later. |
| Synthetic NB Luminance | Script › Utilities | Combines two or more registered narrowband masters into one luminance master, weighting each pixel by where each filter really has signal. The method is in the script's opening comment. |

## What the scripts touch

- **Network:** none. They make no connections.
- **Other programs:** none started. ContinuumTools runs StarXTerminator, RC Astro's PixInsight
  process, when it is installed, to make starless copies.
- **Storage:** ContinuumTools remembers its dialogs' settings in PixInsight's own settings,
  under `ContinuumTools/`. Neither writes files: results open as new images, saved only by you.

## Making a release

1. Change a script and raise its version: `CT.VERSION` in `ContinuumTools/lib/CTCore.js`,
   `#define VERSION` in `SyntheticNBLuminance.js`. The build stops if contents change without it.
2. Optional: `node tools/check_syntax.js ContinuumTools/*.js ContinuumTools/lib/*.js SyntheticNBLuminance.js`
   compiles every script with V8, PixInsight 1.9.4's engine.
3. `uv run --no-project python tools/make_repository.py` writes `repository/`: a zip for each
   script set, `updates.xri` (the index PixInsight reads) and `index.html`.
4. Once there is a signing identity: sign `repository/updates.xri` in PixInsight
   (**Script › Development › CodeSign**), always as the last step.
5. Commit and push. Cloudflare Pages publishes `repository/` within a minute or two.

## Layout

- `ContinuumTools/`, `SyntheticNBLuminance.js`: the scripts. `ContinuumTools/tests/` is for
  development (headless PixInsight runs on real masters) and is not released.
- `tools/make_repository.py`: builds `repository/`. Its docstring has the rules.
- `repository/`: what Cloudflare Pages serves (project `pixinsight-scripts`, no build command,
  output directory `repository`, custom domain `pixinsight.blastrophoto.com`).

## Signing

PixInsight trusts a signature made with a Certified PixInsight Developer identity. Until there
is one the scripts and the index are published unsigned. With one: the scripts are signed in
place (each `.xsgn` beside its `.js` goes into the zip with it), then the index. The keys file
(`.xssk`) and its password never go into this repository; `.gitignore` refuses it.
