"""Builds the PixInsight update repository in repository/, which Cloudflare Pages serves at
https://pixinsight.blastrophoto.com/: a zip for each script set, laid out as PixInsight's own
folders (src/scripts/<name>/...), updates.xri listing them with their SHA-1, and index.html,
the page a person sees at that address.

    uv run --no-project python tools/make_repository.py

PixInsight offers a package it has not installed yet, known by its SHA-1. So a zip whose
contents have not changed is kept as it is (same SHA-1, same release date): a rebuild with
nothing new offers nothing. A script set whose files changed must carry a new version (CT.VERSION
in ContinuumTools/lib/CTCore.js, #define VERSION in SyntheticNBLuminance.js); the build stops
otherwise, before it writes anything.

Signing (once there is a Certified PixInsight Developer identity): sign the scripts first, so
each .xsgn sits beside its .js and goes into the zip with it; run this; then sign
repository/updates.xri in PixInsight (Script > Development > CodeSign) as the last step. A build
that leaves the index's contents alone keeps its signature; one that changes them writes it
unsigned, and says so.
"""

from __future__ import annotations

import hashlib
import html
import io
import re
import sys
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "repository"
URL = "https://pixinsight.blastrophoto.com/"
SOURCE = "https://github.com/blew676/pixinsight-scripts"
ZIP_DATE = (2020, 1, 1, 0, 0, 0)  # every entry the same date, so the bytes depend on contents only
# Until the scripts and the index carry a CPD signature, the page says how to run them unsigned.
SIGNED = False


@dataclass
class Package:
    name: str  # the zip's name and its folder under src/scripts
    title: str
    version_file: str
    version_re: str
    files: list[str]  # globs from the repository's root; a .xsgn beside a script comes along
    strip: str  # taken off the front of each path before src/scripts/<name>/
    pi_versions: str  # the PixInsight versions it runs on, "from:to"
    menu: str
    paragraphs: list[str]


PACKAGES = [
    Package(
        name="ContinuumTools",
        title="ContinuumTools",
        version_file="ContinuumTools/lib/CTCore.js",
        version_re=r'CT\.VERSION\s*=\s*"([^"]+)"',
        files=["ContinuumTools/*.js", "ContinuumTools/lib/*.js"],
        strip="ContinuumTools/",
        pi_versions="1.9.4:9.9.9",
        menu="Script › ContinuumTools",
        paragraphs=[
            "Narrowband Continuum Subtraction takes the continuum out of Hα, OIII or SII "
            "without leaving black star holes. Broadband Line Removal takes the emission-line "
            "light out of R, G and B, leaving dust, reflection nebulae and stars. Star Hole "
            "Repair fills the dark holes that over-subtracted stars left in an existing image. "
            "Add Narrowband to RGB blends stretched Hα, OIII and SII into a stretched RGB image "
            "with a soft addition that never clips.",
            "Needs PixInsight 1.9.4 or later. StarXTerminator (RC Astro), when it is installed, "
            "makes the starless copies.",
        ],
    ),
    Package(
        name="SyntheticNBLuminance",
        title="Synthetic NB Luminance",
        version_file="SyntheticNBLuminance.js",
        version_re=r'#define\s+VERSION\s+"([^"]+)"',
        files=["SyntheticNBLuminance.js"],
        strip="",
        pi_versions="1.8.9:9.9.9",
        menu="Script › Utilities",
        paragraphs=[
            "Combines two or more registered narrowband masters into one luminance master, "
            "weighting each pixel by where each filter really has signal, so faint Hα is not "
            "diluted by empty OIII and faint OIII is not buried by bright Hα.",
            "Run it on linear, registered, identically cropped masters.",
        ],
    ),
]


class Stop(Exception):
    pass


def version_of(pkg: Package) -> str:
    text = (ROOT / pkg.version_file).read_text(encoding="utf-8")
    m = re.search(pkg.version_re, text)
    if not m:
        raise Stop(f"{pkg.name}: no version found in {pkg.version_file}")
    return m.group(1)


