// Renders a ResearchDocument to a self-contained HTML document, same shape as
// cvDocument.ts: one module that returns a complete HTML string with an
// inline <style>, fed either to renderHtmlPdf (Electron, print path) or to a
// preview iframe.
//
// Architecture note (deviates from a literal reading of the phase-4 spec —
// see the report handed back with this change for the full reasoning):
// the spec's prose says to "read the font files" / "read [images] from
// UPLOADS_DIR" and "reuse sharp" for the inlineFonts:true path. That reads as
// Node fs + sharp. But this file lives under components/ and is bundled by
// Vite into the renderer, and the print window is created with
// `nodeIntegration: false` (see electron/main.js) — a components/*.ts module
// cannot import "fs" or "sharp" and run in that context at all. cvDocument.ts
// itself confirms the real pattern: it never touches fs — CvDocumentProps
// takes `photoDataUrl` already resolved to a data: URL by its caller, and
// (this is the thing the spec explicitly asked to verify) its @font-face
// rules use plain app-relative URLs (`url('/Inter.ttf')`) unconditionally,
// even though preload.js's own comment on renderHtmlPdf says the document
// must be self-contained because it's rendered from a tmp file where
// app-relative URLs do not resolve. In other words: the CV tool's print path
// currently prints with fonts falling back to whatever face Chromium's PDF
// engine substitutes, silently. That is exactly the bug phase 4 was told not
// to repeat.
//
// So instead of Node fs/sharp, this module inlines fonts and images itself
// using browser-native equivalents that work from inside the renderer for
// real self-containment: `fetch` + base64 for font bytes (mirrors fs.readFile
// + toString('base64')), and `fetch` + <canvas> downscale + toDataURL for
// images (mirrors sharp's resize+re-encode — same purpose, same ~1600px
// long-edge target, done the way ImageEditor.tsx already does pixel work in
// this app: Canvas, not a native image library). Both fonts and images are
// reachable from the renderer's own origin (fonts via the static /public
// route express.static(PUBLIC_DIR) already serves cvDocument.ts's fonts
// from; images via the existing
// GET /api/research/:id/images/:imageId/file route), so no new server
// plumbing is needed for this phase.
import type {
  ResearchDocument,
  ResearchImage,
  ResearchLanguage,
  ResearchSection,
  ResearchTypography,
} from "../types";

// ---------------------------------------------------------------------------
// Escaping & bidi-aware inline text
// ---------------------------------------------------------------------------

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string),
  );

// A character that itself carries Latin-script identity — used to decide
// whether a run found below is worth isolating at all.
const LATIN_CHAR = /[A-Za-zÀ-ÖØ-öø-ÿ]/;

// Characters a Latin "run" is allowed to extend through once it has started:
// the Latin letters themselves, digits, and the punctuation that commonly
// glues a parenthesised technical term or a quoted title together. Spaces are
// handled separately below so a run can span "Les Misérables" but a *trailing*
// space never gets pulled into the span (it has to stay outside so it
// separates correctly from the surrounding Arabic/French text).
const LATIN_RUN_CHAR = /[A-Za-zÀ-ÖØ-öø-ÿ0-9%.,'’()\-–—:/&+]/;

/**
 * Escapes `text` for HTML and wraps runs of Latin-script content (plus their
 * immediately attached digits/punctuation, e.g. a parenthesised acronym or a
 * quoted French title) in `<span dir="ltr">`. This is the "twenty lines" the
 * phase-4 spec asks for: the model is told (phase 2) to put technical terms
 * in parentheses at first use, and parenthesised Latin embedded in an Arabic
 * sentence is exactly the case the Unicode Bidi Algorithm gets wrong without
 * an explicit directional override.
 *
 * Runs made of *only* digits/punctuation (a percentage, a date range) are
 * deliberately left unwrapped — they contain no Latin letters, so there is
 * nothing whose script identity needs asserting, and the paragraph's own
 * `unicode-bidi: plaintext` plus the Bidi Algorithm's native handling of
 * European Numbers already places them correctly. Wrapping every number
 * would just be span noise.
 */
export function renderInlineText(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (LATIN_RUN_CHAR.test(ch)) {
      let j = i + 1;
      while (j < n && (LATIN_RUN_CHAR.test(text[j]) || text[j] === " ")) j++;
      // Trim trailing spaces back out of the run so they stay outside the span.
      let end = j;
      while (end > i && text[end - 1] === " ") end--;
      const run = text.slice(i, end);
      const trailingSpace = text.slice(end, j);
      out += LATIN_CHAR.test(run) ? `<span dir="ltr">${escapeHtml(run)}</span>` : escapeHtml(run);
      out += escapeHtml(trailingSpace);
      i = j;
    } else {
      out += escapeHtml(ch);
      i++;
    }
  }
  return out;
}

