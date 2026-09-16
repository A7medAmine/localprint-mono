/**
 * The single price + discount calculator, shared by both React clients and both
 * Node servers so the client quote and the server-authoritative recompute are
 * literally the same code. Kept in .js (not .ts) so server.js can import it;
 * TypeScript consumers get types from the co-located pricing.d.ts. Consumed via
 * the "@atba3li/shared/pricing" subpath export.
 *
 * The page-count heuristics (countPdfPages / countWordPages / getActualPageCount)
 * use the browser File API and only run client-side; they are safe to import in
 * Node because the File/FileReader references live inside the function bodies,
 * never at module load.
 */
import { calculateJobDiscount as calculateJobDiscountCore } from "./discountLogic.js";

export const DEFAULT_PAPER_TYPES = (pricing) => [
  { id: "normal", name: "Normal", nameAr: "عادي", colorPerPage: pricing?.colorPerPage ?? 30.0, blackWhitePerPage: pricing?.blackWhitePerPage ?? 15.0 },
  { id: "glossy", name: "Glossy", nameAr: "لامع", colorPerPage: pricing?.glossyPerPage ?? 50.0, blackWhitePerPage: pricing?.glossyPerPage ?? 50.0 },
  { id: "cardboard", name: "Cardboard", nameAr: "ورق مقوى", colorPerPage: pricing?.cardboardPerPage ?? 40.0, blackWhitePerPage: pricing?.cardboardPerPage ?? 40.0 },
];

export const calculatePrintPrice = (job, settings, actualPages = 1) => {
  const paperTypeId = job.printPreferences?.paperType || "normal";
  const colorMode = job.printPreferences?.colorMode || "color";

  const allPaperTypes = settings.paperTypes && settings.paperTypes.length > 0
    ? settings.paperTypes
    : DEFAULT_PAPER_TYPES(settings.pricing);

  const paperType = allPaperTypes.find((pt) => pt.id === paperTypeId);

  const pricePerPage = paperType
    ? (colorMode === "blackWhite" ? paperType.blackWhitePerPage : paperType.colorPerPage)
    : (colorMode === "blackWhite" ? (settings.pricing?.blackWhitePerPage ?? 15.0) : (settings.pricing?.colorPerPage ?? 30.0));

  const copies = job.printPreferences?.copies || 1;
  const totalPages = actualPages * copies;
  const totalPrice = pricePerPage * totalPages;

  return {
    pricePerPage,
    totalPages,
    totalPrice,
    currency: "DZD",
  };
};

export const countPdfPages = async (file) => {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const arrayBuffer = e.target?.result;
        const bytes = new Uint8Array(arrayBuffer);

        // Decode using latin1 to keep byte values intact
        const text = new TextDecoder("latin1").decode(bytes);

        // Strategy 1: Find /Count N in the Pages dictionary
        // This is the most reliable – it's the total page count stored in the catalog
        const countMatches = text.match(/\/Count\s+(\d+)/g);
        if (countMatches && countMatches.length > 0) {
          // The last /Count value is usually the root Pages node
          const counts = countMatches.map((m) =>
            parseInt(m.replace(/\/Count\s+/, ""), 10),
          );
          const maxCount = Math.max(...counts);
          if (maxCount > 0) {
            resolve(maxCount);
            return;
          }
        }

        // Strategy 2: Count /Type /Page objects (not /Pages)
        const pageMatches = text.match(/\/Type\s*\/Page(?!s)/g);
        if (pageMatches && pageMatches.length > 0) {
          resolve(pageMatches.length);
          return;
        }

        // Fallback: estimate from file size (~75KB per page for PDFs)
        const estimated = Math.max(1, Math.ceil(file.size / 75000));
        resolve(estimated);
      } catch (error) {
        console.error("Error counting PDF pages:", error);
        resolve(1);
      }
    };
    reader.onerror = () => resolve(1);
    reader.readAsArrayBuffer(file);
  });
};

export const countWordPages = async (file) => {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const arrayBuffer = e.target?.result;
        const bytes = new Uint8Array(arrayBuffer);

        // DOCX files are ZIP archives – try to find the word/document.xml and
        // look for a <w:pages> value stored in the document properties.
        // As a heuristic we decode the binary and search for the pages property.
        const text = new TextDecoder("latin1").decode(bytes);

        // Check for <Pages>N</Pages> in docProps/app.xml (inside the zip)
        const pagesMatch = text.match(/<Pages>(\d+)<\/Pages>/);
        if (pagesMatch) {
          resolve(Math.max(1, parseInt(pagesMatch[1], 10)));
          return;
        }

        // Fallback: estimate based on file size.
        // Average DOCX is ~40KB overhead + ~8KB per page of plain text.
        // This is a rough heuristic; real content varies.
        const estimated = Math.max(1, Math.round((file.size - 40000) / 8000));
        resolve(Math.max(1, estimated));
      } catch (error) {
        console.error("Error counting Word pages:", error);
        resolve(1);
      }
    };
    reader.onerror = () => resolve(1);
    reader.readAsArrayBuffer(file);
  });
};

export const getActualPageCount = async (file) => {
  const fileType = file.type.toLowerCase();

  if (fileType.includes("pdf")) {
    return await countPdfPages(file);
  } else if (fileType.includes("word") || fileType.includes("document")) {
    return await countWordPages(file);
  } else if (fileType.includes("image")) {
    return 1;
  } else {
    // Fallback estimation for other file types
    return Math.max(1, Math.ceil(file.size / 75000));
  }
};

export const formatPrice = (price, currency = "DZD") => {
  return `${price.toFixed(2)} ${currency}`;
};

export const calculateCustomerTotal = (jobs, settings, pageCounts) => {
  return jobs.reduce((total, job) => {
    const actualPages = pageCounts[job.id] || 1;
    const price = calculatePrintPrice(job, settings, actualPages);
    return total + price.totalPrice;
  }, 0);
};

/**
 * Typed 4-arg wrapper around the shared discount core. The `job` argument is
 * unused today but kept in the signature so future rules can gate on job
 * attributes without churning every call site.
 */
export const calculateJobDiscount = (_job, originalPrice, pageCount, rules) =>
  calculateJobDiscountCore(originalPrice, pageCount, rules);

/**
 * Calculate total with discounts for multiple jobs. The "≥ N pages" rules are
 * evaluated against totalPages (pages × copies) so they reflect the actual sheet
 * count the customer prints, matching UploadView.
 */
export const calculateCustomerTotalWithDiscounts = (jobs, settings, pageCounts, rules) => {
  const jobBreakdown = jobs.map((job) => {
    const actualPages = pageCounts[job.id] || 1;
    const priceCalc = calculatePrintPrice(job, settings, actualPages);
    const discountResult = calculateJobDiscount(job, priceCalc.totalPrice, priceCalc.totalPages, rules);

    return {
      job,
      original: discountResult.originalAmount,
      discount: discountResult.discountAmount,
      final: discountResult.finalAmount,
      rule: discountResult.rule,
    };
  });

  const originalTotal = jobBreakdown.reduce((sum, item) => sum + item.original, 0);
  const totalDiscount = jobBreakdown.reduce((sum, item) => sum + item.discount, 0);
  const finalTotal = jobBreakdown.reduce((sum, item) => sum + item.final, 0);

  return {
    originalTotal,
    totalDiscount,
    finalTotal,
    jobBreakdown,
  };
};