def contents_of(pkg: Package) -> dict[str, bytes]:
    """The zip's files: archive path -> bytes."""
    found: dict[str, bytes] = {}
    for pattern in pkg.files:
        for path in sorted(ROOT.glob(pattern)):
            sources = [path]
            sig = path.with_suffix(".xsgn")
            if sig.exists():
                if sig.stat().st_mtime < path.stat().st_mtime:
                    print(f"  warning: {sig.relative_to(ROOT)} is older than its script: sign it again")
                sources.append(sig)
            for src in sources:
                rel = src.relative_to(ROOT).as_posix()
                if not rel.startswith(pkg.strip):
                    raise Stop(f"{pkg.name}: {rel} is outside {pkg.strip}")
                found[f"src/scripts/{pkg.name}/{rel[len(pkg.strip) :]}"] = src.read_bytes()
    if not found:
        raise Stop(f"{pkg.name}: no files")
    return found


def make_zip(files: dict[str, bytes]) -> bytes:
    folders = set()
    for name in files:
        parts = name.split("/")[:-1]
        for i in range(1, len(parts) + 1):
            folders.add("/".join(parts[:i]) + "/")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name in sorted(folders):
            info = zipfile.ZipInfo(name, ZIP_DATE)
            info.external_attr = (0o40755 << 16) | 0x10
            z.writestr(info, b"")
        for name in sorted(files):
            info = zipfile.ZipInfo(name, ZIP_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            z.writestr(info, files[name], compresslevel=9)
    return buf.getvalue()


def read_zip(path: Path) -> dict[str, bytes]:
    with zipfile.ZipFile(path) as z:
        return {i.filename: z.read(i) for i in z.infolist() if not i.is_dir()}


def old_index() -> tuple[str, str]:
    """The index now in repository/: its body (before any signature) and the whole file."""
    path = OUT / "updates.xri"
    if not path.exists():
        return "", ""
    whole = path.read_text(encoding="utf-8")
    end = whole.find("</xri>")
    return (whole[: end + len("</xri>")] + "\n" if end >= 0 else whole), whole


def release_dates(body: str) -> dict[str, str]:
    return dict(re.findall(r'<package fileName="([^"]+)" sha1="[0-9a-f]+" type="script" releaseDate="(\d+)"', body))


def text(s: str) -> str:
    return html.escape(s, quote=False)


def index_xri(entries: list[dict]) -> str:
    out = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<xri version="1.0">',
        "   <description>",
        f"      <p>Free PixInsight scripts by Blastrophoto. Sources and notes: {text(SOURCE)}</p>",
        "   </description>",
    ]
    for e in entries:
        pkg = e["pkg"]
        out += [
            f'   <platform os="all" arch="noarch" version="{pkg.pi_versions}">',
            f'      <package fileName="{e["file"]}" sha1="{e["sha1"]}" type="script" releaseDate="{e["date"]}">',
            f"         <title>{text(pkg.title)} {text(e['version'])}</title>",
            "         <description>",
            f"            <p>Under {text(pkg.menu)}.</p>",
            *(f"            <p>{text(p)}</p>" for p in pkg.paragraphs),
            "         </description>",
            "      </package>",
            "   </platform>",
        ]
    out.append("</xri>")
    return "\n".join(out) + "\n"


def index_html(entries: list[dict]) -> str:
    tools = []
    for e in entries:
        pkg, d = e["pkg"], e["date"]
        when = f"{d[:4]}-{d[4:6]}-{d[6:8]}"
        tools.append(
            '    <article class="tool">\n'
            f'      <h3>{text(pkg.title)} <span class="ver">{text(e["version"])}</span></h3>\n'
            f'      <p class="where">{text(pkg.menu)} · released {when}</p>\n'
            + "".join(f"      <p>{text(p)}</p>\n" for p in pkg.paragraphs)
            + "    </article>"
        )
    unsigned = (
        ""
        if SIGNED
        else """
    <div class="note">
      <p><strong>Not signed yet.</strong> The scripts are waiting for their PixInsight developer
      signature. Until then PixInsight may warn that the repository is not signed when it checks
      for updates: accept to go on. If a script then will not run, tick <strong>Allow execution
      of unsigned scripts</strong> under <strong>Edit › Preferences › Security</strong>.</p>
    </div>
"""
    )
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PixInsight scripts · Blastrophoto</title>
<meta name="description" content="Free PixInsight scripts by Blastrophoto, installed and kept up to date by PixInsight itself.">
<link rel="icon" href="icon-32.png" type="image/png" sizes="32x32">
<link rel="stylesheet" href="style.css">
</head>
<body>
<header class="top">
  <a class="brand" href="https://blastrophoto.com/"><img src="logo.png" alt="Blastrophoto" width="233" height="40"></a>