// Multi-line free text (section body, intro, conclusion) -> one <p> per
// non-empty line, each independently bidi-resolved.
const paragraphsHtml = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p class="bidi-block" dir="auto">${renderInlineText(line)}</p>`)
    .join("");

// ---------------------------------------------------------------------------
// Localized labels
// ---------------------------------------------------------------------------

type LabelKey =
  | "toc" | "introduction" | "conclusion" | "sources"
  | "subject" | "student" | "year" | "teacher";

const LABELS: Record<LabelKey, Record<ResearchLanguage, string>> = {
  toc: { ar: "فهرس المحتويات", en: "Table of Contents", fr: "Table des matières" },
  introduction: { ar: "مقدمة", en: "Introduction", fr: "Introduction" },
  conclusion: { ar: "خاتمة", en: "Conclusion", fr: "Conclusion" },
  sources: { ar: "المراجع", en: "References", fr: "Références" },
  subject: { ar: "المادة", en: "Subject", fr: "Matière" },
  student: { ar: "الطالب(ة)", en: "Student", fr: "Élève" },
  year: { ar: "السنة الدراسية", en: "School year", fr: "Année scolaire" },
  teacher: { ar: "الأستاذ(ة)", en: "Teacher", fr: "Enseignant(e)" },
};

const L = (key: LabelKey, lang: ResearchLanguage) => LABELS[key][lang];

// Section headings' numeral style. Arabic documents *can* use Arabic-Indic
// digits (١، ٢، ٣) in headings while keeping Western digits for in-body
// statistics (per the spec) — flip this one constant if the shop wants that.
const ARABIC_INDIC_HEADING_NUMERALS = false;
const ARABIC_INDIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

function sectionNumberLabel(n: number, lang: ResearchLanguage): string {
  if (ARABIC_INDIC_HEADING_NUMERALS && lang === "ar") {
    return String(n)
      .split("")
      .map((d) => ARABIC_INDIC_DIGITS[Number(d)] ?? d)
      .join("");
  }
  return String(n);
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

interface FontFile {
  family: string;
  publicPath: string;
}

const INTER: FontFile = { family: "ResearchInter", publicPath: "/Inter.ttf" };
const RUBIK: FontFile = { family: "ResearchRubik", publicPath: "/Rubik.ttf" };
const ROBOTO_SLAB: FontFile = { family: "ResearchRobotoSlab", publicPath: "/RobotoSlab.ttf" };
const IBM_PLEX_ARABIC: FontFile = { family: "ResearchIBMPlexArabic", publicPath: "/IBMPlexArabic-Text.ttf" };

// Only two font files are ever loaded per document (Latin + Arabic face for
// the chosen family) — not all four — to keep the inlined print document
// small. Note: `apps/desktop/Alhurra.ttf` exists on disk (confirmed) but
// lives at the app root, not under public/, so express.static(PUBLIC_DIR)
// never serves it and it has no app-relative URL to fetch; it also isn't
// named in the phase-4 spec's actual family-mapping table (only Inter,
// Rubik, RobotoSlab and IBM Plex Arabic are mapped there). Left unwired —
// flagged in the handoff report as a possible follow-up (move it into
// public/ and use it for "naskh") rather than guessed at here.
const FONT_PAIRS: Record<ResearchTypography["fontFamily"], [FontFile, FontFile]> = {
  sans: [INTER, RUBIK],
  serif: [ROBOTO_SLAB, IBM_PLEX_ARABIC],
  naskh: [IBM_PLEX_ARABIC, INTER],
};

const FONT_STACKS: Record<ResearchTypography["fontFamily"], string> = {
  sans: "'ResearchInter','ResearchRubik','Segoe UI',Arial,sans-serif",
  serif: "'ResearchRobotoSlab','ResearchIBMPlexArabic',Georgia,'Times New Roman',serif",
  naskh: "'ResearchIBMPlexArabic','ResearchInter','Segoe UI',Arial,sans-serif",
};

function fontFaceCss(family: string, src: string): string {
  // No `format()` hint: the two families in play (variable Inter/Rubik vs.
  // static RobotoSlab/IBM Plex Arabic) don't share one, and browsers sniff
  // the binary fine without it — same reasoning as omitting it entirely
  // rather than copying cvDocument.ts's format('truetype-variations') onto
  // fonts that aren't variable fonts.
  return `@font-face{font-family:'${family}';src:url('${src}');font-display:block}`;
}

async function arrayBufferToBase64(buf: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}

async function fetchFontDataUrl(publicPath: string): Promise<string> {
  const res = await fetch(publicPath);
  if (!res.ok) throw new Error(`Failed to fetch font ${publicPath}: ${res.status}`);
  const base64 = await arrayBufferToBase64(await res.arrayBuffer());
  return `data:font/ttf;base64,${base64}`;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

const IMAGE_MAX_LONG_EDGE = 1600;

function imageFileUrl(paperId: string, imageId: string): string {
  return `/api/research/${encodeURIComponent(paperId)}/images/${encodeURIComponent(imageId)}/file`;
}

/**
 * Fetches an image, downscales it to ~1600px on the long edge via canvas
 * (the browser-native equivalent of imageFetch.js's sharp .resize()) and
 * returns a base64 JPEG data URL. Images already max out at 2000px from
 * phase 3's own download-time cap, so this is usually a modest trim, not a
 * heavy resize — same reasoning as sharp being "more than enough at A4".
 */
async function fetchImageDataUrl(url: string): Promise<string> {
  // The image-file route requires admin auth — same reasoning as
  // storageService.fetchResearchImageDataUrl's preview-iframe fetch.
  const token = localStorage.getItem("ps_admin_token");
  const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  if (!res.ok) throw new Error(`Failed to fetch image ${url}: ${res.status}`);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const longEdge = Math.max(bitmap.width, bitmap.height);
    const scale = longEdge > IMAGE_MAX_LONG_EDGE ? IMAGE_MAX_LONG_EDGE / longEdge : 1;
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    ctx.drawImage(bitmap, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.88);
  } finally {
    bitmap.close?.();
  }
}

interface ResolvedImage extends ResearchImage {
  src: string;
}

// ---------------------------------------------------------------------------
// Document structure
// ---------------------------------------------------------------------------

function coverRow(label: string, value: string): string {
  return `<div class="cover-row bidi-block" dir="auto"><span class="cover-label">${escapeHtml(label)}</span><span class="cover-value">${renderInlineText(value)}</span></div>`;
}

function coverPageHtml(doc: ResearchDocument, title: string, dir: string): string {
  const top = [
    doc.subject ? `<div class="cover-line bidi-block" dir="auto">${renderInlineText(doc.subject)}</div>` : "",
    doc.schoolName ? `<div class="cover-line bidi-block" dir="auto">${renderInlineText(doc.schoolName)}</div>` : "",
  ]
    .filter(Boolean)
    .join("");

  const bottom = [
    doc.studentName ? coverRow(L("student", doc.language), doc.studentName) : "",
    doc.schoolYear ? coverRow(L("year", doc.language), doc.schoolYear) : "",
    doc.teacherName ? coverRow(L("teacher", doc.language), doc.teacherName) : "",
  ]
    .filter(Boolean)
    .join("");

  return `<section class="page cover-page" dir="${dir}">
    <div class="cover-top">${top}</div>
    <h1 class="cover-title bidi-block" dir="auto">${renderInlineText(title)}</h1>
    <div class="cover-bottom">${bottom}</div>
  </section>`;
}

// Table of contents — deliberately rendered WITHOUT page numbers.
//
// Decision (per the spec's explicit either/or): computing real page numbers
// needs a measuring pass, and the only measuring pass this module has
// (estimatePageCount, below) measures whole-document height against one
// A4 page's rendered height — it has no way to know which physical page a
// given heading lands on without a second full render pass keyed off DOM
// element offsets *inside* the exact same font/asset context the final
// print will use. Building that reliably (matching Chromium's print
// pagination, not just on-screen flow height, since the .page geometry here
// is a single flowing box per spec, not one container per physical page)
// is real complexity for a phase whose own scope is "the HTML builder
// module", and getting it wrong prints a *wrong* number, which the spec
// explicitly calls worse than no number ("a teacher will notice"). No
// numbers is the simpler, unconditionally-correct choice, so that's what
// this renders — a numbered list of section titles only.
function tocPageHtml(doc: ResearchDocument, dir: string): string {
  const items: string[] = [L("introduction", doc.language)];
  doc.sections.forEach((s, i) => {
    items.push(`${sectionNumberLabel(i + 1, doc.language)}. ${s.heading}`);
  });
  items.push(L("conclusion", doc.language));
  if (doc.sources.length) items.push(L("sources", doc.language));

  return `<section class="page toc-page" dir="${dir}">
    <h2 class="toc-title bidi-block" dir="auto">${escapeHtml(L("toc", doc.language))}</h2>
    <ol class="toc-list">
      ${items.map((item) => `<li class="bidi-block" dir="auto">${renderInlineText(item)}</li>`).join("")}
    </ol>
  </section>`;
}

function figuresHtml(images: ResolvedImage[]): string {
  if (!images.length) return "";
  const countClass = images.length === 1 ? "count-1" : images.length === 2 ? "count-2" : "count-grid";
  return `<div class="figures ${countClass}">
    ${images
      .map(
        (img) => `<figure>
      <img src="${escapeHtml(img.src)}" alt=""/>
      ${img.caption ? `<figcaption class="bidi-block" dir="auto">${renderInlineText(img.caption)}</figcaption>` : ""}
    </figure>`,
      )
      .join("")}
  </div>`;
}

function sectionHtml(section: ResearchSection, index: number, lang: ResearchLanguage, imagesById: Map<string, ResolvedImage>, numbered: boolean): string {
  const images = section.imageIds.map((id) => imagesById.get(id)).filter((img): img is ResolvedImage => !!img);
  const heading = numbered ? `${sectionNumberLabel(index, lang)}. ${renderInlineText(section.heading)}` : renderInlineText(section.heading);
  return `<section class="content-block section-block">
    <h2 class="bidi-block" dir="auto">${heading}</h2>
    ${paragraphsHtml(section.body)}
    ${figuresHtml(images)}
  </section>`;
}

function contentPageHtml(doc: ResearchDocument, dir: string, imagesById: Map<string, ResolvedImage>, numberedSections: boolean): string {
  const parts: string[] = [];

  if (doc.introduction.trim()) {
    parts.push(`<section class="content-block">
      <h2 class="bidi-block" dir="auto">${escapeHtml(L("introduction", doc.language))}</h2>
      ${paragraphsHtml(doc.introduction)}
    </section>`);
  }

  doc.sections.forEach((s, i) => parts.push(sectionHtml(s, i + 1, doc.language, imagesById, numberedSections)));

  if (doc.conclusion.trim()) {
    parts.push(`<section class="content-block">
      <h2 class="bidi-block" dir="auto">${escapeHtml(L("conclusion", doc.language))}</h2>
      ${paragraphsHtml(doc.conclusion)}
    </section>`);
  }

  if (doc.sources.length) {
    parts.push(`<section class="content-block">
      <h2 class="bidi-block" dir="auto">${escapeHtml(L("sources", doc.language))}</h2>
      <ol class="sources-list">
        ${doc.sources.map((src) => `<li class="bidi-block" dir="auto">${renderInlineText(src)}</li>`).join("")}
      </ol>
    </section>`);
  }

  // Document-level images (not attached to any section) — last thing in the
  // paper, after conclusion/sources. Otherwise these never make it into the
  // rendered/printed output at all, only into imagesById, which sectionHtml
  // only reads via each section's own imageIds.
  const assignedIds = new Set(doc.sections.flatMap((s) => s.imageIds));
  const unassigned = doc.images.filter((img) => !assignedIds.has(img.id)).map((img) => imagesById.get(img.id)).filter((img): img is ResolvedImage => !!img);
  if (unassigned.length) {
    parts.push(`<section class="content-block">${figuresHtml(unassigned)}</section>`);
  }

  return `<section class="page content-page" dir="${dir}">${parts.join("")}</section>`;
}

function buildDocumentInner(doc: ResearchDocument, title: string, imagesById: Map<string, ResolvedImage>): string {
  // Base direction lives on each `.page`, never on <html> — see the module
  // doc-comment / handoff report for why a single html-level dir is wrong
  // for a mixed-language paper. Every block element below additionally
  // carries its own `dir="auto"` so it resolves independently off its own
  // first strong character.
  const dir = doc.language === "ar" ? "rtl" : "ltr";
  const simple = doc.typography.mode === "simple";
  const pages = [
    !simple && doc.typography.showCoverPage !== false ? coverPageHtml(doc, title, dir) : "",
    !simple && doc.typography.showToc !== false ? tocPageHtml(doc, dir) : "",
    contentPageHtml(doc, dir, imagesById, !simple),
  ];
  return pages.join("");
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

// Top margin is deliberately larger than the other three in every preset —
// room for binding and teacher notes, same reasoning as the original fixed
// 25mm/20mm split this replaces.
const MARGIN_PRESETS: Record<NonNullable<ResearchTypography["margin"]>, { top: number; side: number; bottom: number }> = {
  none: { top: 10, side: 8, bottom: 8 },
  narrow: { top: 18, side: 14, bottom: 14 },
  default: { top: 25, side: 20, bottom: 20 },
  large: { top: 35, side: 30, bottom: 30 },
};

// Figure width as a % of the page's content box, for a section with exactly
// one / exactly two images; count-grid (3+) instead varies its column count.
const IMAGE_SIZE_PRESETS: Record<NonNullable<ResearchTypography["imageSize"]>, { single: number; double: number; gridCols: number }> = {
  small: { single: 45, double: 32, gridCols: 3 },
  default: { single: 70, double: 48, gridCols: 2 },
  large: { single: 92, double: 68, gridCols: 2 },
};

function buildCss(typography: ResearchTypography, fontFaces: string): string {
  const fontStack = FONT_STACKS[typography.fontFamily];
  const margin = MARGIN_PRESETS[typography.mode === "simple" ? "default" : typography.margin ?? "default"];
  const imageSize = IMAGE_SIZE_PRESETS[typography.imageSize ?? "default"];
  return `
