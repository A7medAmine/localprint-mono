import React, { useState, useEffect, useMemo } from "react";
import QRCode from "qrcode";
import { Language, ShopSettings } from "../types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { activeSocialLinks } from "@atba3li/shared/social";
import type { SocialPlatformId } from "@atba3li/shared/social";
import { BRAND_PATHS } from "@atba3li/shared/components/StoreSocialLinks";
import { isElectron, printData, renderHtmlPdf } from "../lib/electronPrint";
import PosterPrintOptionsDialog, { PosterPrintOptions } from "./PosterPrintOptionsDialog";

type Mode = "local" | "online";

interface QrPosterDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lang: Language;
  shopSettings: ShopSettings | null;
  /** Admin-only: enables the "Print A4 Poster" action. Defaults to false. */
  allowPrint?: boolean;
  /**
   * Customer-facing: hides every admin affordance (destination switch, cloud
   * sync hints, poster printing) and just shares the shop's website link.
   * Falls back to the local network URL when no cloud URL is configured.
   */
  shareOnly?: boolean;
}

const getLocalIP = async (): Promise<string> => {
  try {
    const response = await fetch("/api/local-ip");
    if (!response.ok) throw new Error("failed");
    const data = await response.json();
    return data.ip;
  } catch {
    return window.location.hostname;
  }
};

const buildLocalUrl = async (lang: Language) => {
  const ip = await getLocalIP();
  const port = window.location.port;
  const host = port ? `${ip}:${port}` : ip;
  return `http://${host}?ref=upload&lang=${lang}`;
};

/**
 * The public site is multi-tenant: every shop lives under /<slug>/upload, and
 * the platform root is a generic landing page. The slug is owned by the cloud
 * and cached locally (cloudShopSlug) on each settings sync. Old-style pasted
 * URLs (/s/<slug>) still resolve server-side, so honour them as-is rather
 * than rewriting a value the operator typed in themselves.
 */
