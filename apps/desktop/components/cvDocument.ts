// Renders a CvProfile to a self-contained HTML document, same approach as
// credentialCard.ts's buildCredentialCardHtml: a single string with inline
// <style>, fed to renderHtmlPdf (Electron) or printed via an iframe.
import type { CvDocument, CvEntry, CvProfile, CvTemplateId } from "../types";

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string),
  );

// Multi-line free text (summary, custom sections) → one <p> per non-empty line.
const paragraphs = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("");

type LabelKey =
  | "contact" | "summary" | "experience" | "education" | "skills" | "languages"
  | "email" | "phone" | "address" | "cvTitle" | "civil" | "fullName" | "jobTitle";

const LABELS: Record<LabelKey, Record<CvDocument["language"], string>> = {
  contact: { ar: "معلومات التواصل", en: "Contact", fr: "Contact" },
  summary: { ar: "نبذة عني", en: "Summary", fr: "Profil" },
  experience: { ar: "الخبرة المهنية", en: "Experience", fr: "Expérience" },
  education: { ar: "التعليم", en: "Education", fr: "Formation" },
  skills: { ar: "المهارات", en: "Skills", fr: "Compétences" },
  languages: { ar: "اللغات", en: "Languages", fr: "Langues" },
  email: { ar: "البريد الإلكتروني", en: "Email", fr: "E-mail" },
  phone: { ar: "الهاتف", en: "Phone", fr: "Téléphone" },
  address: { ar: "العنوان", en: "Address", fr: "Adresse" },
  cvTitle: { ar: "السيرة الذاتية", en: "Curriculum Vitae", fr: "Curriculum Vitae" },
  civil: { ar: "معلومات الحالة المدنية", en: "Personal details", fr: "État civil" },
  fullName: { ar: "الاسم واللقب", en: "Full name", fr: "Nom et prénom" },
  jobTitle: { ar: "المهنة", en: "Job title", fr: "Profession" },
};

interface CvDocumentProps {
  profile: CvProfile;
  /** The photo already resolved to a data: URL — renderHtmlPdf needs a self-contained document. */
  photoDataUrl: string | null;
}

const ACCENTS: Record<CvTemplateId, string> = {
  modern: "#4f46e5",
  classic: "#1f2937",
  minimal: "#0f766e",
  azure: "#1b3b6f",
};

const entrySection = (entries: CvEntry[], accent: string) =>
  entries
    .map(
      (e) => `
    <div class="entry">
      <div class="entry-head">
        <span class="entry-title">${escapeHtml(e.title)}</span>
        ${e.period ? `<span class="entry-period">${escapeHtml(e.period)}</span>` : ""}
      </div>
      ${e.subtitle ? `<div class="entry-subtitle" style="color:${accent}">${escapeHtml(e.subtitle)}</div>` : ""}
      ${e.description ? `<div class="entry-desc">${paragraphs(e.description)}</div>` : ""}
    </div>`,
    )
    .join("");

const buildCvInner = ({ profile, photoDataUrl }: CvDocumentProps) => {
  const { data } = profile;
  const isRtl = data.language === "ar";
  const L = (key: LabelKey) => LABELS[key][data.language];
  const accent = ACCENTS[data.templateId];

  const contactBits = [
    profile.phone ? `<span>${escapeHtml(L("phone"))}: ${escapeHtml(profile.phone)}</span>` : "",
    data.email ? `<span>${escapeHtml(L("email"))}: ${escapeHtml(data.email)}</span>` : "",
    data.address ? `<span>${escapeHtml(L("address"))}: ${escapeHtml(data.address)}</span>` : "",
  ].filter(Boolean);

  const section = (key: LabelKey, body: string) =>
    body ? `<section class="section"><h2 style="color:${accent}">${escapeHtml(L(key))}</h2>${body}</section>` : "";

  return `
<div class="page" dir="${isRtl ? "rtl" : "ltr"}">
  <header class="head">
    ${data.fields.photo && photoDataUrl ? `<div class="photo"><img src="${photoDataUrl}" alt=""/></div>` : ""}
    <div class="head-text">
      <h1>${escapeHtml(profile.fullName)}</h1>
      ${data.jobTitle ? `<div class="job-title" style="color:${accent}">${escapeHtml(data.jobTitle)}</div>` : ""}
      ${data.fields.contact && contactBits.length ? `<div class="contact-row">${contactBits.join('<span class="dot">•</span>')}</div>` : ""}
    </div>
  </header>

  ${data.fields.summary && data.summary ? section("summary", `<div class="summary">${paragraphs(data.summary)}</div>`) : ""}
  ${data.fields.experience && data.experience.length ? section("experience", entrySection(data.experience, accent)) : ""}
  ${data.fields.education && data.education.length ? section("education", entrySection(data.education, accent)) : ""}
  ${data.fields.skills && data.skills.length ? section("skills", `<div class="chips">${data.skills.map((s) => `<span class="chip">${escapeHtml(s)}</span>`).join("")}</div>`) : ""}
  ${data.fields.languages && data.languagesSpoken.length ? section("languages", `<div class="chips">${data.languagesSpoken.map((s) => `<span class="chip">${escapeHtml(s)}</span>`).join("")}</div>`) : ""}
  ${data.customSections
    .map((s) => (s.title || s.content ? `<section class="section"><h2 style="color:${accent}">${escapeHtml(s.title)}</h2><div class="summary">${paragraphs(s.content)}</div></section>` : ""))
    .join("")}
</div>`;
};

