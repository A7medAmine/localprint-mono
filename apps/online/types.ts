// Shared types live in @localprint/shared/types. Only online-specific types
// (customer accounts — the desktop app has no logged-in end users) are here.
export * from "@localprint/shared/types";

export interface AccountProfile {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  defaultPaperTypeId: string | null;
  defaultCopies: number | null;
}

export interface AccountOrder {
  id: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  uploadDate: string;
  status: string;
  pageCount?: number;
  colorMode: string;
  copies: number;
  paperType: string;
  totalPrice: number | null;
  shopName: string | null;
  shopSlug: string | null;
}
