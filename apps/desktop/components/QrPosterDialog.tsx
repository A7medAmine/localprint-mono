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
 * The public site is multi-tenant: every shop lives under /s/<slug>/upload, and
 * the platform root is a generic landing page. The slug is owned by the cloud
 * and cached locally (cloudShopSlug) on each settings sync. If the operator
 * already pasted a storefront URL that contains /s/<slug>, honour it as-is.
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
  return `${cleaned}/s/${encodeURIComponent(slug)}/upload${query}`;
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

  const printPoster = () => {
    if (!qrSvg) return;
    const html = buildPosterHtml({
      lang,
      shopSettings,
      qrSvg,
      url: targetUrl,
      mode,
    });
    // A hidden iframe, not window.open(): under Electron an about:blank popup
    // is handed to the OS shell ("Get an app to open this 'about' link") and
    // never prints.
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    // Kept at A4 pixel size and merely off-screen — a 0x0 frame can print blank.
    frame.style.cssText = "position:fixed;left:-10000px;top:0;width:794px;height:1123px;border:0;";
    frame.srcdoc = html;
    frame.onload = () => {
      const win = frame.contentWindow;
      if (!win) {
        frame.remove();
        return;
      }
      const cleanup = () => setTimeout(() => frame.remove(), 1000);
      win.addEventListener("afterprint", cleanup, { once: true });
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
            <Button onClick={printPoster} disabled={loading || !qrSvg} className="flex-1">
              {isRtl ? "طباعة الملصق A4" : "Print A4 Poster"}
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
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

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
  wifi: svgIcon(
    '<path d="M5 12.55a11 11 0 0 1 14 0"/><path d="M8.5 16.02a6 6 0 0 1 7 0"/><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M12 20h.01"/>',
  ),
  globe: svgIcon(
    '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  ),
};

const buildPosterInner = ({ lang, shopSettings, qrSvg, url, mode }: PosterProps) => {
  const isRtl = lang === "ar";
  const shopName = shopSettings?.shopName || "Atba3li";
  const logo = shopSettings?.logoUrl || "";
  const phones = shopSettings?.phoneNumbers?.filter(Boolean) || [];
  const email = shopSettings?.email || "";
  const address = shopSettings?.address || "";
  const hours = shopSettings?.workingHours || "";

  const t = (en: string, ar: string) => (isRtl ? ar : en);
  const dir = isRtl ? "rtl" : "ltr";

  const steps = [
    { n: 1, en: "Open your phone camera", ar: "\u0627\u0641\u062a\u062d \u0643\u0627\u0645\u064a\u0631\u0627 \u0647\u0627\u062a\u0641\u0643" },
    { n: 2, en: "Scan the QR code", ar: "\u0627\u0645\u0633\u062d \u0631\u0645\u0632 \u0627\u0644\u0627\u0633\u062a\u062c\u0627\u0628\u0629" },
    { n: 3, en: "Upload files & we print", ar: "\u0627\u0631\u0641\u0639 \u0627\u0644\u0645\u0644\u0641\u0627\u062a \u0648\u0633\u0646\u0637\u0628\u0639\u0647\u0627" },
  ];

  const modeBadge =
    mode === "online"
      ? t("Online \u2014 works anywhere", "\u0639\u0628\u0631 \u0627\u0644\u0625\u0646\u062a\u0631\u0646\u062a \u2014 \u064a\u0639\u0645\u0644 \u0645\u0646 \u0623\u064a \u0645\u0643\u0627\u0646")
      : t("In-store Wi-Fi only", "\u0634\u0628\u0643\u0629 \u0627\u0644\u0645\u062d\u0644 \u0641\u0642\u0637");
  const modeIcon = mode === "online" ? ICONS.globe : ICONS.wifi;

  const footItem = (icon: string, text: string) =>
    `<div class="foot-item"><span class="foot-ico">${icon}</span><span>${text}</span></div>`;

  const contacts = [
    phones.length ? footItem(ICONS.phone, phones.map(escapeHtml).join("  &nbsp;\u00b7&nbsp;  ")) : "",
    email ? footItem(ICONS.mail, escapeHtml(email)) : "",
    address ? footItem(ICONS.pin, escapeHtml(address)) : "",
    hours ? footItem(ICONS.clock, escapeHtml(hours)) : "",
  ].filter(Boolean);

  return `
<div class="poster" dir="${dir}">
  <div class="accent-bar"></div>

  <header class="poster-head">
    ${
      logo
        ? `<div class="logo"><img src="${escapeHtml(logo)}" alt="logo"/></div>`
        : `<div class="logo logo-fallback">${escapeHtml(shopName.slice(0, 1).toUpperCase())}</div>`
    }
    <div class="head-text">
      <h1>${escapeHtml(shopName)}</h1>
      <p class="tagline">${t("Print from your phone in seconds", "\u0627\u0637\u0628\u0639 \u0645\u0646 \u0647\u0627\u062a\u0641\u0643 \u0641\u064a \u062b\u0648\u0627\u0646\u064d")}</p>
    </div>
    <div class="mode-badge"><span class="mode-ico">${modeIcon}</span><span>${escapeHtml(modeBadge)}</span></div>
  </header>

  <section class="qr-block">
    <p class="scan-cta">${t("Scan to upload", "\u0627\u0645\u0633\u062d \u0644\u0628\u062f\u0621 \u0627\u0644\u0631\u0641\u0639")}</p>
    <div class="qr-card">
      <span class="corner tl"></span><span class="corner tr"></span>
      <span class="corner bl"></span><span class="corner br"></span>
      <div class="qr-frame">${qrSvg}</div>
    </div>
    <p class="qr-url">${escapeHtml(url)}</p>
  </section>

  <section class="steps">
    ${steps
      .map(
        (s) => `
      <div class="step">
        <div class="step-n">${s.n}</div>
        <div class="step-label">${escapeHtml(t(s.en, s.ar))}</div>
      </div>`,
      )
      .join("")}
  </section>

  <footer class="poster-foot">
    ${contacts.length ? `<div class="foot-grid">${contacts.join("")}</div>` : ""}
    <p class="foot-brand">${t("Powered by", "\u0645\u062f\u0639\u0648\u0645 \u0628\u0640")} Atba3li \u00b7 \u0623\u0637\u0628\u0639\u0644\u064a</p>
  </footer>
</div>
  `;
};

const posterCss = `
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{background:#fff;font-family:'Segoe UI',Tahoma,'Helvetica Neue',Arial,sans-serif;color:#0f172a;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .poster{width:210mm;height:297mm;padding:0 14mm 12mm;background:#fff;display:flex;flex-direction:column}

  /* Full-bleed brand band across the top of the sheet. */
  .accent-bar{height:6mm;margin:0 -14mm 10mm;background:linear-gradient(90deg,#4f46e5 0%,#6366f1 45%,#a5b4fc 100%)}

  .poster-head{display:flex;align-items:center;gap:6mm;padding-bottom:6mm;border-bottom:0.4mm solid #e2e8f0}
  .logo{width:22mm;height:22mm;border-radius:4mm;overflow:hidden;background:#fff;border:0.4mm solid #e2e8f0;display:flex;align-items:center;justify-content:center;flex-shrink:0}
  .logo img{width:100%;height:100%;object-fit:contain}
  .logo-fallback{background:#4f46e5;color:#fff;font-size:12mm;font-weight:700}
  .head-text{flex:1;min-width:0}
  .head-text h1{font-size:11mm;line-height:1.05;font-weight:800;letter-spacing:-0.3mm}
  .tagline{margin-top:1.5mm;font-size:4.4mm;color:#64748b;font-weight:500}
  .mode-badge{display:flex;align-items:center;gap:2mm;flex-shrink:0;background:#eef2ff;color:#3730a3;padding:2mm 4mm;border-radius:10mm;font-size:3.4mm;font-weight:700;border:0.3mm solid #c7d2fe}
  .mode-ico{display:inline-flex;width:4.2mm;height:4.2mm}
  .mode-ico svg{width:100%;height:100%}

  .qr-block{margin-top:10mm;text-align:center}
  .scan-cta{font-size:9mm;font-weight:800;color:#0f172a;letter-spacing:-0.3mm}
  .qr-card{position:relative;display:inline-block;margin-top:6mm;padding:9mm;background:#fff;border:0.5mm solid #e2e8f0;border-radius:6mm}
  /* Viewfinder brackets — they read as "point your camera here". */
  .corner{position:absolute;width:10mm;height:10mm;border:1mm solid #4f46e5}
  .corner.tl{top:2.5mm;left:2.5mm;border-right:0;border-bottom:0;border-top-left-radius:4mm}
  .corner.tr{top:2.5mm;right:2.5mm;border-left:0;border-bottom:0;border-top-right-radius:4mm}
  .corner.bl{bottom:2.5mm;left:2.5mm;border-right:0;border-top:0;border-bottom-left-radius:4mm}
  .corner.br{bottom:2.5mm;right:2.5mm;border-left:0;border-top:0;border-bottom-right-radius:4mm}
  .qr-frame{line-height:0}
  .qr-frame svg{width:98mm;height:98mm;display:block}
  .qr-url{margin:5mm auto 0;padding:2mm 5mm;display:inline-block;background:#f8fafc;border:0.3mm solid #e2e8f0;border-radius:10mm;font-size:3.4mm;color:#475569;word-break:break-all;max-width:170mm;font-family:'Consolas','Menlo',monospace;direction:ltr}

  .steps{margin-top:10mm;display:grid;grid-template-columns:repeat(3,1fr);gap:4mm}
  .step{border:0.4mm solid #e2e8f0;border-radius:3mm;padding:5mm 3mm;text-align:center;background:#f8fafc}
  .step-n{width:10mm;height:10mm;margin:0 auto 3mm;border-radius:50%;background:#4f46e5;color:#fff;font-size:5.4mm;font-weight:800;display:flex;align-items:center;justify-content:center}
  .step-label{font-size:3.8mm;font-weight:600;color:#0f172a;line-height:1.35}

  .poster-foot{margin-top:auto;padding-top:6mm;border-top:0.4mm solid #e2e8f0}
  .foot-grid{display:grid;grid-template-columns:1fr 1fr;gap:3mm 8mm;font-size:3.8mm;color:#334155}
  .foot-item{display:flex;align-items:center;gap:2.5mm;font-weight:500}
  .foot-ico{display:inline-flex;width:4.6mm;height:4.6mm;color:#4f46e5;flex-shrink:0}
  .foot-ico svg{width:100%;height:100%}
  .foot-brand{margin-top:5mm;text-align:center;font-size:3mm;color:#94a3b8;letter-spacing:0.3mm}

  [dir="rtl"] .poster{text-align:right}
  @page{size:A4 portrait;margin:0}
  @media print{.poster{box-shadow:none}}
`;

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