${fontFaces}

*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#fff;color:#1f2937;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:${fontStack};-webkit-font-smoothing:antialiased}

@page{size:A4;margin:0}
.page{
  width:210mm;
  min-height:297mm;
  padding:${margin.top}mm ${margin.side}mm ${margin.bottom}mm ${margin.side}mm;
  box-sizing:border-box;
  break-after:page;
  --research-font-size:${typography.fontSize}pt;
  --research-line-height:${typography.lineHeight};
  --research-font-family:${fontStack};
  font-size:var(--research-font-size);
  line-height:var(--research-line-height);
  font-family:var(--research-font-family);
}
.page:last-child{break-after:auto}

/* Arabic needs more leading than Latin at the same point size. :dir(rtl)
   matches the *resolved* direction of a dir="auto" element, so this applies
   per-block in a mixed-language paper — an embedded French paragraph inside
   an Arabic section keeps the base line-height, only the Arabic blocks
   around it get the bump. */
.page :dir(rtl){line-height:calc(var(--research-line-height) + 0.15)}

h1,h2,h3{break-after:avoid}
.bidi-block{unicode-bidi:plaintext}
p{text-align:start}

.cover-page{display:flex;flex-direction:column;justify-content:space-between;align-items:center;text-align:center}
.cover-top{font-size:calc(var(--research-font-size) * 1.1);display:flex;flex-direction:column;gap:2mm}
.cover-title{font-size:calc(var(--research-font-size) * 2.6);font-weight:800;margin-block:20mm;max-width:150mm}
.cover-bottom{width:100%;display:flex;flex-direction:column;gap:3mm;font-size:calc(var(--research-font-size) * 1.05)}
.cover-row{display:flex;gap:2mm;justify-content:center}
.cover-label{font-weight:700}