const cvCss = (templateId: CvTemplateId) => {
  const accent = ACCENTS[templateId];
  const serif = templateId === "classic";
  return `
  @font-face{font-family:'CvSans';src:url('/Inter.ttf') format('truetype-variations');font-weight:100 900;font-display:block}
  @font-face{font-family:'CvArabic';src:url('/Rubik.ttf') format('truetype-variations');font-weight:300 900;font-display:block}

  *{box-sizing:border-box;margin:0;padding:0}
  html,body{background:#fff;color:#1f2937;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{font-family:${serif ? "Georgia,'Times New Roman'," : ""}'CvSans','CvArabic','Segoe UI',Arial,sans-serif;-webkit-font-smoothing:antialiased}

  .page{width:210mm;min-height:297mm;padding:16mm 18mm}

  .head{display:flex;align-items:center;gap:8mm;padding-bottom:6mm;border-bottom:${templateId === "minimal" ? "0.3mm solid #e5e7eb" : `1.2mm solid ${accent}`}}
  .photo{width:28mm;height:28mm;flex-shrink:0;border-radius:${templateId === "modern" ? "50%" : "2mm"};overflow:hidden;background:#f3f4f6}
  .photo img{width:100%;height:100%;object-fit:cover}
  .head-text h1{font-size:9mm;font-weight:700;letter-spacing:${templateId === "minimal" ? "0.5mm" : "0"}}
  .job-title{font-size:4.5mm;font-weight:600;margin-top:1mm}
  .contact-row{margin-top:2.5mm;font-size:3.3mm;color:#6b7280;display:flex;flex-wrap:wrap;gap:1.5mm}
  .contact-row .dot{margin:0 1mm;color:#d1d5db}

  .section{margin-top:7mm}
  .section h2{font-size:4.2mm;font-weight:700;text-transform:uppercase;letter-spacing:0.4mm;margin-bottom:3mm;padding-bottom:1.5mm;border-bottom:0.3mm solid #e5e7eb}
  .summary p{font-size:3.6mm;line-height:1.6;margin-bottom:1.5mm;color:#374151}

  .entry{margin-bottom:4.5mm}
  .entry-head{display:flex;justify-content:space-between;align-items:baseline;gap:4mm}
  .entry-title{font-size:3.9mm;font-weight:700}
  .entry-period{font-size:3.2mm;color:#9ca3af;white-space:nowrap}
  .entry-subtitle{font-size:3.5mm;font-weight:600;margin-top:0.5mm}
  .entry-desc p{font-size:3.4mm;line-height:1.55;color:#4b5563;margin-top:1mm}

  .chips{display:flex;flex-wrap:wrap;gap:2mm}
  .chip{font-size:3.3mm;padding:1.2mm 3mm;border-radius:${templateId === "modern" ? "10mm" : "1.5mm"};background:#f3f4f6;color:#374151}

  [dir="rtl"] .entry-period{text-align:left}
  @page{size:210mm 297mm;margin:0}
`;
};


// ---------------------------------------------------------------------------
// "azure" template — the Algerian administrative CV layout: navy wave artwork
// behind the page, and every section introduced by a gradient title bar.
// It reuses the same CvDocument data, only laid out differently.
// ---------------------------------------------------------------------------

const azureBullets = (items: string[]) =>
  items.length ? `<ul class="az-list">${items.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>` : "";

const azureEntryLines = (entries: CvEntry[]) =>
  entries
    .map((e) => [e.title, e.subtitle, e.period].map((v) => v.trim()).filter(Boolean).join(" — "))
    .filter(Boolean);

