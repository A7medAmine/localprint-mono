// The pricing and page-counting logic behind the customer upload form.
//
// Both apps ran a byte-identical copy of this; the only real difference was how
// a stored file's URL is fetched (the online portal scopes it by shop slug), so
// that one call arrives as an adapter.
import { useEffect, useState } from "react";
import type { PrintJob, ShopSettings, DiscountRule } from "../types";
import { calculateJobDiscount, getActualPageCount } from "../pricing";
import type { FilePriceInfo, FileStatus, UploadPrintPreferences } from "../components/upload/UploadForm";

export const isOfficeType = (mimeType: string) =>
  mimeType.includes("word") ||
  mimeType.includes("document") ||
  mimeType.includes("excel") ||
  mimeType.includes("spreadsheet") ||
  mimeType.includes("presentation") ||
  mimeType.includes("powerpoint");

export const isImageType = (mimeType: string) => mimeType.includes("image");

export const isOfficeFile = (file: File) => isOfficeType(file.type);

/** Fetch the URL a stored job's file can be downloaded from, or null. */
export type GetJobFileUrl = (jobId: string) => Promise<string | null>;

/**
 * Page counts for the customer's recent jobs and for the files they have picked
 * but not yet sent.
 *
 * Known counts (a PDF the server already counted, an image) resolve
 * synchronously; anything else is downloaded once and counted in the browser,
 * with an 8s cap so a slow file cannot hang the page. Office documents are
 * skipped — the page count is not derivable client-side.
 */
export function usePageCounts(
  recentJobs: PrintJob[],
  selectedFiles: FileStatus[],
  getJobFileUrl: GetJobFileUrl,
) {
  const [jobPageCounts, setJobPageCounts] = useState<Record<string, number>>({});
  const [filePageCounts, setFilePageCounts] = useState<Record<string, number>>({});

  const jobIds = recentJobs.map((job) => job.id).join(",");

  useEffect(() => {
    if (recentJobs.length === 0) {
      setJobPageCounts({});
      return;
    }
    const counts: Record<string, number> = {};
    for (const job of recentJobs) {
      if (job.pageCount && job.pageCount > 0) counts[job.id] = job.pageCount;
      else if (isImageType(job.fileType)) counts[job.id] = 1;
    }
    setJobPageCounts(counts);

    let cancelled = false;
    (async () => {
      for (const job of recentJobs) {
        if (counts[job.id] !== undefined) continue;
        if (isOfficeType(job.fileType)) continue;
        try {
          const url = await getJobFileUrl(job.id);
          if (!url) {
            counts[job.id] = 1;
            continue;
          }
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8000);
          const response = await fetch(url, { signal: controller.signal });
          clearTimeout(timer);
          const blob = await response.blob();
          const file = new File([blob], job.fileName, { type: job.fileType });
          counts[job.id] = await getActualPageCount(file);
        } catch {
          counts[job.id] = 1;
        }
      }
      if (!cancelled) setJobPageCounts({ ...counts });
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobIds]);

  useEffect(() => {
    if (selectedFiles.length === 0) {
      setFilePageCounts({});
      return;
    }
    let cancelled = false;
    (async () => {
      const counts: Record<string, number> = {};
      for (const fs of selectedFiles) {
        try {
          counts[fs.id] = await getActualPageCount(fs.file);
        } catch {
          counts[fs.id] = 1;
        }
      }
      if (!cancelled) setFilePageCounts(counts);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedFiles]);

  return { jobPageCounts, filePageCounts };
}

/** The paper types to price against: the shop's own list, or the built-in
 *  defaults derived from its flat pricing. */
function paperTypesFor(shopSettings: ShopSettings) {
  if (shopSettings.paperTypes && shopSettings.paperTypes.length > 0) return shopSettings.paperTypes;
  return [
    {
      id: "normal",
      name: "Normal",
      nameAr: "عادي",
      colorPerPage: shopSettings.pricing?.colorPerPage ?? 30.0,
      blackWhitePerPage: shopSettings.pricing?.blackWhitePerPage ?? 15.0,
    },
    {
      id: "glossy",
      name: "Glossy",
      nameAr: "لامع",
      colorPerPage: shopSettings.pricing?.glossyPerPage ?? 50.0,
      blackWhitePerPage: shopSettings.pricing?.glossyPerPage ?? 50.0,
    },
    {
      id: "cardboard",
      name: "Cardboard",
      nameAr: "ورق مقوى",
      colorPerPage: shopSettings.pricing?.cardboardPerPage ?? 40.0,
      blackWhitePerPage: shopSettings.pricing?.cardboardPerPage ?? 40.0,
    },
  ];
}

/**
 * Price one picked file at the chosen paper type, colour mode and copy count,
 * with any discount rule applied.
 *
 * Returns null when there is nothing to quote: no settings yet, or an Office
 * document whose page count the browser cannot determine.
 */
export function makeFilePriceCalculator(
  shopSettings: ShopSettings | null,
  getPreferences: (fileId?: string) => UploadPrintPreferences,
  discountRules: DiscountRule[],
  filePageCounts: Record<string, number>,
) {
  return (file: File, fileId?: string): FilePriceInfo | null => {
    if (!shopSettings) return null;
    if (isOfficeFile(file)) return null;

    const printPreferences = getPreferences(fileId);

    const paperType = paperTypesFor(shopSettings).find(
      (pt) => pt.id === (printPreferences.paperType || "normal"),
    );
    const blackWhite = printPreferences.colorMode === "blackWhite";
    const pricePerPage = paperType
      ? blackWhite
        ? paperType.blackWhitePerPage
        : paperType.colorPerPage
      : blackWhite
        ? (shopSettings.pricing?.blackWhitePerPage ?? 15.0)
        : (shopSettings.pricing?.colorPerPage ?? 30.0);

    // Use the counted pages when we have them, else estimate from the size.
    const estimatedPages =
      fileId && filePageCounts[fileId]
        ? filePageCounts[fileId]
        : file.type.includes("pdf")
          ? Math.max(1, Math.ceil(file.size / 75000))
          : file.type.includes("image")
            ? 1
            : Math.max(1, Math.ceil(file.size / 50000));

    const totalPages = estimatedPages * printPreferences.copies;
    const originalPrice = pricePerPage * totalPages;

    const discountResult = calculateJobDiscount({} as PrintJob, originalPrice, totalPages, discountRules);

    return {
      original: originalPrice,
      discount: discountResult.discountAmount,
      final: discountResult.finalAmount,
      hasDiscount: discountResult.discountAmount > 0,
      ruleName: discountResult.rule?.name,
      pages: totalPages,
    };
  };
}
