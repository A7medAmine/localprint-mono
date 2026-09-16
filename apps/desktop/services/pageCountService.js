import fs from 'fs';
import { countPdfPagesFromBuffer } from '@atba3li/shared/pdf';

async function countPdfPages(fullPath) {
  const bytes = fs.readFileSync(fullPath);
  return countPdfPagesFromBuffer(bytes);
}

function estimateDocxPages(fullPath) {
  const stat = fs.statSync(fullPath);
  // Matches the client-side fallback in utils/pricingUtils.ts (countWordPages).
  return Math.max(1, Math.round((stat.size - 40000) / 8000));
}

export async function countPagesForFile(fullPath, mimeType) {
  const mt = (mimeType || '').toLowerCase();
  try {
    if (mt.includes('pdf')) return await countPdfPages(fullPath);
    if (mt.includes('image')) return 1;
    if (mt.includes('word') || mt.includes('document')) return estimateDocxPages(fullPath);
    const stat = fs.statSync(fullPath);
    return Math.max(1, Math.ceil(stat.size / 75000));
  } catch (err) {
    console.warn(`⚠️  Page count failed for ${fullPath}:`, err.message);
    return 1;
  }
}