</header>
<main>
  <section class="intro">
    <p class="eyebrow">PixInsight repository</p>
    <h1>PixInsight scripts</h1>
    <p class="lead">Free scripts for PixInsight, installed and kept up to date by PixInsight itself.</p>
  </section>
  <section>
    <h2>Add the repository</h2>
    <ol class="steps">
      <li>In PixInsight, open <strong>Resources › Updates › Manage Repositories</strong>.</li>
      <li>Press <strong>Add</strong>, enter this address and press <strong>OK</strong>:
        <code class="url">{text(URL)}</code></li>
      <li>Open <strong>Resources › Updates › Check for Updates</strong>, apply the updates and let
        PixInsight restart. The scripts appear in the Script menu.</li>
    </ol>
    <p>From then on, <strong>Check for Updates</strong> brings each new version.</p>
{unsigned}  </section>
  <section>
    <h2>The scripts</h2>
{chr(10).join(tools)}
  </section>
  <section class="small">
    <p>The scripts make no network connections and start no other programs. Their sources, notes
    and history are on <a href="{text(SOURCE)}">GitHub</a>.</p>
  </section>
</main>
<footer class="foot">
  <a href="https://blastrophoto.com/">blastrophoto.com</a>
</footer>
</body>
</html>
"""


def write(path: Path, data: str | bytes) -> bool:
    """Writes only when the contents differ; says whether it wrote."""
    raw = data.encode("utf-8") if isinstance(data, str) else data
    if path.exists() and path.read_bytes() == raw:
        return False
    path.write_bytes(raw)
    return True


def build() -> int:
    OUT.mkdir(exist_ok=True)
    body, whole = old_index()
    dates = release_dates(body)
    today = datetime.now(timezone.utc).strftime("%Y%m%d")
    entries, new_zips, old_zips = [], {}, []
    for pkg in PACKAGES:  # every check before anything is written
        version = version_of(pkg)
        files = contents_of(pkg)
        name = f"{pkg.name}-{version}.zip"
        target = OUT / name
        if target.exists():
            if read_zip(target) != files:
                raise Stop(f"{pkg.name} changed but is still version {version}: raise its version first")
            data, date, state = target.read_bytes(), dates.get(name, today), "unchanged"
        else:
            data, date, state = make_zip(files), today, "new"
            new_zips[target] = data
        old_zips += [p for p in OUT.glob(f"{pkg.name}-*.zip") if p.name != name]
        sha1 = hashlib.sha1(data).hexdigest()
        entries.append({"pkg": pkg, "version": version, "file": name, "sha1": sha1, "date": date})
        count = f"{len(files)} file" + ("s" if len(files) != 1 else "")
        print(f"{pkg.title} {version}: {state} ({count}, sha1 {sha1[:12]})")

    for path, data in new_zips.items():
        path.write_bytes(data)
    for path in old_zips:
        path.unlink()
        print(f"removed {path.name} (an older version)")
    xri = index_xri(entries)
    if xri == body:
        print("updates.xri unchanged" + (" (its signature kept)" if whole != body else ""))
    else:
        write(OUT / "updates.xri", xri)
        print("updates.xri written, UNSIGNED" + ("" if SIGNED else " (as planned until the CPD identity)"))
    if write(OUT / "index.html", index_html(entries)):
        print("index.html written")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(build())
    except Stop as exc:
        print(f"Stopped: {exc}. Nothing was written.")
        sys.exit(1)
