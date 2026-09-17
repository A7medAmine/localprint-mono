// HTML→PDF card for a saved customer credential — same pipeline as the QR
// poster (QrPosterDialog.tsx): build a self-contained HTML string, inline its
// local asset URLs to data URLs (the main process renders from a tmp file, so
// "/Inter.ttf" or a relative logo path would otherwise resolve against the
// drive root), then hand it to renderHtmlPdf/printData.
import type { CardPaperSize, Credential, CredentialCardFontScale, Language, ShopSettings } from "../types";
import { activeSocialLinks } from "@atba3li/shared/social";
import type { SocialPlatformId } from "@atba3li/shared/social";
import { BRAND_PATHS } from "@atba3li/shared/components/StoreSocialLinks";

export interface CredentialCardOptions {
  paperSize: CardPaperSize;
  includeWebsite: boolean;
  /** The shop's own social accounts (Settings → Social links), not the credential's. */
  includeShopSocial: boolean;
  /** The shop's own name/email/phone, printed as a small footer branding block. */
  includeShopContact: boolean;
  includeNotice: boolean;
}

interface CredentialCardProps {
  lang: Language;
  shopSettings: ShopSettings | null;
  credential: Credential;
  /** Shop-wide fallback, printed when the credential has no notice of its own. */
  defaultNotice: string;
  /** Pre-rendered SVG markup encoding credential.websiteUrl, or "" to skip it. */
  qrSvg: string;
  /** Scales text/spacing — the thermal-tuned default reads sparse on a full A4/A5 sheet. */
  fontScale: CredentialCardFontScale;
  options: CredentialCardOptions;
}

const FONT_SCALE_FACTOR: Record<CredentialCardFontScale, number> = {
  normal: 1,
  large: 1.3,
  xlarge: 1.6,
};

// Physical page size in mm. Thermal rolls have no real "page end", so a fixed
// height long enough for the card content is used rather than a continuous
// feed, which printToPDF has no concept of.
const PAGE_MM: Record<CardPaperSize, { w: number; h: number }> = {
  thermal58: { w: 58, h: 150 },
  thermal80: { w: 80, h: 150 },
  a5: { w: 148, h: 210 },
  a4: { w: 210, h: 297 },
};

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string),
  );

const svgIcon = (path: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

const PHONE_ICON = svgIcon(
  '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
);
const MAIL_ICON = svgIcon('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>');

/** Same convention as QrPosterDialog's poster: the brand mark, not the platform label. */
const socialIcon = (id: SocialPlatformId) =>
  id === "website"
    ? svgIcon(
        '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.5 3.8 5.6 3.8 9S14.5 18.5 12 21c-2.5-2.5-3.8-5.6-3.8-9S9.5 5.5 12 3z"/>',
      )
    : `<svg viewBox="0 0 24 24"><path fill="currentColor" fill-rule="evenodd" d="${BRAND_PATHS[id]}"/></svg>`;

const AT_HANDLE = new Set<SocialPlatformId>(["instagram", "tiktok", "telegram", "youtube"]);

/** Derives a short "@handle" (or hostname/phone) from a stored full URL —
 *  duplicated from QrPosterDialog.tsx's socialHandle, same reasoning: a
 *  40-character URL reads far worse on a small card than "@yourshop". */
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
  const raw = decodeURIComponent(segments[0]).replace(/^@/, "");
  if (!raw) return null;

  if (id === "whatsapp") {
    const digits = raw.replace(/\D/g, "");
    return digits ? `+${digits}` : null;
  }
  return AT_HANDLE.has(id) ? `@${raw}` : raw;
};

