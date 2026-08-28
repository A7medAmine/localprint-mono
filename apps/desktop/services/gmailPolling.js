import { fetchUnreadEmails } from "./gmailService.js";
import { saveAttachment, getAttachmentFullPath } from "./attachmentService.js";
import { countPagesForFile } from "./pageCountService.js";
import { calculateJobDiscount } from "../utils/discountLogic.js";
import db, {
  getGmailAccount,
  isEmailProcessed,
  markEmailProcessed,
  isEmailPending,
  addPendingEmail,
  removePendingEmail,
  softDeletePendingEmail,
  getPendingEmailById,
  getSettings,
  getPaperTypes,
  getActiveDiscountRules,
} from "../db.js";

const CURRENCY = "DZD";

function resolvePricePerPage(paperTypes, pricing, paperTypeId, colorMode) {
  const isBW = colorMode === "blackWhite";
  const paper = paperTypes.find((pt) => pt.id === paperTypeId);
  if (paper) {
    return isBW ? paper.blackWhitePerPage : paper.colorPerPage;
  }
  // Fallback to top-level pricing keys when the paper type is unknown.
  const fallback = paperTypeId === "glossy"
    ? pricing.glossyPerPage
    : paperTypeId === "cardboard"
      ? pricing.cardboardPerPage
      : (isBW ? pricing.blackWhitePerPage : pricing.colorPerPage);
  if (typeof fallback === "number") return fallback;
  return isBW ? 15 : 30;
}

function formatMoney(amount) {
  return `${(Number(amount) || 0).toFixed(2)} ${CURRENCY}`;
}

// Language-dependent strings substituted into email templates. The template
// itself is free text the admin wrote — this only covers *values* we inject.
const L10N = {
  en: {
    colorLabel: "Color",
    bwLabel: "B&W",
    pages: (n) => `${n} page(s)`,
    copies: (n) => `${n} ${n === 1 ? "copy" : "copies"}`,
    discountFallback: "discount",
    noRule: "—",
    bullet: "• ",
  },
  ar: {
    colorLabel: "ملون",
    bwLabel: "أبيض وأسود",
    pages: (n) => `${n} صفحة`,
    copies: (n) => `${n} نسخة`,
    discountFallback: "خصم",
    noRule: "—",
    bullet: "• ",
  },
};

function paperTypeLabel(paperTypes, paperTypeId, lang) {
  const p = paperTypes.find((pt) => pt.id === paperTypeId);
  if (!p) return paperTypeId;
  return lang === "ar" ? (p.nameAr || p.name) : p.name;
}

let pollingInterval = null;
const DEFAULT_INTERVAL_MS = 60 * 1000;
export let lastPolledAt = null;

// SSE broadcast callback — set by server.js to push events to browser clients
let newEmailCallback = null;
export function setNewEmailCallback(fn) {
  newEmailCallback = fn;
}

function extractBody(payload) {
  if (payload.body && payload.body.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf8");
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return Buffer.from(part.body.data, "base64").toString("utf8");
      }
    }
    for (const part of payload.parts) {
      const result = extractBody(part);
      if (result) return result;
    }
  }
  return "";
}

function extractAttachmentsMeta(payload) {
  const attachments = [];
  function walk(parts) {
    if (!parts) return;
    for (const part of parts) {
      if (
        part.filename &&
        part.filename.length > 0 &&
        part.body?.attachmentId
      ) {
        attachments.push({
          filename: part.filename,
          mimeType: part.mimeType,
          attachmentId: part.body.attachmentId,
          size: part.body.size,
        });
      }
      if (part.parts) walk(part.parts);
    }
  }
  if (payload.parts) walk(payload.parts);
  return attachments;
}

function parseFromHeader(fromHeader) {
  const match = fromHeader.match(/^(.+?)\s*<(.+@.+)>$/);
  if (match) {
    return {
      name: match[1].trim().replace(/^"/, "").replace(/"$/, ""),
      email: match[2],
    };
  }
  return { name: fromHeader || "Unknown", email: fromHeader || "" };
}

