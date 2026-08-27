import db, { getSettings, getPaperTypes } from "../db.js";
import { sendReply } from "./gmailService.js";

const CURRENCY = "DZD";

function formatMoney(amount) {
  return `${(Number(amount) || 0).toFixed(2)} ${CURRENCY}`;
}

const L10N = {
  en: {
    colorLabel: "Color",
    bwLabel: "B&W",
    defaultTemplate: [
      `Hi {customerName},`,
      ``,
      `Your print is ready for pickup:`,
      `• {fileName} — {pageCount} page(s) × {copies} copy/copies`,
      ``,
      `Amount due: {totalPrice}`,
      ``,
      `See you soon!`,
      `{shopName}`,
    ].join("\n"),
  },
  ar: {
    colorLabel: "ملون",
    bwLabel: "أبيض وأسود",
    defaultTemplate: [
      `مرحباً {customerName}،`,
      ``,
      `طلبك جاهز للاستلام:`,
      `• {fileName} — {pageCount} صفحة × {copies} نسخة`,
      ``,
      `المبلغ المستحق: {totalPrice}`,
      ``,
      `في انتظارك!`,
      `{shopName}`,
    ].join("\n"),
  },
};

function paperTypeLabel(paperTypes, paperTypeId, lang) {
  const p = paperTypes.find((pt) => pt.id === paperTypeId);
  if (!p) return paperTypeId;
  return lang === "ar" ? (p.nameAr || p.name) : p.name;
}

/**
 * Send a "your print is ready" reply on the original Gmail thread.
 * Idempotent: skips if job.notifiedReadyAt is already set, unless `force` is true.
 * Returns { sent: boolean, reason?: string }.
 */
export async function sendJobReadyNotification(jobId, { force = false } = {}) {
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
  if (!job) return { sent: false, reason: "job_not_found" };
  if (job.source !== "gmail") return { sent: false, reason: "not_gmail_source" };
  if (!job.gmailMessageId) return { sent: false, reason: "no_message_id" };
  if (!job.customerEmail) return { sent: false, reason: "no_customer_email" };
  if (job.notifiedReadyAt && !force) {
    return { sent: false, reason: "already_notified" };
  }

  const settings = getSettings();
  const paperTypes = getPaperTypes();
  const templateLang = settings.gmailReadyTemplateLang === "ar" ? "ar" : "en";
  const L = L10N[templateLang];
  const template = settings.gmailReadyTemplate || L.defaultTemplate;

  const pageCount = job.pageCount || 1;
  const copies = job.copies || 1;
  const paperLabel = paperTypeLabel(paperTypes, job.paperType, templateLang);
  const totalSheets = pageCount * copies;
  const mode = job.colorMode === "blackWhite" ? L.bwLabel : L.colorLabel;

  const paidAmount = Number(job.paymentAmount) || 0;
  const totalPrice = paidAmount; // paymentAmount holds the admin-recorded charge

  const body = template
    .replace(/\{shopName\}/g, settings.shopName || "Print Shop")
    .replace(/\{customerName\}/g, job.customerName || "there")
    .replace(/\{fileName\}/g, job.fileName || "your file")
    .replace(/\{pageCount\}/g, String(pageCount))
    .replace(/\{copies\}/g, String(copies))
    .replace(/\{totalSheets\}/g, String(totalSheets))
    .replace(/\{paperType\}/g, paperLabel)
    .replace(/\{colorMode\}/g, mode)
    .replace(/\{status\}/g, job.status)
    .replace(/\{totalPrice\}/g, formatMoney(totalPrice))
    .replace(/\{currency\}/g, CURRENCY);

  await sendReply(job.gmailMessageId, body);

  db.prepare("UPDATE jobs SET notifiedReadyAt = ? WHERE id = ?").run(
    new Date().toISOString(),
    jobId
  );

  return { sent: true };
}