.toc-title{font-size:calc(var(--research-font-size) * 1.6);font-weight:800;margin-block-end:8mm;text-align:start}
.toc-list{list-style:none;display:flex;flex-direction:column;gap:2.5mm}
.toc-list li{font-size:calc(var(--research-font-size) * 1.05)}

.content-block{margin-block-end:8mm}
.content-block h2{font-size:calc(var(--research-font-size) * 1.35);font-weight:800;margin-block-end:4mm;text-align:start}
.content-block p{margin-block-end:calc(var(--research-font-size) * 0.6)}

.sources-list{padding-inline-start:6mm}
.sources-list li{margin-block-end:1.5mm}

.figures{display:flex;flex-wrap:wrap;gap:4mm;justify-content:center;margin-block-start:4mm;break-inside:avoid}
.figures figure{break-inside:avoid;margin:0}
.figures.count-1 figure{width:${imageSize.single}%}
.figures.count-2 figure{width:${imageSize.double}%}
.figures.count-grid{display:grid;grid-template-columns:repeat(${imageSize.gridCols}, 1fr);width:100%}
.figures.count-grid figure{width:auto}
.figures img{width:100%;display:block;border-radius:1mm;object-fit:cover}
.figures figcaption{margin-block-start:1.5mm;font-size:calc(var(--research-font-size) * 0.78);line-height:1.3;text-align:center;color:#4b5563}
`;
}

// ---------------------------------------------------------------------------
// Public API — buildResearchHtml
// ---------------------------------------------------------------------------

export interface BuildResearchHtmlProps {
  doc: ResearchDocument;
  /**
   * Cover-page / <title> text. ResearchDocument itself carries no title
   * field — it lives on the ResearchPaper row that wraps it (see
   * ResearchPaper.title in types.ts, the same split CvProfile uses for
   * fullName vs. CvDocument). Callers pass `paper.title`.
   */
  title: string;
  /**
   * The owning ResearchPaper's id, needed to build each image's
   * GET /api/research/:id/images/:imageId/file URL. Required whenever
   * doc.images is non-empty; harmless to omit otherwise.
   */
  paperId: string;
  /** false = preview iframe (app-relative font URLs, direct image API URLs). true = renderHtmlPdf print path — fonts and images inlined as base64 data URLs so the document is self-contained when rendered from a tmp file. */
  inlineFonts: boolean;
}

export async function buildResearchHtml({ doc, title, paperId, inlineFonts }: BuildResearchHtmlProps): Promise<string> {
  const pair = FONT_PAIRS[doc.typography.fontFamily];

  let fontFaces: string;
  if (inlineFonts) {
    const dataUrls = await Promise.all(pair.map((f) => fetchFontDataUrl(f.publicPath)));
    fontFaces = pair.map((f, i) => fontFaceCss(f.family, dataUrls[i])).join("\n");
  } else {
    fontFaces = pair.map((f) => fontFaceCss(f.family, f.publicPath)).join("\n");
  }

  const imagesById = new Map<string, ResolvedImage>();
  if (inlineFonts) {
    const resolved = await Promise.all(
      doc.images.map(async (img) => {
        const src = await fetchImageDataUrl(imageFileUrl(paperId, img.id));
        return [img.id, { ...img, src }] as const;
      }),
    );
    resolved.forEach(([id, img]) => imagesById.set(id, img));
  } else {
    doc.images.forEach((img) => imagesById.set(img.id, { ...img, src: imageFileUrl(paperId, img.id) }));
  }

  const inner = buildDocumentInner(doc, title, imagesById);
  const css = buildCss(doc.typography, fontFaces);

  // Preview only (inlineFonts:false covers both the live preview iframe and
  // the offscreen page-count measuring iframe — see measurePageCount). The
  // print/export path renders real A4 mm dimensions on purpose, so it must
  // never be scaled. The preview iframe, though, is sized by its container
  // (a sidebar box, not a physical page), so .page's fixed 210mm width
  // overflows it unless zoomed down to fit — this computes that factor from
  // the iframe's actual viewport width and re-applies it on resize. In the
  // measuring iframe the viewport is set to exactly 210mm (createMeasuringIframe),
  // so the factor there is always 1 — a no-op that doesn't disturb the height
  // measurement.
  const fitScript = inlineFonts
    ? ""
    : `<script>
(function(){
  function fit(){
    document.documentElement.style.zoom = 1;
    var page = document.querySelector(".page");
    if (!page) return;
    var scale = window.innerWidth / page.offsetWidth;
    document.documentElement.style.zoom = scale > 0 && scale < 1 ? scale : 1;
  }
  fit();
  window.addEventListener("resize", fit);
})();
</script>`;

  return `<!doctype html>
<html lang="${doc.language}">
<head>
<meta charset="utf-8"/>
<title>${escapeHtml(title || "بحث")}</title>
<style>${css}</style>
</head>
<body>
${inner}
${fitScript}
</body>
</html>`;
}

/**
 * Plain-text rendering of the document — the `text/plain` clipboard flavour
 * that rides alongside the `text/html` one in the "Copy to Word" action (see
 * ResearchPrintDialog.tsx). Whatever app the operator pastes into without
 * rich-text support (Notepad, a chat box) still gets a readable document
 * instead of raw HTML tags. No bidi/markup concerns here — plain text has no
 * direction of its own; the pasting app resolves that from the Unicode
 * bidi algorithm same as it always does for typed text.
 */
export function buildResearchPlainText(doc: ResearchDocument, title: string): string {
  const lines: string[] = [];
  if (title.trim()) lines.push(title.trim(), "");

  const coverBits = [doc.studentName, doc.schoolName, doc.teacherName, doc.schoolYear].filter((s) => s.trim());
  if (coverBits.length) lines.push(coverBits.join(" — "), "");

  if (doc.introduction.trim()) {
    lines.push(L("introduction", doc.language).toUpperCase(), doc.introduction.trim(), "");
  }

  doc.sections.forEach((s, i) => {
    lines.push(`${sectionNumberLabel(i + 1, doc.language)}. ${s.heading}`, s.body.trim(), "");
  });

  if (doc.conclusion.trim()) {
    lines.push(L("conclusion", doc.language).toUpperCase(), doc.conclusion.trim(), "");
  }

  if (doc.sources.length) {
    lines.push(L("sources", doc.language).toUpperCase());
    doc.sources.forEach((src, i) => lines.push(`${i + 1}. ${src}`));
  }

  return lines.join("\n").trim();
}

// ---------------------------------------------------------------------------
// Page-count estimation
// ---------------------------------------------------------------------------

// One full A4 page's height — matches the `.page` rule's own `min-height`,
// so the probe element below reports the same px-per-mm ratio the actual
// `.page` boxes render at (whatever zoom/DPI context the iframe happens to
// be in), and no separate mm-to-px constant is needed.
const A4_PAGE_HEIGHT_MM = 297;

function createMeasuringIframe(): HTMLIFrameElement {
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.left = "-10000px";
  iframe.style.top = "0";
  iframe.style.width = "210mm";
  iframe.style.height = "0";
  iframe.style.border = "0";
  iframe.setAttribute("aria-hidden", "true");
  document.body.appendChild(iframe);
  return iframe;
}

async function measurePageCount(doc: ResearchDocument, title: string, paperId: string): Promise<number> {
  // inlineFonts: false — measuring only needs real layout metrics, not a
  // self-contained document, and skipping the base64 fetch/downscale pass
  // keeps this fast enough to run after every slider nudge (debounced).
  const html = await buildResearchHtml({ doc, title, paperId, inlineFonts: false });
  const iframe = createMeasuringIframe();
  try {
    await new Promise<void>((resolve, reject) => {
      const onLoad = () => {
        iframe.removeEventListener("load", onLoad);
        resolve();
      };
      iframe.addEventListener("load", onLoad);
      iframe.addEventListener("error", () => reject(new Error("Measuring iframe failed to load")), { once: true });
      iframe.srcdoc = html;
    });

    const idoc = iframe.contentDocument;
    if (!idoc || !idoc.body) throw new Error("Measuring iframe has no document");

    const fontsReady = idoc.fonts?.ready;
    if (fontsReady) await fontsReady.catch(() => undefined);

    const probe = idoc.createElement("div");
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    probe.style.width = "1px";
    probe.style.height = `${A4_PAGE_HEIGHT_MM}mm`;
    idoc.body.appendChild(probe);
    const onePagePx = probe.getBoundingClientRect().height || 1;
    probe.remove();

    const pages = idoc.querySelectorAll<HTMLElement>(".page");
    let total = 0;
    pages.forEach((p) => {
      total += Math.max(1, Math.ceil(p.getBoundingClientRect().height / onePagePx));
    });
    return Math.max(1, total);
  } finally {
    iframe.remove();
  }
}

function docRevisionKey(doc: ResearchDocument, title: string, paperId: string): string {
  // Cheap content fingerprint, not a real hash — good enough to detect "did
  // anything that affects layout change" so a slider nudge that lands back
  // on an already-seen value skips a re-render.
  return JSON.stringify({
    title,
    paperId,
    lang: doc.language,
    subject: doc.subject,
    studentName: doc.studentName,
    schoolName: doc.schoolName,
    schoolYear: doc.schoolYear,
    teacherName: doc.teacherName,
    introduction: doc.introduction,
    conclusion: doc.conclusion,
    sources: doc.sources,
    sections: doc.sections.map((s) => [s.heading, s.body, s.imageIds]),
    images: doc.images.map((i) => [i.id, i.caption]),
    typography: doc.typography,
  });
}

let cachedKey: string | null = null;
let cachedCount: number | null = null;
let pending: Promise<number> | null = null;

/**
 * Renders `doc` into a hidden, correctly-sized iframe and measures its
 * height against one A4 page, returning an estimated page count. Cached per
 * document "revision" (see docRevisionKey) so re-calling with unchanged
 * content is free; callers driving this off a slider should additionally
 * wrap their call site with `debounce` (below) so dragging doesn't trigger a
 * render on every frame.
 */
export async function estimatePageCount(doc: ResearchDocument, title: string, paperId: string): Promise<number> {
  const key = docRevisionKey(doc, title, paperId);
  if (key === cachedKey && cachedCount !== null) return cachedCount;
  if (!pending) {
    pending = measurePageCount(doc, title, paperId)
      .then((count) => {
        cachedKey = key;
        cachedCount = count;
        return count;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

/** Trailing-edge debounce — e.g. `debounce(() => estimatePageCount(...).then(setPages), 300)`. */
export function debounce<Args extends unknown[]>(fn: (...args: Args) => void, waitMs = 300): (...args: Args) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Args) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
}
