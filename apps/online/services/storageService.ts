import { PrintJob, ShopSettings, DiscountRule, AccountProfile, AccountOrder } from "../types";
import { readPref, writePref } from "@atba3li/shared/lib/prefs";
import { normalizeLocation } from "@atba3li/shared/geo";
import { normalizeSocialLinks } from "@atba3li/shared/social";

/** One entry in the public shop directory (`GET /api/shops`). */
export interface PublicShop {
  slug: string;
  name: string;
  logoUrl?: string | null;
  phoneNumbers?: string[];
  email?: string | null;
  address?: string | null;
  workingHours?: string | null;
  location?: import("@atba3li/shared/geo").ShopLocation | null;
  description?: string | null;
  socialLinks?: import("@atba3li/shared/social").SocialLinks | null;
}

class StorageService {
  private async safeFetch(url: string, options?: RequestInit) {
    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
      };
      const response = await fetch(url, {
        ...options,
        headers: {
          ...headers,
          ...(options?.headers as Record<string, string> || {}),
        },
      });

      const text = await response.text();

      if (!response.ok) {
        let msg = `Server error: ${response.status}`;
        try { const errBody = JSON.parse(text); if (errBody.error) msg = errBody.error; } catch { /* ignored */ }
        const err = new Error(msg) as Error & { status?: number };
        err.status = response.status;
        throw err;
      }

      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        console.error("Failed to parse JSON response:", text);
        throw new Error("Malformed JSON response from server");
      }
    } catch (err) {
      console.error(`Fetch failed for ${url}:`, err);
      throw err;
    }
  }

  /**
   * A stable per-browser id, sent with every upload as `X-Device-Id` and
   * stored server-side only as a hash. It lets a shop block one abusive device
   * without blocking a shared/NAT IP. Clearing site data resets it — this is an
   * abuse speed bump, not an identity guarantee.
   */
  private deviceId(): string {
    try {
      let id = readPref("deviceId");
      if (!id) {
        id = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
        writePref("deviceId", id);
      }
      return id;
    } catch {
      // Private mode / storage disabled: no stable id, so the server just
      // falls back to the other identifiers.
      return "";
    }
  }

  private myJobIdsKey(shopSlug: string): string {
    return `my_upload_ids_${shopSlug}`;
  }

  private deleteTokensKey(shopSlug: string): string {
    return `my_upload_tokens_${shopSlug}`;
  }

  private getMyDeleteTokens(shopSlug: string): Record<string, string> {
    try {
      return JSON.parse(localStorage.getItem(this.deleteTokensKey(shopSlug)) || "{}");
    } catch {
      return {};
    }
  }

  private setMyDeleteToken(shopSlug: string, id: string, token: string) {
    const map = this.getMyDeleteTokens(shopSlug);
    map[id] = token;
    localStorage.setItem(this.deleteTokensKey(shopSlug), JSON.stringify(map));
  }

  /**
   * Upload one file. A 429 is retried once after the server's Retry-After
   * delay: a multi-file order sends one request per file, so a burst can
   * legitimately brush the limit and a hard failure would lose that file.
   */
  async saveJob(
    shopSlug: string,
    job: PrintJob,
    file: File,
    onProgress?: (p: number) => void,
    accessToken?: string | null,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.postJob(shopSlug, job, file, onProgress, accessToken, signal);
    } catch (err) {
      // The server asks for a wait via a typed field on the thrown error.
      const retryAfter = (err as { retryAfterSeconds?: number } | null)?.retryAfterSeconds;
      if (!retryAfter || signal?.aborted) throw err;
      await new Promise((r) => setTimeout(r, Math.min(retryAfter, 60) * 1000));
      await this.postJob(shopSlug, job, file, onProgress, accessToken, signal);
    }
  }

  private postJob(
    shopSlug: string,
    job: PrintJob,
    file: File,
    onProgress?: (p: number) => void,
    accessToken?: string | null,
    signal?: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("metadata", JSON.stringify(job));

      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/s/${shopSlug}/upload`, true);
      xhr.setRequestHeader("Accept", "application/json");
      const deviceId = this.deviceId();
      if (deviceId) xhr.setRequestHeader("X-Device-Id", deviceId);
      if (accessToken) {
        xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);
      }

      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const percent = Math.round((e.loaded / e.total) * 100);
            onProgress(percent);
          }
        };
      }

      if (signal) {
        if (signal.aborted) {
          xhr.abort();
          reject(new DOMException("Upload cancelled", "AbortError"));
          return;
        }
        signal.addEventListener("abort", () => xhr.abort());
      }

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const response = JSON.parse(xhr.responseText);
            const myJobs = this.getMyJobIds(shopSlug);
            myJobs.push(response.job.id);
            localStorage.setItem(this.myJobIdsKey(shopSlug), JSON.stringify(myJobs));
            if (response.deleteToken) {
              this.setMyDeleteToken(shopSlug, response.job.id, response.deleteToken);
            }
            resolve();
          } catch {
            reject(new Error("Malformed response from server"));
          }
        } else {
          // Surface the server's own reason instead of a bare status code —
          // the body carries { error, detail } for exactly this.
          let reason = "";
          let retryAfterSeconds = 0;
          try {
            const body = JSON.parse(xhr.responseText);
            reason = [body.error, body.detail].filter(Boolean).join(" — ");
            if (xhr.status === 429) {
              const header = parseInt(xhr.getResponseHeader("Retry-After") || "", 10);
              retryAfterSeconds = Number(body.retryAfter) || header || 5;
            }
          } catch {
            /* non-JSON body: fall back to the status code alone */
            if (xhr.status === 429) retryAfterSeconds = 5;
          }
          const error: Error & { retryAfterSeconds?: number } = new Error(
            reason || `Upload failed with status ${xhr.status}`,
          );
          if (retryAfterSeconds) error.retryAfterSeconds = retryAfterSeconds;
          reject(error);
        }
      };

      xhr.onerror = () => reject(new Error("Network error during upload"));
      xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
      xhr.send(formData);
    });
  }

  getMyJobIds(shopSlug: string): string[] {
    try {
      const data = localStorage.getItem(this.myJobIdsKey(shopSlug));
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  }

  async getMyRecentJobs(shopSlug: string): Promise<Partial<PrintJob>[]> {
    try {
      const myIds = this.getMyJobIds(shopSlug);
      if (myIds.length === 0) return [];
      const data = await this.safeFetch(`/api/s/${shopSlug}/orders/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: myIds }),
      });
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  async getFileUrl(shopSlug: string, id: string): Promise<string | null> {
    return `/api/s/${shopSlug}/files/public/${id}`;
  }

  async deleteJob(shopSlug: string, id: string): Promise<void> {
    const deleteToken = this.getMyDeleteTokens(shopSlug)[id];
    await this.safeFetch(`/api/s/${shopSlug}/orders/${id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deleteToken }),
    });
    const myJobs = this.getMyJobIds(shopSlug).filter((mid) => mid !== id);
    localStorage.setItem(this.myJobIdsKey(shopSlug), JSON.stringify(myJobs));
    const tokens = this.getMyDeleteTokens(shopSlug);
    delete tokens[id];
    localStorage.setItem(this.deleteTokensKey(shopSlug), JSON.stringify(tokens));
  }

  /** Public directory of active shops — used by the platform root page. */
  async listShops(): Promise<PublicShop[]> {
    const shops = await this.safeFetch(`/api/shops`);
    return Array.isArray(shops) ? shops : [];
  }

  async getSettings(shopSlug: string): Promise<ShopSettings> {
    try {
      const settings = await this.safeFetch(`/api/s/${shopSlug}/settings`);
      const pricing = settings?.pricing
        ? {
            colorPerPage: Number(settings.pricing.colorPerPage) || 30.0,
            blackWhitePerPage: Number(settings.pricing.blackWhitePerPage) || 15.0,
            glossyPerPage: Number(settings.pricing.glossyPerPage) || 50.0,
            cardboardPerPage: Number(settings.pricing.cardboardPerPage) || 40.0,
          }
        : undefined;

      const defaultPaperTypes = [
        { id: "normal", name: "Normal", nameAr: "عادي", colorPerPage: pricing?.colorPerPage ?? 30.0, blackWhitePerPage: pricing?.blackWhitePerPage ?? 15.0 },
        { id: "glossy", name: "Glossy", nameAr: "لامع", colorPerPage: pricing?.glossyPerPage ?? 50.0, blackWhitePerPage: pricing?.glossyPerPage ?? 50.0 },
        { id: "cardboard", name: "Cardboard", nameAr: "ورق مقوى", colorPerPage: pricing?.cardboardPerPage ?? 40.0, blackWhitePerPage: pricing?.cardboardPerPage ?? 40.0 },
      ];

      return {
        shopName: settings?.shopName || "Atba3li",
        logoUrl: settings?.logoUrl || null,
        pricing,
        paperTypes: Array.isArray(settings?.paperTypes) && settings.paperTypes.length > 0
          ? settings.paperTypes
          : defaultPaperTypes,
        phoneNumbers: Array.isArray(settings?.phoneNumbers) ? settings.phoneNumbers : undefined,
        email: settings?.email || undefined,
        address: settings?.address || undefined,
        workingHours: settings?.workingHours || undefined,
        location: normalizeLocation(settings?.location),
        returnPolicy: settings?.returnPolicy || undefined,
        description: settings?.description || undefined,
        socialLinks: normalizeSocialLinks(settings?.socialLinks),
      };
    } catch (err) {
      // A missing shop must surface as "not found", not a fake generic
      // storefront the customer can upload into but never actually reaches.
      if ((err as Error & { status?: number }).status === 404) throw err;
      return { shopName: "Atba3li", logoUrl: null, phoneNumbers: [], email: "", address: "", workingHours: "", returnPolicy: "" };
    }
  }

  async getPaperTypes(shopSlug: string): Promise<import("../types").PaperType[]> {
    return this.safeFetch(`/api/s/${shopSlug}/paper-types`);
  }

  async getActiveDiscountRules(shopSlug: string): Promise<DiscountRule[]> {
    return this.safeFetch(`/api/s/${shopSlug}/discount-rules/active`);
  }

  // ── Customer account (optional — requires a Supabase access token) ──

  async getAccountProfile(accessToken: string): Promise<AccountProfile> {
    return this.safeFetch("/api/account/profile", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }

  async updateAccountProfile(accessToken: string, fields: Partial<AccountProfile>): Promise<AccountProfile> {
    return this.safeFetch("/api/account/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(fields),
    });
  }

  async getAccountOrders(accessToken: string): Promise<AccountOrder[]> {
    const data = await this.safeFetch("/api/account/orders", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return Array.isArray(data) ? data : [];
  }
}

export const storageService = new StorageService();