const buildAzureInner = ({ profile, photoDataUrl }: CvDocumentProps) => {
  const { data } = profile;
  const isRtl = data.language === "ar";
  const L = (key: LabelKey) => LABELS[key][data.language];

  const bar = (title: string, body: string) =>
    body ? `<section class="az-section"><div class="az-bar"><span>${escapeHtml(title)} :</span></div>${body}</section>` : "";

  const civilRow = (label: string, value: string) =>
    value ? `<div class="az-row"><span class="az-label">${escapeHtml(label)} :</span> <span class="az-value">${escapeHtml(value)}</span></div>` : "";

  const civil = [
    civilRow(L("fullName"), profile.fullName),
    civilRow(L("jobTitle"), data.jobTitle),
    civilRow(L("address"), data.address),
    civilRow(L("email"), data.email),
    civilRow(L("phone"), profile.phone),
  ].join("");

  return `
<div class="az-page" dir="${isRtl ? "rtl" : "ltr"}">
  <svg class="az-art" viewBox="0 0 210 297" preserveAspectRatio="none" aria-hidden="true">
    <path d="M0,0 H158 C120,52 66,54 42,118 C20,176 18,238 0,272 Z" fill="#dbe4ef"/>
    <path d="M0,0 H126 C94,48 46,60 28,122 C12,178 14,232 0,258 Z" fill="#b6c8de"/>
    <path d="M0,278 C52,264 120,294 210,268 V297 H0 Z" fill="#dbe4ef"/>
    <path d="M0,287 C56,276 122,297 210,281 V297 H0 Z" fill="#2d5486"/>
  </svg>

  <header class="az-head">
    ${data.fields.photo && photoDataUrl ? `<div class="az-photo"><img src="${photoDataUrl}" alt=""/></div>` : ""}
    <h1 class="az-title">${escapeHtml(L("cvTitle"))}</h1>
  </header>

  ${bar(L("civil"), data.fields.contact || civil ? `<div class="az-civil">${civil}</div>` : "")}
  ${data.fields.summary && data.summary ? bar(L("summary"), `<div class="az-text">${paragraphs(data.summary)}</div>`) : ""}
  ${data.fields.education && data.education.length ? bar(L("education"), azureBullets(azureEntryLines(data.education))) : ""}
  ${data.fields.experience && data.experience.length ? bar(L("experience"), azureBullets(azureEntryLines(data.experience))) : ""}
  ${data.fields.skills && data.skills.length ? bar(L("skills"), azureBullets(data.skills)) : ""}
  ${data.fields.languages && data.languagesSpoken.length ? bar(L("languages"), azureBullets(data.languagesSpoken)) : ""}
  ${data.customSections
    .map((s) => (s.title || s.content ? bar(s.title, `<div class="az-text">${paragraphs(s.content)}</div>`) : ""))
    .join("")}
</div>`;
};

const azureCss = () => `
  @font-face{font-family:'CvSans';src:url('/Inter.ttf') format('truetype-variations');font-weight:100 900;font-display:block}
  @font-face{font-family:'CvArabic';src:url('/Rubik.ttf') format('truetype-variations');font-weight:300 900;font-display:block}

  *{box-sizing:border-box;margin:0;padding:0}
  html,body{background:#fff;color:#111827;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{font-family:'CvArabic','CvSans','Segoe UI',Arial,sans-serif;-webkit-font-smoothing:antialiased}

  .az-page{position:relative;width:210mm;min-height:297mm;padding:14mm 16mm;overflow:hidden}
  .az-art{position:absolute;inset:0;width:100%;height:100%;z-index:0}
  .az-page > *:not(.az-art){position:relative;z-index:1}

  .az-head{display:flex;align-items:center;justify-content:space-between;gap:6mm;margin-bottom:6mm}
  .az-photo{width:26mm;height:26mm;border-radius:2mm;overflow:hidden;background:#f3f4f6;border:0.6mm solid #fff}
  .az-photo img{width:100%;height:100%;object-fit:cover}
  .az-title{font-size:9mm;font-weight:800;color:#0f2747;background:#eaf0f7;padding:1.5mm 8mm;border-radius:1mm;letter-spacing:0.4mm}

  .az-section{margin-bottom:5mm}
  .az-bar{background:linear-gradient(to left,#0f2747,#3f6ea8);color:#fff;border-radius:1.2mm;padding:2mm 5mm;font-size:4.4mm;font-weight:800;box-shadow:0 0.6mm 1.2mm rgba(15,39,71,0.25)}
  [dir="ltr"] .az-bar{background:linear-gradient(to right,#0f2747,#3f6ea8)}

  .az-civil{padding:3mm 8mm 0}
  .az-row{font-size:4mm;line-height:1.9;font-weight:600;color:#111827}
  .az-label{font-weight:800;border-bottom:0.4mm solid #0f2747}
  .az-value{font-weight:500}

  .az-list{padding:3mm 12mm 0;list-style:disc;list-style-position:inside}
  .az-list li{font-size:3.9mm;font-weight:700;line-height:1.9;color:#111827}
  .az-text p{font-size:3.8mm;line-height:1.7;padding:0 8mm;color:#1f2937}

  @page{size:210mm 297mm;margin:0}
`;

export const buildCvHtml = (props: CvDocumentProps) => `<!doctype html>
<html lang="${props.profile.data.language}" dir="${props.profile.data.language === "ar" ? "rtl" : "ltr"}">
<head>
<meta charset="utf-8"/>
<title>${escapeHtml(props.profile.fullName || "CV")}</title>
<style>${props.profile.data.templateId === "azure" ? azureCss() : cvCss(props.profile.data.templateId)}</style>
</head>
<body>
${props.profile.data.templateId === "azure" ? buildAzureInner(props) : buildCvInner(props)}
</body>
</html>`;