function getHeader(headers, name) {
  const h = headers.find((h) => h.name === name);
  return h ? h.value : "";
}

/**
 * Poll Gmail inbox — only fetches metadata and queues new emails for user review.
 */
export async function pollGmail() {
  const account = getGmailAccount();
  if (!account || !account.is_active) {
    return { error: "No Gmail account connected" };
  }

  try {
    const { messages: emails, truncated } = await fetchUnreadEmails();
    console.log(`📨 Gmail poll: found ${emails.length} unread email(s)`);
    if (truncated) {
      console.warn(
        "[Gmail] Inbox has more than 100 unread messages — some were skipped this cycle"
      );
    }

    let newCount = 0;
    let skippedCount = 0;

    for (const msg of emails) {
      const messageId = msg.id;

      if (isEmailProcessed(messageId) || isEmailPending(messageId)) {
        skippedCount++;
        continue;
      }

      const headers = msg.payload.headers;
      const fromHeader = getHeader(headers, "From");
      const subject = getHeader(headers, "Subject");
      const date = getHeader(headers, "Date");
      const { name, email } = parseFromHeader(fromHeader);
      const body = extractBody(msg.payload);
      const attachments = extractAttachmentsMeta(msg.payload);

      addPendingEmail({
        gmailMessageId: messageId,
        from: name,
        emailAddress: email,
        subject,
        bodyPreview: body.substring(0, 500),
        attachmentMeta: attachments,
        receivedAt: date,
      });

      newCount++;
      if (attachments.length > 0) {
        console.log(
          `  📎 Queued "${subject}" from ${email} (${attachments.length} attachment(s))`
        );
      }
    }

    lastPolledAt = new Date().toISOString();

    if (newCount > 0 && newEmailCallback) {
      newEmailCallback(newCount);
    }

    return { new: newCount, skipped: skippedCount };
  } catch (err) {
    console.error("❌ Gmail poll error:", err.message);
    return { error: err.message };
  }
}

/**
 * Import selected pending emails: download attachments and create print jobs.
 */