const buildCredentialCardInner = ({ lang, shopSettings, credential, defaultNotice, qrSvg, options }: CredentialCardProps) => {
  const isRtl = lang === "ar";
  const t = (en: string, ar: string) => (isRtl ? ar : en);
  const dir = isRtl ? "rtl" : "ltr";
  const shopName = shopSettings?.shopName || "Atba3li";
  const logo = shopSettings?.logoUrl || "";

  const row = (label: string, value: string, mono = false) =>
    value
      ? `<div class="row"><span class="row-label">${escapeHtml(label)}</span><span class="row-value${mono ? " mono" : ""}">${escapeHtml(value)}</span></div>`
      : "";

  const showWebsite = options.includeWebsite && !!credential.websiteUrl;
  const website = showWebsite ? row(t("Website", "الموقع"), credential.websiteUrl, true) : "";
  const qrBlock =
    showWebsite && qrSvg
      ? `<div class="qr-block">${qrSvg}<p class="qr-caption">${escapeHtml(t("Scan to open", "امسح للفتح"))}</p></div>`
      : "";

  const noticeText = credential.notice || (options.includeNotice ? defaultNotice : "");
  const notice = noticeText ? `<div class="notice">${escapeHtml(noticeText)}</div>` : "";

  // Shop's own contact line — phone(s) and email, same fields the QR poster prints.
  const contactBits = [
    ...(options.includeShopContact ? (shopSettings?.phoneNumbers?.filter(Boolean) || []) : []).map(
      (p) => `<span class="contact"><span class="ico">${PHONE_ICON}</span>${escapeHtml(p)}</span>`,
    ),
    ...(options.includeShopContact && shopSettings?.email
      ? [`<span class="contact"><span class="ico">${MAIL_ICON}</span>${escapeHtml(shopSettings.email)}</span>`]
      : []),
  ];
  const contactRow = contactBits.length ? `<div class="shop-contact">${contactBits.join("")}</div>` : "";

  // Shop's own social accounts — never the customer's (removed: a credential
  // is one account for one service, not a place to store the shop's brand).
  const socialBits = options.includeShopSocial
    ? activeSocialLinks(shopSettings?.socialLinks).map(({ platform, url: link }) => {
        const id = platform.id as SocialPlatformId;
        const handle = socialHandle(id, link) || (isRtl ? platform.labelAr : platform.label);
        return `<span class="social"><span class="ico brand">${socialIcon(id)}</span>${escapeHtml(handle)}</span>`;
      })
    : [];
  const socialRow = socialBits.length ? `<div class="shop-social">${socialBits.join("")}</div>` : "";

  return `
<div class="card" dir="${dir}">
  <header class="head">
    ${
      logo
        ? `<div class="logo"><img src="${escapeHtml(logo)}" alt=""/></div>`
        : ""
    }
    <span class="shop-name">${escapeHtml(shopName)}</span>
  </header>

  <div class="service">${escapeHtml(credential.serviceName)}</div>
  <div class="customer">${escapeHtml(credential.customerName)}</div>

  <div class="fields">
    ${row(t("Username", "اسم المستخدم"), credential.username, true)}
    ${row(t("Password", "كلمة المرور"), credential.password, true)}
    ${website}
  </div>

  ${qrBlock}

  ${notice}

  <footer class="foot">
    ${contactRow}
    ${socialRow}
    <p class="foot-line">${escapeHtml(t("Keep this card in a safe place.", "احتفظ بهذه البطاقة في مكان آمن."))}</p>
  </footer>
</div>
  `;
};

