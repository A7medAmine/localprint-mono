# Print engine binary

`SumatraPDF.exe` lives here and is what actually spools print jobs on Windows
(see `electron/print/spooler.js`). It is **not committed** — it is ~16MB and
GPLv3-licensed. `scripts/fetch-sumatrapdf.js` downloads and checksum-verifies
it on `postinstall` and before every `electron:build` / `electron:release`, and
electron-builder copies this folder to `resources/print` in the packaged app.

Fetch it manually with:

```
node scripts/fetch-sumatrapdf.js --force
```

If the binary is missing the app still prints — it falls back to the old
Chromium `webContents.print()` engine — but copies, duplex and paper size are
unreliable on that path.

SumatraPDF is GPLv3; it is invoked as a separate, unmodified executable.
Upstream source and licence: https://github.com/sumatrapdfreader/sumatrapdf
