# Build resources

`icon.ico` (multi-resolution, up to 256×256) and `icon.png` (1024×1024) are the app
icons. electron-builder picks `icon.ico` up automatically from this folder as
configured in `package.json` → `build.win.icon`, and uses `icon.png` for the
Linux/macOS targets.

Both are generated from `logo.png` at the repo root, together with the web favicons
in `apps/*/public/favicon/`. Don't hand-edit them — edit the source logo and re-run:

```
python scripts/generate-icons.py
```