const buildOnlineUrl = (shopSettings: ShopSettings | null, lang: Language) => {
  const raw = shopSettings?.cloudSyncUrl?.trim();
  if (!raw) return null;
  const cleaned = raw.replace(/\/+$/, "");
  const query = `?ref=upload&lang=${lang}`;

  const embedded = cleaned.match(/\/s\/([^/?#]+)/);
  if (embedded) {
    const base = cleaned.slice(0, embedded.index! + embedded[0].length);
    return `${base}/upload${query}`;
  }

  const slug = shopSettings?.cloudShopSlug?.trim();
  if (!slug) return null;
  return `${cleaned}/${encodeURIComponent(slug)}/upload${query}`;
};

const QrPosterDialog: React.FC<QrPosterDialogProps> = ({
  open,
  onOpenChange,
  lang,
  shopSettings,
  allowPrint = false,
  shareOnly = false,
}) => {
  const isRtl = lang === "ar";
  const onlineUrl = useMemo(() => buildOnlineUrl(shopSettings, lang), [shopSettings, lang]);

  const [mode, setMode] = useState<Mode>("local");
  const [copied, setCopied] = useState(false);
  const [targetUrl, setTargetUrl] = useState<string>("");
  const [qrPng, setQrPng] = useState<string>("");
  const [qrSvg, setQrSvg] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [printOptionsOpen, setPrintOptionsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const url =
          mode === "online" && onlineUrl
            ? onlineUrl
            : await buildLocalUrl(lang);
        const png = await QRCode.toDataURL(url, {
          width: 1024,
          margin: 1,
          errorCorrectionLevel: "H",
          color: { dark: "#0f172a", light: "#ffffff" },
        });
        const svg = await QRCode.toString(url, {
          type: "svg",
          margin: 1,
          errorCorrectionLevel: "H",
          color: { dark: "#0f172a", light: "#ffffff" },
        });
        if (cancelled) return;
        setTargetUrl(url);
        setQrPng(png);
        setQrSvg(svg);
      } catch {
        if (!cancelled) setError(isRtl ? "فشل إنشاء رمز QR" : "Failed to generate QR");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, mode, lang, onlineUrl, isRtl]);

  // Share mode always targets the website when one is configured; otherwise it
  // silently falls back to the local URL rather than surfacing a settings hint.
  useEffect(() => {
    if (open) setMode(onlineUrl ? "online" : "local");
  }, [open, onlineUrl]);

  const shareLink = async () => {
    if (!targetUrl) return;
    const shopName = shopSettings?.shopName || "";
    if (navigator.share) {
      try {
        await navigator.share({ title: shopName || document.title, url: targetUrl });
        return;
      } catch {
        // User dismissed the sheet, or sharing is unavailable — fall through.
      }
    }
    try {
      await navigator.clipboard.writeText(targetUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError(isRtl ? "تعذّر نسخ الرابط" : "Could not copy the link");
    }
  };

  const downloadPng = () => {
    if (!qrPng) return;
    const a = document.createElement("a");
    a.download = `qrcode-${mode}-${Date.now()}.png`;
    a.href = qrPng;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // Chromium's own print dialog is not the app's print path: it ignores the
  // printer and paper the shop configured, reports no real success or failure,
  // and prints blank on the drivers that made job printing move to the spooler.
  // So the poster is rendered to a PDF in the main process and spooled like any
  // other job. Outside Electron (dev in a browser) the iframe path still runs,
  // and the printer/copies/colour picked in the options dialog are moot there —
  // the OS print dialog takes over.
  const printPoster = async (opts: PosterPrintOptions) => {
    if (!qrSvg || printing) return;
    setPrinting(true);
    setError(null);
    try {
      const html = await inlinePosterAssets(
        buildPosterHtml({ lang, shopSettings, qrSvg, url: targetUrl, mode }),
      );
      if (!isElectron()) {
        printViaIframe(html);
        return;
      }
      const pdf = await renderHtmlPdf({ html, pageSize: "A4" });
      const result = await printData({
        data: pdf,
        fileType: "application/pdf",
        extension: ".pdf",
        // Empty means the OS default printer — same convention as job printing.
        printerName: opts.printerName,
        silent: true,
        options: { copies: opts.copies, color: opts.color },
      });
      if (result.ok === false && !result.cancelled) {
        throw new Error(isRtl ? "تعذّرت الطباعة" : "Could not print the poster");
      }
      setPrintOptionsOpen(false);
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : isRtl
            ? "تعذّرت الطباعة"
            : "Could not print the poster",
      );
    } finally {
      setPrinting(false);
    }
  };

  const printViaIframe = (html: string) => {
    // A hidden iframe, not window.open(): under Electron an about:blank popup
    // is handed to the OS shell ("Get an app to open this 'about' link") and
    // never prints.
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    // Kept at A4 pixel size and merely off-screen — a 0x0 frame can print blank.
    frame.style.cssText = "position:fixed;left:-10000px;top:0;width:794px;height:1123px;border:0;";
    frame.srcdoc = html;
    frame.onload = async () => {
      const win = frame.contentWindow;
      if (!win) {
        frame.remove();
        return;
      }
      const cleanup = () => setTimeout(() => frame.remove(), 1000);
      win.addEventListener("afterprint", cleanup, { once: true });
      // The load event does not wait for @font-face, so printing straight away
      // can spool the poster in a fallback system face.
      await Promise.race([
        win.document.fonts?.ready ?? Promise.resolve(),
        new Promise((r) => setTimeout(r, 3000)),
      ]).catch(() => undefined);
      try {
        win.focus();
        win.print();
      } catch {
        setError(isRtl ? "تعذّرت الطباعة" : "Could not open the print dialog");
        frame.remove();
        return;
      }
      // afterprint never fires in some engines — reap the frame anyway.
      setTimeout(cleanup, 60000);
    };
    document.body.appendChild(frame);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {shareOnly
              ? isRtl
                ? "شارك موقع المتجر"
                : "Share our website"
              : allowPrint
              ? isRtl
                ? "ملصق QR للطباعة"
                : "Printable QR Poster"
              : isRtl
                ? "رمز QR للمشاركة"
                : "Share QR Code"}
          </DialogTitle>
          <DialogDescription>
            {shareOnly
              ? isRtl
                ? "امسح الرمز بكاميرا هاتفك أو انسخ الرابط لمشاركته مع أصدقائك"
                : "Scan with your phone camera, or copy the link to share it"
              : allowPrint
              ? isRtl
                ? "اختر الوجهة، ثم اطبع ملصق A4 جاهزًا للعرض في المتجر"
                : "Pick a destination, then print a ready-to-display A4 poster"
              : isRtl
                ? "امسح الرمز أو حمّله لمشاركته"
                : "Scan the code or download it to share"}
          </DialogDescription>
        </DialogHeader>

        {/* Mode selector — admin only; customers never pick a destination */}
        {!shareOnly && (
        <div className="grid grid-cols-2 gap-2 rounded-lg bg-muted p-1">
          <button
            type="button"
            onClick={() => setMode("local")}
            className={`rounded-md px-3 py-2 text-sm font-medium transition ${
              mode === "local"
                ? "bg-background shadow-sm text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {isRtl ? "الشبكة المحلية" : "Local Network"}
          </button>
          <button
            type="button"
            onClick={() => setMode("online")}
            disabled={!onlineUrl}
            className={`rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-40 disabled:cursor-not-allowed ${
              mode === "online"
                ? "bg-background shadow-sm text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            title={!onlineUrl ? (isRtl ? "لم يتم تعيين رابط الموقع أو معرّف المتجر" : "Cloud URL or store slug not set") : ""}
          >
            {isRtl ? "الموقع الإلكتروني" : "Online Website"}
          </button>
        </div>
        )}

        {!shareOnly && mode === "online" && !onlineUrl && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {isRtl
              ? "أضف رابط المزامنة السحابية ومعرّف المتجر من الإعدادات لتفعيل هذا الخيار."
              : "Add the cloud sync URL and store slug in settings to enable this option."}
          </p>
        )}

        {/* Compact QR preview only — full A4 poster is generated on print */}
        <div className="rounded-lg border bg-white dark:bg-slate-50 p-4 flex flex-col items-center gap-3">
          {qrPng ? (
            <img
              src={qrPng}
              alt="QR"
              className="w-48 h-48 rounded-md border border-slate-200"
            />
          ) : (
            <div className="w-48 h-48 rounded-md border border-dashed border-slate-300 flex items-center justify-center text-xs text-slate-400">
              {loading ? (isRtl ? "جارِ التوليد…" : "Generating…") : "—"}
            </div>
          )}
          {allowPrint && (
            <p className="text-xs text-slate-500 text-center">
              {isRtl
                ? "سيتم إنشاء ملصق A4 كامل بشعار المتجر وتفاصيله عند الطباعة."
                : "A full A4 poster with your shop branding is generated when you print."}
            </p>
          )}
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex flex-col sm:flex-row gap-2">
          {shareOnly && (
            <Button onClick={shareLink} disabled={loading || !targetUrl} className="flex-1">
              {copied
                ? isRtl
                  ? "تم نسخ الرابط"
                  : "Link copied"
                : isRtl
                  ? "نسخ / مشاركة الرابط"
                  : "Copy / share link"}
            </Button>
          )}
          {allowPrint && (
            <Button
              onClick={() => setPrintOptionsOpen(true)}
              disabled={loading || printing || !qrSvg}
              className="flex-1"
            >
              {printing
                ? isRtl
                  ? "جارِ الطباعة…"
                  : "Printing…"
                : isRtl
                  ? "طباعة الملصق A4"
                  : "Print A4 Poster"}
            </Button>
          )}
          <Button
            onClick={downloadPng}
            variant={allowPrint || shareOnly ? "outline" : "default"}
            disabled={loading || !qrPng}
            className="flex-1"
          >
            {isRtl ? "تحميل رمز QR (PNG)" : "Download QR (PNG)"}
          </Button>
        </div>

        <p className="text-xs text-muted-foreground break-all">
          <span className="font-medium">{isRtl ? "الرابط:" : "Link:"}</span>{" "}
          {targetUrl ? (
            <a
              href={targetUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-600 dark:text-indigo-400 underline underline-offset-2 hover:text-indigo-700 dark:hover:text-indigo-300"
              title={isRtl ? "فتح الرابط في المتصفح" : "Open link in browser"}
            >
              {targetUrl}
            </a>
          ) : (
            "…"
          )}
        </p>
      </DialogContent>

      {allowPrint && (
        <PosterPrintOptionsDialog
          open={printOptionsOpen}
          isRtl={isRtl}
          defaultPrinterName={shopSettings?.defaultPrinterName || ""}
          submitting={printing}
          onClose={() => setPrintOptionsOpen(false)}
          onPrint={printPoster}
        />
      )}
    </Dialog>
  );
};

interface PosterProps {
  lang: Language;
  shopSettings: ShopSettings | null;
  qrSvg: string;
  url: string;
  mode: Mode;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string),
  );

const svgIcon = (path: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

/** Inline SVG — a printed page has no icon font and no component runtime. */
const ICONS = {
  phone: svgIcon(
    '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
  ),
  mail: svgIcon('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>'),
  pin: svgIcon(
    '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
  ),
  clock: svgIcon('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
};

/** The brand marks, filled single paths — the same glyphs the storefront uses. */
const socialIcon = (id: SocialPlatformId) =>
  id === "website"
    ? svgIcon(
        '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.5 3.8 5.6 3.8 9S14.5 18.5 12 21c-2.5-2.5-3.8-5.6-3.8-9S9.5 5.5 12 3z"/>',
      )
    : `<svg viewBox="0 0 24 24"><path fill="currentColor" fill-rule="evenodd" d="${BRAND_PATHS[id]}"/></svg>`;

// Platforms whose public identity is written "@handle"; a Facebook page is not.
const AT_HANDLE = new Set<SocialPlatformId>(["instagram", "tiktok", "telegram", "youtube"]);

/**
 * The display name for a stored social link. Settings keep the full URL (a
 * username alone is ambiguous across platforms), but on a printed poster
 * "@yourshop" reads far better than a 40-character address — so the handle is
 * derived back out of the URL and the link itself never reaches the page.
 *
 * Returns null when there is no meaningful handle (a profile-less URL); the
 * caller then falls back to the platform's name.
 */
const socialHandle = (id: SocialPlatformId, url: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (id === "website") return parsed.hostname.replace(/^www\./, "");

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  // Deep links ("facebook.com/p/name/123", "youtube.com/channel/UC…") hold no
  // clean handle — the first segment is the closest thing to one.
  const raw = decodeURIComponent(segments[0]).replace(/^@/, "");
  if (!raw) return null;

  if (id === "whatsapp") {
    const digits = raw.replace(/\D/g, "");
    return digits ? `+${digits}` : null;
  }
  return AT_HANDLE.has(id) ? `@${raw}` : raw;
};

const buildPosterInner = ({ lang, shopSettings, qrSvg, url, mode }: PosterProps) => {
  const isRtl = lang === "ar";
  const shopName = shopSettings?.shopName || "Atba3li";
  const logo = shopSettings?.logoUrl || "";
  const phones = shopSettings?.phoneNumbers?.filter(Boolean) || [];
  const email = shopSettings?.email || "";
  const address = shopSettings?.address || "";
  const hours = shopSettings?.workingHours || "";
  const socials = activeSocialLinks(shopSettings?.socialLinks);

  const t = (en: string, ar: string) => (isRtl ? ar : en);
  const dir = isRtl ? "rtl" : "ltr";

  const steps = [
    { n: 1, en: "Open your phone camera", ar: "افتح كاميرا هاتفك" },
    { n: 2, en: "Scan the code", ar: "امسح الرمز" },
    { n: 3, en: "Upload files — we print", ar: "ارفع الملفات وسنطبعها" },
  ];

  const modeNote =
    mode === "online"
      ? t("Works anywhere", "يعمل من أي مكان")
      : t("On the in-store Wi-Fi", "على شبكة المحل");

  const contact = (icon: string, text: string) =>
    `<div class="contact"><span class="ico">${icon}</span><span class="contact-text">${text}</span></div>`;

  const contacts = [
    phones.length
      ? contact(ICONS.phone, phones.map(escapeHtml).join("&nbsp;&nbsp;·&nbsp;&nbsp;"))
      : "",
    email ? contact(ICONS.mail, escapeHtml(email)) : "",
    address ? contact(ICONS.pin, escapeHtml(address)) : "",
    hours ? contact(ICONS.clock, escapeHtml(hours)) : "",
  ].filter(Boolean);

  // Only the platforms the shop actually filled in; nothing is printed for a
  // shop that set none.
  const socialRow = socials
    .map(({ platform, url: link }) => {
      const id = platform.id as SocialPlatformId;
      const handle = socialHandle(id, link) || (isRtl ? platform.labelAr : platform.label);
      return `<div class="social"><span class="ico brand">${socialIcon(id)}</span><span class="handle">${escapeHtml(handle)}</span></div>`;
    })
    .join("");

  return `
<div class="poster" dir="${dir}">
  <div class="cal-bar" aria-hidden="true"><span class="cal c"></span><span class="cal m"></span><span class="cal y"></span><span class="cal k"></span></div>
  <div class="poster-body">
  <header class="masthead">
    ${
      logo
        ? `<div class="logo"><img src="${escapeHtml(logo)}" alt=""/></div>`
        : `<div class="logo logo-fallback">${escapeHtml(shopName.slice(0, 1).toUpperCase())}</div>`
    }
    <div class="masthead-text">
      <h1>${escapeHtml(shopName)}</h1>
      <p class="eyebrow">${escapeHtml(t("Print from your phone", "اطبع من هاتفك"))}</p>
    </div>
  </header>

  <section class="qr-block">
    <div class="qr-frame">${qrSvg}</div>
    <p class="scan-cta">${escapeHtml(t("Scan to upload", "امسح لبدء الرفع"))}</p>
    <p class="mode-note">${escapeHtml(modeNote)}</p>
    <p class="qr-url">${escapeHtml(url)}</p>
  </section>

  <section class="steps">
    ${steps
      .map(
        (s) => `
      <div class="step">
        <span class="step-n">${s.n}</span>
        <span class="step-label">${escapeHtml(t(s.en, s.ar))}</span>
      </div>`,
      )
      .join("")}
  </section>

  <footer class="poster-foot">
    ${contacts.length ? `<div class="contacts">${contacts.join("")}</div>` : ""}
    ${socialRow ? `<div class="socials">${socialRow}</div>` : ""}
    <p class="foot-brand">Atba3li<span class="foot-dot"></span>أطبعلي</p>
  </footer>
  </div>
</div>
  `;
};

// Self-hosted faces from public/ — the packaged app prints offline, so a webfont
// CDN would silently drop the poster back to a system UI face. Roboto Slab
// carries the display lines, Inter the text, Rubik every Arabic glyph (neither
// Latin face has Arabic, so it is listed last in both stacks and the browser
// falls through per glyph).
const posterCss = `
  @font-face{font-family:'PosterSans';src:url('/Inter.ttf') format('truetype-variations');font-weight:100 900;font-display:block}
  @font-face{font-family:'PosterDisplay';src:url('/RobotoSlab.ttf') format('truetype-variations');font-weight:100 900;font-display:block}
  @font-face{font-family:'PosterArabic';src:url('/Rubik.ttf') format('truetype-variations');font-weight:300 900;font-display:block}

  *{box-sizing:border-box;margin:0;padding:0}
  html,body{background:#fff;color:#161616;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{font-family:'PosterSans','PosterArabic','Segoe UI',Arial,sans-serif;font-feature-settings:'kern' 1,'liga' 1,'tnum' 1;-webkit-font-smoothing:antialiased}

  .poster{width:210mm;height:297mm;display:flex;flex-direction:column}

  /* A press's own colour-calibration strip, run across the top edge — the
     first proof of colour a printed sheet gives you. */
  .cal-bar{display:flex;height:3mm;flex-shrink:0}
  .cal{flex:1}
  .cal.c{background:#00aeef}
  .cal.m{background:#ec008c}
  .cal.y{background:#ffe600}
  .cal.k{background:#161616}

  .poster-body{
    flex:1;display:flex;flex-direction:column;padding:11mm 18mm 11mm;
    background-image:radial-gradient(circle,rgba(22,22,22,.05) .4mm,transparent .42mm);
    background-size:3.4mm 3.4mm;
  }

  .masthead{display:flex;align-items:center;gap:5mm}
  .logo{width:16mm;height:16mm;flex-shrink:0;overflow:hidden;border-radius:2mm;display:flex;align-items:center;justify-content:center}
  .logo img{width:100%;height:100%;object-fit:contain}
  .logo-fallback{background:#161616;color:#fff;font-family:'PosterDisplay','PosterArabic',serif;font-size:8mm;font-weight:600}
  .masthead-text{min-width:0}
  .masthead h1{font-family:'PosterDisplay','PosterArabic',serif;font-size:9mm;line-height:1.1;font-weight:600;letter-spacing:-0.15mm}
  .eyebrow{margin-top:1.2mm;font-size:3.8mm;font-weight:500;color:#6b7280}

  /* The code owns the middle of the sheet; nothing competes with it. */
  .qr-block{margin-top:auto;margin-bottom:auto;text-align:center}
  .qr-frame{display:inline-block;line-height:0;padding:5mm;background:#fff;border:0.35mm solid #e5e7eb;border-radius:3mm}
  .qr-frame svg{width:84mm;height:84mm;display:block}
  .scan-cta{margin-top:6mm;font-family:'PosterDisplay','PosterArabic',serif;font-size:9.5mm;font-weight:600;line-height:1.15;letter-spacing:-0.2mm}
  .mode-note{margin-top:2mm;font-size:4mm;font-weight:500;color:#6b7280}
  .qr-url{margin-top:4mm;font-family:'Consolas','Menlo',monospace;font-size:3.2mm;color:#9ca3af;word-break:break-all;direction:ltr}

  /* Numbered steps as one typographic line, not three boxed cards. */
  .steps{display:flex;gap:7mm;padding:5mm 0;border-top:0.3mm solid #e5e7eb;border-bottom:0.3mm solid #e5e7eb}
  .step{flex:1;display:flex;align-items:baseline;gap:2.5mm}
  .step-n{flex-shrink:0;font-family:'PosterDisplay',serif;font-size:5mm;font-weight:600;color:#c7cbd1}
  .step-label{font-size:3.8mm;font-weight:500;line-height:1.35;color:#374151}

  .poster-foot{margin-top:6mm}
  .contacts{display:grid;grid-template-columns:1fr 1fr;gap:3mm 8mm;font-size:3.6mm;color:#374151}
  .contact{display:flex;align-items:center;gap:2.5mm;min-width:0}
  .contact-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;unicode-bidi:plaintext}
  .ico{display:inline-flex;width:4.2mm;height:4.2mm;flex-shrink:0;color:#161616}
  .ico svg{width:100%;height:100%}
  .ico.brand{color:#4b5563}

  .socials{margin-top:4mm;padding-top:3.5mm;border-top:0.3mm solid #f1f2f4;display:flex;flex-wrap:wrap;gap:3mm 7mm}
  .social{display:flex;align-items:center;gap:2mm}
  .handle{font-size:3.5mm;font-weight:500;color:#374151;direction:ltr;unicode-bidi:isolate}

  .foot-brand{margin-top:5mm;text-align:center;font-size:2.9mm;color:#9aa0a8;letter-spacing:0.4mm}
  .foot-dot{display:inline-block;width:1.5mm;height:1.5mm;border-radius:50%;background:#ec008c;margin:0 2mm;vertical-align:middle}

  [dir="rtl"] .poster-body{text-align:right}
  @page{size:A4 portrait;margin:0}
`;

// The main process renders the poster from a tmp file, where "/Inter.ttf" or a
// relative logo URL resolves against the drive root instead of the app server —
// so every asset is fetched here and inlined as a data URL first. Faces are
// fetched once per session; a font that fails to load is dropped from the CSS
// and the stack below it takes over.
const assetCache = new Map<string, Promise<string | null>>();

const asDataUrl = (path: string): Promise<string | null> => {
  const cached = assetCache.get(path);
  if (cached) return cached;
  const pending = (async () => {
    try {
      const res = await fetch(path);
      if (!res.ok) return null;
      const blob = await res.blob();
      return await new Promise<string | null>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  })();
  assetCache.set(path, pending);
  return pending;
};

const inlinePosterAssets = async (html: string): Promise<string> => {
  const assets = [...html.matchAll(/(?:url\('|<img src=")(\/[^'"]+)/g)].map((m) => m[1]);
  const unique = [...new Set(assets)];
  const resolved = await Promise.all(unique.map(asDataUrl));

  let out = html;
  unique.forEach((asset, i) => {
    const dataUrl = resolved[i];
    const escaped = asset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (dataUrl) {
      out = out.replace(new RegExp(escaped, "g"), dataUrl);
    } else {
      // Drop the whole @font-face src rather than leave a dead URL that makes
      // Chromium wait for a load that will never arrive.
      out = out.replace(new RegExp(`src:url\\('${escaped}'\\)[^;}]*;?`, "g"), "");
    }
  });
  return out;
};

const buildPosterHtml = (props: PosterProps) => `<!doctype html>
<html lang="${props.lang}" dir="${props.lang === "ar" ? "rtl" : "ltr"}">
<head>
<meta charset="utf-8"/>
<title>${escapeHtml(props.shopSettings?.shopName || "QR Poster")}</title>
<style>${posterCss}</style>
</head>
<body>
${buildPosterInner(props)}
</body>
</html>`;

export default QrPosterDialog;
