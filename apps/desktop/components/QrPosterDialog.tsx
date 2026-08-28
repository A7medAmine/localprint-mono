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

const buildOnlineUrl = (shopSettings: ShopSettings | null, lang: Language) => {
  const raw = shopSettings?.cloudSyncUrl?.trim();
  if (!raw) return null;
  const cleaned = raw.replace(/\/+$/, "");
  return `${cleaned}?ref=upload&lang=${lang}`;
};

const QrPosterDialog: React.FC<QrPosterDialogProps> = ({
  open,
  onOpenChange,
  lang,
  shopSettings,
  allowPrint = false,
}) => {
  const isRtl = lang === "ar";
  const onlineUrl = useMemo(() => buildOnlineUrl(shopSettings, lang), [shopSettings, lang]);

  const [mode, setMode] = useState<Mode>("local");
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
      } catch (err) {
        if (!cancelled) setError(isRtl ? "فشل إنشاء رمز QR" : "Failed to generate QR");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, mode, lang, onlineUrl, isRtl]);

  useEffect(() => {
    if (open) setMode(onlineUrl ? "online" : "local");
  }, [open, onlineUrl]);

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
    const w = window.open("", "_blank", "width=900,height=1200");
    if (!w) return;
    w.document.open();
    w.document.write(html);
    w.document.close();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {allowPrint
              ? isRtl
                ? "ملصق QR للطباعة"
                : "Printable QR Poster"
              : isRtl
                ? "رمز QR للمشاركة"
                : "Share QR Code"}
          </DialogTitle>
          <DialogDescription>
            {allowPrint
              ? isRtl
                ? "اختر الوجهة، ثم اطبع ملصق A4 جاهزًا للعرض في المتجر"
                : "Pick a destination, then print a ready-to-display A4 poster"
              : isRtl
                ? "امسح الرمز أو حمّله لمشاركته"
                : "Scan the code or download it to share"}
          </DialogDescription>
        </DialogHeader>

        {/* Mode selector */}
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
            title={!onlineUrl ? (isRtl ? "لم يتم تعيين رابط الموقع" : "Cloud sync URL not set") : ""}
          >
            {isRtl ? "الموقع الإلكتروني" : "Online Website"}
          </button>
        </div>

        {mode === "online" && !onlineUrl && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {isRtl
              ? "أضف رابط المزامنة السحابية من الإعدادات لتفعيل هذا الخيار."
              : "Add the cloud sync URL in settings to enable this option."}
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
          {allowPrint && (
            <Button onClick={printPoster} disabled={loading || !qrSvg} className="flex-1">
              {isRtl ? "طباعة الملصق A4" : "Print A4 Poster"}
            </Button>
          )}
          <Button
            onClick={downloadPng}
            variant={allowPrint ? "outline" : "default"}
            disabled={loading || !qrPng}
            className="flex-1"
          >
            {isRtl ? "تحميل رمز QR (PNG)" : "Download QR (PNG)"}
          </Button>
        </div>

        <p className="text-xs text-muted-foreground break-all">
          <span className="font-medium">{isRtl ? "الرابط:" : "Link:"}</span>{" "}
          {targetUrl || "…"}
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

const buildPosterInner = ({ lang, shopSettings, qrSvg, url, mode }: PosterProps) => {
  const isRtl = lang === "ar";
  const shopName = shopSettings?.shopName || "PrintShop Hub";
  const logo = shopSettings?.logoUrl || "";
  const phones = shopSettings?.phoneNumbers?.filter(Boolean) || [];
  const email = shopSettings?.email || "";
  const address = shopSettings?.address || "";
  const hours = shopSettings?.workingHours || "";

  const t = (en: string, ar: string) => (isRtl ? ar : en);
  const dir = isRtl ? "rtl" : "ltr";

  const steps = [
    { n: 1, en: "Open your phone camera", ar: "افتح كاميرا هاتفك" },
    { n: 2, en: "Scan the QR code", ar: "امسح رمز الاستجابة" },
    { n: 3, en: "Upload files & we print", ar: "ارفع الملفات وسنطبعها" },
  ];

  const modeBadge =
    mode === "online"
      ? t("Online — works anywhere", "عبر الإنترنت — يعمل من أي مكان")
      : t("In-store Wi-Fi only", "شبكة المحل فقط");

  const iconPhone = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0 1 22 16.92z"/></svg>`;
  const iconMail = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>`;
  const iconPin = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
  const iconClock = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;

  const footItem = (icon: string, text: string) =>
    `<div class="foot-item"><span class="foot-ico">${icon}</span><span>${text}</span></div>`;

  return `
<div class="poster" dir="${dir}">
  <header class="poster-head">
    ${
      logo
        ? `<div class="logo"><img src="${escapeHtml(logo)}" alt="logo"/></div>`
        : `<div class="logo logo-fallback">${escapeHtml(shopName.slice(0, 1).toUpperCase())}</div>`
    }
    <div class="head-text">
      <h1>${escapeHtml(shopName)}</h1>
      <p class="tagline">${t("Print from your phone in seconds", "اطبع من هاتفك في ثوانٍ")}</p>
    </div>
  </header>

  <div class="mode-badge">${escapeHtml(modeBadge)}</div>

  <section class="qr-block">
    <div class="qr-frame">${qrSvg}</div>
    <p class="scan-cta">${t("Scan to upload", "امسح لبدء الرفع")}</p>
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
    ${phones.length ? footItem(iconPhone, phones.map(escapeHtml).join("  &nbsp;·&nbsp;  ")) : ""}
    ${email ? footItem(iconMail, escapeHtml(email)) : ""}
    ${address ? footItem(iconPin, escapeHtml(address)) : ""}
    ${hours ? footItem(iconClock, escapeHtml(hours)) : ""}
  </footer>
</div>
  `;
};

const posterCss = `
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{background:#fff;font-family:'Segoe UI',Tahoma,'Helvetica Neue',Arial,sans-serif;color:#0f172a;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .poster{width:210mm;height:297mm;padding:18mm 16mm;background:#fff;display:flex;flex-direction:column}
  .poster-head{display:flex;align-items:center;gap:8mm;padding-bottom:8mm;border-bottom:0.4mm solid #e2e8f0}
  .logo{width:22mm;height:22mm;border-radius:3mm;overflow:hidden;background:#fff;border:0.4mm solid #e2e8f0;display:flex;align-items:center;justify-content:center;flex-shrink:0}
  .logo img{width:100%;height:100%;object-fit:contain}
  .logo-fallback{background:#0f172a;color:#fff;font-size:12mm;font-weight:700}
  .head-text h1{font-size:10mm;line-height:1.1;font-weight:700;letter-spacing:-0.2mm}
  .tagline{margin-top:1.5mm;font-size:4.2mm;color:#64748b;font-weight:400}
  .mode-badge{margin-top:6mm;align-self:flex-start;background:#0f172a;color:#fff;padding:1.6mm 4mm;border-radius:1.5mm;font-size:3.4mm;font-weight:600;text-transform:uppercase;letter-spacing:0.4mm}
  .qr-block{margin-top:8mm;text-align:center}
  .qr-frame{display:inline-block;padding:4mm;background:#fff;border:0.6mm solid #0f172a;border-radius:2mm;line-height:0}
  .qr-frame svg{width:105mm;height:105mm;display:block}
  .qr-block .scan-cta,.qr-block .qr-url{display:block}
  .scan-cta{margin-top:6mm;font-size:7mm;font-weight:700;color:#0f172a}
  .qr-url{margin:2mm auto 0;font-size:3.4mm;color:#64748b;word-break:break-all;max-width:170mm;font-family:'Consolas','Menlo',monospace}
  .steps{margin-top:9mm;display:grid;grid-template-columns:repeat(3,1fr);gap:4mm}
  .step{border:0.4mm solid #e2e8f0;border-radius:2mm;padding:5mm 3mm;text-align:center}
  .step-n{width:9mm;height:9mm;margin:0 auto 2.5mm;border-radius:50%;background:#0f172a;color:#fff;font-size:5mm;font-weight:700;display:flex;align-items:center;justify-content:center}
  .step-label{font-size:3.6mm;font-weight:600;color:#0f172a;line-height:1.3}
  .poster-foot{margin-top:auto;padding-top:6mm;border-top:0.4mm solid #e2e8f0;display:grid;grid-template-columns:1fr 1fr;gap:3mm 8mm;font-size:3.6mm;color:#334155}
  .foot-item{display:flex;align-items:center;gap:2.5mm;font-weight:500}
  .foot-ico{display:inline-flex;width:4.6mm;height:4.6mm;color:#0f172a;flex-shrink:0}
  .foot-ico svg{width:100%;height:100%}
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
<script>
  window.addEventListener('load', function(){
    setTimeout(function(){ window.focus(); window.print(); }, 300);
  });
</script>
</body>
</html>`;

export default QrPosterDialog;