export async function importPendingEmails(pendingIds, overrides = {}) {
  const account = getGmailAccount();
  if (!account || !account.is_active) {
    return { error: "No Gmail account connected" };
  }

  const results = [];

  for (const id of pendingIds) {
    try {
      const pending = getPendingEmailById(id);
      if (!pending) {
        results.push({ id, error: "Not found" });
        continue;
      }

      const jobs = [];
      const jobFileNames = [];
      const jobDetails = []; // { fileName, pageCount, copies, colorMode, paperTypeId, pricePerPage, totalPrice }

      // Snapshot pricing config once per email so all attachments quote the same rates.
      const settingsSnapshot = getSettings();
      const pricingSnapshot = settingsSnapshot.pricing || {};
      const paperTypesSnapshot = getPaperTypes();
      const activeDiscountRules = getActiveDiscountRules();

      for (
        let attIdx = 0;
        attIdx < (pending.attachment_meta || []).length;
        attIdx++
      ) {
        const att = pending.attachment_meta[attIdx];
        try {
          const gmail = await (
            await import("./gmailService.js")
          ).getGmailClient();
          const attResponse = await gmail.users.messages.attachments.get({
            userId: "me",
            messageId: pending.gmail_message_id,
            id: att.attachmentId,
          });

          const savedPath = await saveAttachment(
            att.filename,
            att.mimeType,
            attResponse.data.data,
            pending.gmail_message_id
          );
          if (!savedPath) continue;

          const jobId = `gmail_${
            pending.gmail_message_id
          }_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

          const overrideKey = `${pending.id}_${attIdx}`;
          const ov = overrides[overrideKey] || {};
          const colorMode = ov.colorMode || "color";
          const copies = parseInt(ov.copies) || 1;
          const paperType = ov.paperType || "normal";

          const pageCount = await countPagesForFile(
            getAttachmentFullPath(savedPath),
            att.mimeType
          );
          const pricePerPage = resolvePricePerPage(
            paperTypesSnapshot,
            pricingSnapshot,
            paperType,
            colorMode
          );
          const totalPrice = pricePerPage * pageCount * copies;
          const totalSheets = pageCount * copies;
          const discountResult = calculateJobDiscount(
            totalPrice,
            totalSheets,
            activeDiscountRules
          );

          db.prepare(
            `
            INSERT INTO jobs (
              id, customerName, customerEmail, notes, fileName, fileType,
              fileSize, uploadDate, status, serverFileName, pageCount,
              colorMode, copies, paperType, source, gmailMessageId
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
          ).run(
            jobId,
            pending.email_from,
            pending.email_address,
            `From: ${pending.subject}\n\n${pending.body_preview}`,
            att.filename,
            att.mimeType,
            att.size || 0,
            new Date().toISOString(),
            "PENDING",
            savedPath,
            pageCount,
            colorMode,
            copies,
            paperType,
            "gmail",
            pending.gmail_message_id
          );

          jobs.push(jobId);
          jobFileNames.push(att.filename);
          jobDetails.push({
            fileName: att.filename,
            pageCount,
            copies,
            colorMode,
            paperTypeId: paperType,
            pricePerPage,
            originalPrice: totalPrice,
            discountAmount: discountResult.discountAmount,
            finalPrice: discountResult.finalAmount,
            discountRule: discountResult.rule,
          });
        } catch (err) {
          console.error(
            `  ❌ Failed to import attachment ${att.filename}:`,
            err.message
          );
        }
      }

      // Mark as read & processed
      try {
        const { markAsRead } = await import("./gmailService.js");
        await markAsRead(pending.gmail_message_id);
      } catch (err) {
        console.warn(
          `⚠️  Could not mark message ${pending.gmail_message_id} as read:`,
          err.message
        );
      }

      markEmailProcessed(pending.gmail_message_id);
      removePendingEmail(id);

      results.push({ id: pending.id, subject: pending.subject, jobs });
      console.log(`  ✅ Imported "${pending.subject}" → ${jobs.length} job(s)`);

      // Auto-reply using template
      try {
        const { sendReply } = await import("./gmailService.js");

        const templateLang = settingsSnapshot.gmailReplyTemplateLang === "ar" ? "ar" : "en";
        const L = L10N[templateLang];

        const originalTotal = jobDetails.reduce((sum, j) => sum + j.originalPrice, 0);
        const totalDiscount = jobDetails.reduce((sum, j) => sum + j.discountAmount, 0);
        const finalTotal = jobDetails.reduce((sum, j) => sum + j.finalPrice, 0);
        const savingsPercentage = originalTotal > 0
          ? Math.round((totalDiscount / originalTotal) * 10000) / 100
          : 0;
        const totalPages = jobDetails.reduce((sum, j) => sum + j.pageCount, 0);
        const totalCopies = jobDetails.reduce((sum, j) => sum + j.copies, 0);
        const totalSheets = jobDetails.reduce(
          (sum, j) => sum + j.pageCount * j.copies,
          0
        );
        const appliedRuleNames = Array.from(
          new Set(jobDetails.map((j) => j.discountRule?.name).filter(Boolean))
        ).join(", ");

        const template =
          settingsSnapshot.gmailReplyTemplate ||
          [
            `Thank you for your print request!`,
            ``,
            `We have received your file(s) and will process them shortly.`,
            jobs.length > 0 ? `Files received: {fileCount}` : "",
            jobDetails.length > 0 ? `{jobBreakdown}` : "",
            jobDetails.length > 0 ? `Estimated total: {totalPrice}` : "",
            ``,
            `We will notify you when your prints are ready.`,
            ``,
            `Best regards,`,
            `{shopName}`,
          ]
            .filter(Boolean)
            .join("\n");

        const jobBreakdown = jobDetails
          .map((j) => {
            const mode = j.colorMode === "blackWhite" ? L.bwLabel : L.colorLabel;
            const paperLabel = paperTypeLabel(paperTypesSnapshot, j.paperTypeId, templateLang);
            const priceStr = j.discountAmount > 0
              ? `${formatMoney(j.originalPrice)} → ${formatMoney(j.finalPrice)} (${j.discountRule?.name || L.discountFallback})`
              : formatMoney(j.finalPrice);
            return `${L.bullet}${j.fileName} — ${L.pages(j.pageCount)} × ${L.copies(j.copies)} · ${mode} · ${paperLabel} = ${priceStr}`;
          })
          .join("\n");

        // First priced job — powers single-value placeholders like {pageCount}/{copies}
        // when the email carries only one attachment (the typical case).
        const first = jobDetails[0] || null;
        const fileNames = jobFileNames.join(", ");

        const replyBody = template
          .replace(/\{shopName\}/g, settingsSnapshot.shopName || "Print Shop")
          .replace(/\{fileName\}/g, fileNames || "your file")
          .replace(/\{fileCount\}/g, jobs.length.toString())
          .replace(/\{jobBreakdown\}/g, jobBreakdown || L.noRule)
          // {totalPrice} = discounted final. Use {originalTotal} for pre-discount.
          .replace(/\{totalPrice\}/g, formatMoney(finalTotal))
          .replace(/\{originalTotal\}/g, formatMoney(originalTotal))
          .replace(/\{discountAmount\}/g, formatMoney(totalDiscount))
          .replace(/\{savingsPercentage\}/g, `${savingsPercentage}%`)
          .replace(/\{discountRule\}/g, appliedRuleNames || L.noRule)
          .replace(/\{totalPages\}/g, totalPages.toString())
          .replace(/\{totalCopies\}/g, totalCopies.toString())
          .replace(/\{totalSheets\}/g, totalSheets.toString())
          .replace(/\{pageCount\}/g, (first?.pageCount ?? totalPages).toString())
          .replace(/\{copies\}/g, (first?.copies ?? totalCopies).toString())
          .replace(/\{currency\}/g, CURRENCY)
          // Back-compat: legacy templates using {estimatedPrice} now get the
          // discounted total (formatted) — matching what the dashboard shows.
          .replace(/\{estimatedPrice\}/g, formatMoney(finalTotal));

        await sendReply(pending.gmail_message_id, replyBody);
        console.log(
          `  📧 Auto-reply sent for "${pending.subject}" — quoted ${formatMoney(finalTotal)}${totalDiscount > 0 ? ` (saved ${formatMoney(totalDiscount)})` : ""} across ${jobDetails.length} file(s)`
        );
      } catch (err) {
        console.warn(`⚠️  Could not send auto-reply:`, err.message);
      }
    } catch (err) {
      console.error(`❌ Error importing email id=${id}:`, err.message);
      results.push({ id, error: err.message });
    }
  }

  return { imported: results };
}

/**
 * Discard a pending email without importing.
 */
export function getPollStatus() {
  return { lastPolledAt, isPolling: pollingInterval !== null };
}

export function discardPendingEmail(id) {
  softDeletePendingEmail(id);
}

export function startPolling(intervalMs) {
  stopPolling();
  const ms = intervalMs || DEFAULT_INTERVAL_MS;
  console.log(`⏰ Starting Gmail polling every ${ms / 1000}s`);
  pollingInterval = setInterval(() => {
    pollGmail().catch((err) => console.error("❌ Polling error:", err));
  }, ms);
}

export function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    console.log("⏹️  Gmail polling stopped");
  }
}

export function restartPolling(intervalMs) {
  stopPolling();
  const ms = intervalMs || DEFAULT_INTERVAL_MS;
  pollingInterval = setInterval(() => {
    pollGmail().catch((err) => console.error("❌ Polling error:", err));
  }, ms);
  console.log(`⏰ Restarted Gmail polling every ${ms / 1000}s`);
}
