#!/usr/bin/env python3
"""Generate every app icon and favicon from the single source logo.

Source of truth is `logo.png` at the repo root: a full-bleed 1254x1254 rounded
square (measured corner radius 290px, i.e. 23.1% of the side) with no alpha
channel, so the corners are baked black. This script re-cuts those corners as
transparency and fans the result out to the sizes each platform wants:

  apps/<app>/public/favicon/   browser favicons + PWA manifest icons
  apps/desktop/build/          electron-builder app icon (icon.ico / icon.png)

Run it again whenever logo.png changes:

  python scripts/generate-icons.py

Requires Pillow (`pip install pillow`).
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "logo.png"

# Corner radius of the artwork as a fraction of the side, measured off the
# source PNG. Keep in sync if the logo's silhouette ever changes.
CORNER_RADIUS_RATIO = 290 / 1254

# Anti-aliasing factor for the corner mask.
SUPERSAMPLE = 8

FAVICON_DIRS = [
    ROOT / "apps" / "desktop" / "public" / "favicon",
    ROOT / "apps" / "online" / "public" / "favicon",
]
BUILD_DIR = ROOT / "apps" / "desktop" / "build"

# Sizes packed into the Windows app icon. 256 is required by electron-builder.
APP_ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

# Browsers never ask a favicon.ico for more than 48px, so the web one stays
# small; the PNG links in index.html cover everything else.
FAVICON_ICO_SIZES = [16, 24, 32, 48]


def rounded_mask(size: int) -> Image.Image:
    """An anti-aliased rounded-square alpha mask for a size x size icon."""
    big = size * SUPERSAMPLE
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, big - 1, big - 1),
        radius=round(big * CORNER_RADIUS_RATIO),
        fill=255,
    )
    return mask.resize((size, size), Image.LANCZOS)


def square(size: int) -> Image.Image:
    """The logo at `size`, opaque, corners still black (for Apple, which
    applies its own mask and renders alpha against black)."""
    return SOURCE_IMAGE.resize((size, size), Image.LANCZOS)


def rounded(size: int) -> Image.Image:
    """The logo at `size` with transparent corners."""
    icon = square(size).convert("RGBA")
    icon.putalpha(rounded_mask(size))
    return icon


SOURCE_IMAGE = Image.open(SOURCE).convert("RGB")


def main() -> None:
    written = []

    for directory in FAVICON_DIRS:
        directory.mkdir(parents=True, exist_ok=True)

        for size in (16, 32):
            path = directory / f"favicon-{size}x{size}.png"
            rounded(size).save(path, optimize=True)
            written.append(path)

        for size in (192, 512):
            path = directory / f"android-chrome-{size}x{size}.png"
            rounded(size).save(path, optimize=True)
            written.append(path)

        # Apple wants a full-bleed opaque square; iOS rounds it itself.
        path = directory / "apple-touch-icon.png"
        square(180).save(path, optimize=True)
        written.append(path)

        path = directory / "favicon.ico"
        rounded(max(FAVICON_ICO_SIZES)).save(
            path, sizes=[(s, s) for s in FAVICON_ICO_SIZES]
        )
        written.append(path)

    BUILD_DIR.mkdir(parents=True, exist_ok=True)

    path = BUILD_DIR / "icon.ico"
    rounded(max(APP_ICO_SIZES)).save(path, sizes=[(s, s) for s in APP_ICO_SIZES])
    written.append(path)

    # electron-builder uses icon.png for the Linux/macOS targets and as the
    # in-app window icon during development.
    path = BUILD_DIR / "icon.png"
    rounded(1024).save(path, optimize=True)
    written.append(path)

    for path in written:
        print(path.relative_to(ROOT).as_posix())


if __name__ == "__main__":
    main()
