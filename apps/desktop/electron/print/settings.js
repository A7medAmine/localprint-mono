// Maps the app's print options onto SumatraPDF's -print-settings string.
//
// Why not Chromium's webContents.print options: on Windows the Chromium path
// drops duplexMode / collate / copies for most drivers, so what the shop
// picked in the dialog is not what comes out of the printer. SumatraPDF hands
// these to the Windows spooler as a DEVMODE, which drivers honour.
//
// Token reference (SumatraPDF -print-settings):
//   "1-3,5"            page ranges, 1-based, comma separated
//   "odd" / "even"     page parity filter
//   "3x"               number of copies
//   "color" / "monochrome"
//   "simplex" / "duplex" / "duplexlong" / "duplexshort"
//   "portrait" / "landscape"
//   "noscale" / "shrink" / "fit"
//   "paper=a4"         paper size
//   "bin=2"            paper tray

/** Paper names the app offers -> SumatraPDF paper tokens. */
const PAPER_TOKENS = {
  a4: 'a4',
  a3: 'a3',
  a5: 'a5',
  letter: 'letter',
  legal: 'legal',
  tabloid: 'tabloid',
};

const DUPLEX_TOKENS = {
  simplex: 'simplex',
  longEdge: 'duplexlong',
  shortEdge: 'duplexshort',
};

/**
 * Electron-shaped page ranges ([{ from, to }], 0-based inclusive) -> the
 * 1-based "1-3,5" string SumatraPDF wants. Returns '' when there is nothing
 * to restrict.
 */
export function formatPageRanges(ranges) {
  if (!Array.isArray(ranges) || !ranges.length) return '';
  const parts = [];
  for (const r of ranges) {
    const from = Number(r?.from);
    const to = Number(r?.to);
    if (!Number.isInteger(from) || from < 0) continue;
    const end = Number.isInteger(to) && to >= from ? to : from;
    parts.push(from === end ? `${from + 1}` : `${from + 1}-${end + 1}`);
  }
  return parts.join(',');
}

/**
 * Build the -print-settings value for one job.
 *
 * `options` is the same object the renderer already sends to printFile:
 * { duplexMode, color, copies, collate, landscape, pageSize, pageRanges }.
 *
 * `collate` is deliberately NOT represented here — SumatraPDF has no collate
 * token. An uncollated multi-copy job is instead baked page-by-page into the
 * PDF (see prepare.js) and printed as a single copy, which is why `copies` may
 * arrive already folded in as 1.
 */
export function buildPrintSettings(options = {}) {
  const tokens = [];

  const ranges = formatPageRanges(options.pageRanges);
  if (ranges) tokens.push(ranges);

  const copies = Math.max(1, Math.trunc(Number(options.copies) || 1));
  if (copies > 1) tokens.push(`${copies}x`);

  tokens.push(options.color === false ? 'monochrome' : 'color');

  const duplex = DUPLEX_TOKENS[options.duplexMode] || 'simplex';
  tokens.push(duplex);

  // Only assert orientation when the caller explicitly asked for landscape.
  // Otherwise let the PDF's own page boxes decide — image jobs already build
  // a correctly-oriented page (see prepare.js) and forcing "portrait" here
  // would rotate them back.
  if (options.landscape === true) tokens.push('landscape');

  const paper = PAPER_TOKENS[String(options.pageSize || '').toLowerCase()];
  if (paper) tokens.push(`paper=${paper}`);

  if (options.bin) tokens.push(`bin=${options.bin}`);

  // Scaling: "shrink" keeps oversized pages inside the printable area instead
  // of clipping them — the usual cause of cut-off prints. Callers can override
  // with "noscale" (exact size) or "fit" (scale up to fill).
  const scale = ['noscale', 'shrink', 'fit'].includes(options.scaleMode) ? options.scaleMode : 'shrink';
  tokens.push(scale);

  return tokens.join(',');
}