const credentialCardCss = (size: CardPaperSize, fontScale: CredentialCardFontScale) => {
  const { w, h } = PAGE_MM[size];
  const isThermal = size === "thermal58" || size === "thermal80";
  // Text/spacing scale up together — only the thermal sizes on A4/A5 (a
  // thermal-width card centered on a full sheet still needs to stay narrow;
  // "large"/"xlarge" is meant for a4/a5 specifically, so thermal ignores it).
  const scale = isThermal ? 1 : FONT_SCALE_FACTOR[fontScale];
  // mm(x[, y]) → "{x*scale}mm" or "{x*scale}mm {y*scale}mm" for gap/padding shorthands.
  const mm = (...vals: number[]) => vals.map((v) => `${+(v * scale).toFixed(2)}mm`).join(" ");
  return `
  @font-face{font-family:'CardSans';src:url('/Inter.ttf') format('truetype-variations');font-weight:100 900;font-display:block}
  @font-face{font-family:'CardArabic';src:url('/Rubik.ttf') format('truetype-variations');font-weight:300 900;font-display:block}

  *{box-sizing:border-box;margin:0;padding:0}
  html,body{background:#fff;color:#161616;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{font-family:'CardSans','CardArabic','Segoe UI',Arial,sans-serif;-webkit-font-smoothing:antialiased}

  .card{width:${w}mm;min-height:${h}mm;display:flex;flex-direction:column;padding:${mm(isThermal ? 4 : 10)};gap:${mm(isThermal ? 2.5 : 4)}}

  .head{display:flex;align-items:center;gap:${mm(2.5)};padding-bottom:${mm(isThermal ? 2 : 3)};border-bottom:0.35mm dashed #9ca3af}
  .logo{width:${mm(isThermal ? 6 : 10)};height:${mm(isThermal ? 6 : 10)};flex-shrink:0;overflow:hidden;border-radius:1.5mm}
  .logo img{width:100%;height:100%;object-fit:contain}
  .shop-name{font-weight:700;font-size:${mm(isThermal ? 3.4 : 4.5)}}

  .service{font-weight:700;font-size:${mm(isThermal ? 4.2 : 6)};margin-top:${mm(isThermal ? 1 : 1.5)}}
  .customer{font-size:${mm(isThermal ? 3.2 : 4)};color:#4b5563}

  .fields{display:flex;flex-direction:column;gap:${mm(isThermal ? 1.6 : 2.5)};margin-top:${mm(isThermal ? 1 : 2)};padding:${mm(isThermal ? 2.5 : 3.5)};border:0.35mm solid #d1d5db;border-radius:2mm}
  .row{display:flex;justify-content:space-between;align-items:baseline;gap:3mm}
  .row-label{font-size:${mm(isThermal ? 2.6 : 3.2)};color:#6b7280;flex-shrink:0}
  .row-value{font-size:${mm(isThermal ? 3.2 : 4)};font-weight:600;text-align:end;word-break:break-all}
  .row-value.mono{font-family:'Consolas','Menlo',monospace;direction:ltr;unicode-bidi:plaintext}

  .qr-block{text-align:center}
  .qr-block svg{width:${mm(isThermal ? 22 : 28)};height:${mm(isThermal ? 22 : 28)};display:inline-block}
  .qr-caption{margin-top:1mm;font-size:${mm(isThermal ? 2.3 : 2.8)};color:#6b7280}

  .notice{font-size:${mm(isThermal ? 2.6 : 3.4)};line-height:1.4;color:#7c2d12;background:#fff7ed;border:0.3mm solid #fdba74;border-radius:2mm;padding:${mm(isThermal ? 2 : 3)}}

  .foot{margin-top:auto;padding-top:${mm(isThermal ? 1.5 : 3)};border-top:0.3mm solid #f1f2f4;text-align:center}
  .shop-contact,.shop-social{display:flex;flex-wrap:wrap;justify-content:center;gap:${mm(isThermal ? 1.5 : 2, isThermal ? 3 : 5)};font-size:${mm(isThermal ? 2.4 : 3)};color:#4b5563;margin-bottom:${mm(isThermal ? 1.5 : 2)}}
  .contact,.social{display:inline-flex;align-items:center;gap:1.2mm}
  .ico{display:inline-flex;width:${mm(isThermal ? 2.6 : 3.2)};height:${mm(isThermal ? 2.6 : 3.2)};flex-shrink:0}
  .ico svg{width:100%;height:100%}
  .ico.brand{color:#6b7280}
  .foot-line{font-size:${mm(isThermal ? 2.3 : 2.8)};color:#9aa0a8}

  [dir="rtl"] .row-value.mono{text-align:right}
  @page{size:${w}mm ${h}mm;margin:0}
`;
};

export const buildCredentialCardHtml = (props: CredentialCardProps) => `<!doctype html>
<html lang="${props.lang}" dir="${props.lang === "ar" ? "rtl" : "ltr"}">
<head>
<meta charset="utf-8"/>
<title>${escapeHtml(props.credential.customerName || "Credential Card")}</title>
<style>${credentialCardCss(props.options.paperSize, props.fontScale)}</style>
</head>
<body>
${buildCredentialCardInner(props)}
</body>
</html>`;

// Same asset-inlining approach as QrPosterDialog.tsx's inlinePosterAssets —
// duplicated here (not shared) since it's a small, self-contained helper and
// the two callers have no other coupling.
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

export const inlineCardAssets = async (html: string): Promise<string> => {
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
      out = out.replace(new RegExp(`src:url\\('${escaped}'\\)[^;}]*;?`, "g"), "");
    }
  });
  return out;
};
