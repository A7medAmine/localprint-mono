import { PrintJob, PrintStatus, ShopSettings, DiscountRule, InventoryItem, InventoryAdjustment, Credential, CredentialSettings, CvProfile, CvDocument } from "../types";
import { emitAppEvent } from "@atba3li/shared/lib/appEvents";
import { normalizeLocation } from "@atba3li/shared/geo";
import { normalizeSocialLinks } from "@atba3li/shared/social";

/** What the write endpoints answer with: success, plus how many rows moved. */
export interface MutationResult {
  success: boolean;
  deleted?: number;
  updated?: number;
  error?: string;
}

/** One attachment on a pending email, as gmail_pending stores it. */
export interface GmailAttachmentMeta {
  filename: string;
  mimeType: string;
  size: number;
}

/** A fetched-but-not-yet-imported email awaiting the operator's review. */
export interface GmailPendingEmail {
  id: number;
  email_from: string;
  email_address: string;
  subject: string;
  body_preview?: string;
  attachment_meta: GmailAttachmentMeta[];
  fetched_at?: string;
  received_at?: string;
}

/** One row of the Gmail import result: an imported job, or why it failed. */
export interface GmailImportRow {
  id: number;
  subject?: string;
  error?: string;
}

export interface GmailImportResult {
  imported?: GmailImportRow[];
  error?: string;
}

class StorageService {
  private authToken: string | null = null;

  setAuthToken(token: string | null) {
    this.authToken = token;
  }

  getAuthToken(): string | null {
    return this.authToken || localStorage.getItem("ps_admin_token");
  }

  private async safeFetch(url: string, options?: RequestInit) {
    return (await this.safeFetchWithHeaders(url, options)).data;
  }

  // The single JSON boundary of the client. Callers state the shape they
  // expect; parsed JSON genuinely is `any` until one of them does.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed JSON is untyped until a caller names its shape
  private async safeFetchWithHeaders<T = any>(
    url: string,
    options?: RequestInit,
  ): Promise<{ data: T; headers: Headers }> {
    try {
      const token = this.authToken || localStorage.getItem("ps_admin_token");
      if (token && !this.authToken) this.authToken = token;

      const headers: Record<string, string> = {
        Accept: "application/json",
      };
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
      const response = await fetch(url, {
        ...options,
        headers: {
          ...headers,
          ...(options?.headers as Record<string, string> || {}),
        },
      });

      const text = await response.text();

      if (response.status === 401) {
        localStorage.removeItem("ps_admin_token");
        this.authToken = null;
        emitAppEvent("session-expired");
        throw new Error("Session expired");
      }

      if (response.status === 403) {
        try {
          const errBody = JSON.parse(text);
          if (errBody.mustChangePassword) {
            emitAppEvent("must-change-password");
          }
        } catch { /* ignored */ }
      }

      if (!response.ok) {
        let msg = `Server error: ${response.status}`;
        try { const errBody = JSON.parse(text); if (errBody.error) msg = errBody.error; } catch { /* ignored */ }
        throw new Error(msg);
      }

      if (!text) return { data: {} as T, headers: response.headers };

      try {
        return { data: JSON.parse(text), headers: response.headers };
      } catch {
        console.error("Failed to parse JSON response:", text);
        throw new Error("Malformed JSON response from server");
      }
    } catch (err) {
      console.error(`Fetch failed for ${url}:`, err);
      throw err;
    }
  }

  async saveJob(
    job: PrintJob,
    file: File,
    onProgress?: (p: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("metadata", JSON.stringify(job));

      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/upload", true);
      xhr.setRequestHeader("Accept", "application/json");
      if (this.authToken) {
        xhr.setRequestHeader("Authorization", `Bearer ${this.authToken}`);
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
            const myJobs = this.getMyJobIds();
            myJobs.push(response.job.id);
            localStorage.setItem("my_upload_ids", JSON.stringify(myJobs));
            if (response.deleteToken) {
              this.setMyDeleteToken(response.job.id, response.deleteToken);
            }
            resolve();
          } catch {
            reject(new Error("Malformed response from server"));
          }
        } else {
          // Surface the server's own reason instead of a bare status code —
          // the body carries { error, detail } for exactly this.
          let reason = "";
          try {
            const body = JSON.parse(xhr.responseText);
            reason = [body.error, body.detail].filter(Boolean).join(" — ");
          } catch {
            /* non-JSON body: fall back to the status code alone */
          }
          reject(new Error(reason || `Upload failed with status ${xhr.status}`));
        }
      };

      xhr.onerror = () => reject(new Error("Network error during upload"));
      xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
      xhr.send(formData);
    });
  }

  // New method to replace a file for an existing job
  async updateJobFile(jobId: string, file: File, fileName?: string): Promise<PrintJob | null> {
    const formData = new FormData();
    formData.append("file", file);
    // Replacing an image job with a processed PDF changes the display name too
    // — without this the job keeps showing the old "photo.jpg".
    if (fileName) formData.append("fileName", fileName);

    const res = await this.safeFetch(`/api/jobs/${jobId}/file`, {
      method: "POST",
      body: formData,
    });
    return res?.job ?? null;
  }

  async getMetadata(): Promise<PrintJob[]> {
    return (await this.getJobsPage()).jobs;
  }

  /**
   * Newest-first page of jobs plus the server's total row count, so the
   * dashboard can show "newest N of M" and fetch the rest on demand instead of
   * pulling the whole table on every refresh.
   */
  async getJobsPage(opts?: { limit?: number }): Promise<{ jobs: PrintJob[]; total: number }> {
    const query = opts?.limit ? `?limit=${opts.limit}` : "";
    const { data, headers } = await this.safeFetchWithHeaders(`/api/jobs${query}`);
    const jobs = Array.isArray(data) ? data : [];
    const headerTotal = parseInt(headers.get("X-Total-Count") || "", 10);
    return { jobs, total: Number.isFinite(headerTotal) ? headerTotal : jobs.length };
  }

  getMyJobIds(): string[] {
    try {
      const data = localStorage.getItem("my_upload_ids");
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  }

  private getMyDeleteTokens(): Record<string, string> {
    try {
      return JSON.parse(localStorage.getItem("my_upload_tokens") || "{}");
    } catch {
      return {};
    }
  }

  private setMyDeleteToken(id: string, token: string) {
    const map = this.getMyDeleteTokens();
    map[id] = token;
    localStorage.setItem("my_upload_tokens", JSON.stringify(map));
  }

  async getMyRecentJobs(): Promise<Partial<PrintJob>[]> {
    try {
      const myIds = this.getMyJobIds();
      if (myIds.length === 0) return [];
      const data = await this.safeFetch("/api/jobs/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: myIds }),
      });
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  async getFileUrl(id: string): Promise<string | null> {
    return `/api/files/public/${id}`;
  }

  // Admin-side file URL. Goes through the token-protected review endpoint so
  // jobs still awaiting review (cloud orders with auto-accept off) can be
  // opened; the public endpoint hides those on purpose. Returns an object URL
  // — the caller must revoke it when done.
  async getAdminFileUrl(id: string): Promise<string | null> {
    try {
      const token = this.getAuthToken();
      const response = await fetch(`/api/files/review/${id}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (response.status === 401) {
        localStorage.removeItem("ps_admin_token");
        this.authToken = null;
        emitAppEvent("session-expired");
        return null;
      }
      if (!response.ok) return null;
      return URL.createObjectURL(await response.blob());
    } catch {
      return null;
    }
  }

  // Absolute path on the machine running the server — used by native
  // printing in the Electron desktop app. Admin-only server-side.
  async getFileLocalPath(id: string): Promise<string | null> {
    try {
      const data = await this.safeFetch(`/api/files/localpath/${id}`);
      return typeof data?.path === "string" ? data.path : null;
    } catch {
      return null;
    }
  }

  async updateStatus(id: string, status: PrintStatus): Promise<void> {
    await this.safeFetch(`/api/jobs/${id}/status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
  }

  async updateJobPreferences(
    id: string,
    preferences: { colorMode: "color" | "blackWhite"; copies: number; paperType?: string },
  ): Promise<void> {
    await this.safeFetch(`/api/jobs/${id}/preferences`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(preferences),
    });
  }

  async saveSettings(settings: {
    shopName?: string;
    paperTypes?: import("../types").PaperType[];
    pricing?: { colorPerPage: number; blackWhitePerPage: number; glossyPerPage?: number; cardboardPerPage?: number };
    phoneNumbers?: string[];
    email?: string;
    address?: string;
    workingHours?: string;
    returnPolicy?: string;
    description?: string;
    socialLinks?: import("@atba3li/shared/social").SocialLinks;
    /** null clears the shop's map pin; omitted leaves it untouched. */
    location?: import("@atba3li/shared/geo").ShopLocation | null;
    currency?: string;
    cloudSyncUrl?: string;
    cloudShopSlug?: string;
    shopApiToken?: string;
    cloudSyncPollInterval?: string;
    autoAcceptCloudJobs?: boolean;
    autoDeductStock?: boolean;
    defaultPrinterName?: string;
    printerDefaults?: Record<string, import("../types").PrinterJobDefaults>;
  }): Promise<void> {
    await this.safeFetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
  }

  /** Probe the cloud with draft (unsaved) credentials — see POST /api/cloud/test. */
  async testCloudConnection(payload: {
    cloudSyncUrl?: string;
    shopApiToken?: string;
  }): Promise<{
    ok: boolean;
    stage: string;
    status?: number;
    error?: string;
    message?: string;
    shopSlug?: string;
    shopName?: string;
  }> {
    return this.safeFetch("/api/cloud/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async deleteJob(id: string): Promise<void> {
    const deleteToken = this.getMyDeleteTokens()[id];
    try {
      await this.safeFetch(`/api/jobs/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleteToken }),
      });
    } finally {
      // Drop it from this browser's own tracking either way. A stale/missing
      // deleteToken (e.g. an order whose file already vanished from disk
      // server-side) must not leave a broken entry the customer can never
      // clear from their own list — the server row can outlive it harmlessly.
      this.forgetJob(id);
    }
  }

  /** Stop tracking a job in this browser without touching the server row. */
  forgetJob(id: string): void {
    const myJobs = this.getMyJobIds().filter((mid) => mid !== id);
    localStorage.setItem("my_upload_ids", JSON.stringify(myJobs));
    const tokens = this.getMyDeleteTokens();
    delete tokens[id];
    localStorage.setItem("my_upload_tokens", JSON.stringify(tokens));
  }

  async acceptReviewJob(id: string): Promise<PrintJob> {
    const data = await this.safeFetch(`/api/jobs/${id}/review/accept`, {
      method: "POST",
    });
    return data.job;
  }

  // ── Upload blocklist (proxied to the cloud by the desktop server) ──

  async getBlockedUploaders(): Promise<import("../types").BlockedUploader[]> {
    const data = await this.safeFetch("/api/cloud/blocks");
    return Array.isArray(data) ? data : [];
  }

  async blockUploader(payload: {
    kind: "ip" | "fingerprint" | "phone" | "user";
    value: string;
    reason?: string;
    label?: string;
  }): Promise<import("../types").BlockedUploader> {
    return this.safeFetch("/api/cloud/blocks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async unblockUploader(id: string): Promise<void> {
    await this.safeFetch(`/api/cloud/blocks/${id}`, { method: "DELETE" });
  }

  /**
   * Pull the cloud's pending queue right now instead of waiting for the next
   * poll tick — see POST /api/cloud/poll. Resolves with how many new orders
   * landed locally.
   */
  async pollCloudOrders(): Promise<number> {
    const data = await this.safeFetch("/api/cloud/poll", { method: "POST" });
    return Number(data?.imported) || 0;
  }

  async rejectReviewJob(id: string, reason: string, note?: string): Promise<void> {
    await this.safeFetch(`/api/jobs/${id}/review/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason, note }),
    });
  }

  async getSettings(): Promise<ShopSettings> {
    try {
      // The public endpoint only returns allowlisted keys. When an admin token
      // is present, fetch the full set (cloud config, printer defaults, ...);
      // fall back to the public view if that call fails.
      const hasToken = !!(this.authToken || localStorage.getItem("ps_admin_token"));
      let settings: ShopSettings;
      if (hasToken) {
        try {
          settings = await this.safeFetch("/api/settings/admin");
        } catch {
          settings = await this.safeFetch("/api/settings");
        }
      } else {
        settings = await this.safeFetch("/api/settings");
      }
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
        returnPolicy: settings?.returnPolicy || undefined,
        description: settings?.description || undefined,
        socialLinks: normalizeSocialLinks(settings?.socialLinks),
        location: normalizeLocation(settings?.location),
        currency: settings?.currency || undefined,
        cloudSyncUrl: settings?.cloudSyncUrl || undefined,
        cloudShopSlug: settings?.cloudShopSlug || undefined,
        shopApiToken: settings?.shopApiToken || undefined,
        cloudSyncPollInterval: settings?.cloudSyncPollInterval || undefined,
        autoAcceptCloudJobs: settings?.autoAcceptCloudJobs !== false,
        autoDeductStock: settings?.autoDeductStock === true,
        defaultPrinterName: settings?.defaultPrinterName || "",
        printerDefaults: settings?.printerDefaults && typeof settings.printerDefaults === "object"
          ? settings.printerDefaults
          : {},
      };
    } catch {
      return { shopName: "Atba3li", logoUrl: null, phoneNumbers: [], email: "", address: "", workingHours: "", returnPolicy: "" };
    }
  }

  /**
   * Turn a short map link into coordinates. The server does the redirect
   * follow — the renderer can't, because the map hosts don't send CORS headers
   * for a cross-origin read. Returns null when the link carries no position.
   */
  async resolveMapLink(url: string): Promise<{ lat: number; lng: number } | null> {
    const result = await this.safeFetch("/api/settings/resolve-location-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!result?.success) return null;
    return { lat: result.lat, lng: result.lng };
  }

  async uploadLogo(file: File): Promise<string> {
    const formData = new FormData();
    formData.append("logo", file);

    const response = await this.safeFetch("/api/settings/logo", {
      method: "POST",
      body: formData,
    });
    return response.logoUrl;
  }

  // Paper Types
  async getPaperTypes(): Promise<import("../types").PaperType[]> {
    return this.safeFetch("/api/paper-types");
  }

  async createPaperType(pt: import("../types").PaperType): Promise<import("../types").PaperType> {
    return this.safeFetch("/api/paper-types", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pt),
    });
  }

  async updatePaperType(id: string, updates: Partial<import("../types").PaperType>): Promise<import("../types").PaperType> {
    return this.safeFetch(`/api/paper-types/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
  }

  async deletePaperType(id: string): Promise<void> {
    await this.safeFetch(`/api/paper-types/${id}`, { method: "DELETE" });
  }

  // Inventory
  async getInventory(): Promise<{ items: InventoryItem[]; lowStockCount: number }> {
    const data = await this.safeFetch("/api/inventory");
    return { items: Array.isArray(data?.items) ? data.items : [], lowStockCount: data?.lowStockCount || 0 };
  }

  async getInventoryAdjustments(itemId?: string, limit = 50): Promise<InventoryAdjustment[]> {
    const params = new URLSearchParams();
    if (itemId) params.set("itemId", itemId);
    params.set("limit", String(limit));
    const data = await this.safeFetch(`/api/inventory/adjustments?${params}`);
    return Array.isArray(data) ? data : [];
  }

  async createInventoryItem(item: Partial<InventoryItem>): Promise<InventoryItem> {
    return this.safeFetch("/api/inventory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(item),
    });
  }

  async updateInventoryItem(id: string, updates: Partial<InventoryItem>): Promise<InventoryItem> {
    return this.safeFetch(`/api/inventory/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
  }

  async deleteInventoryItem(id: string): Promise<void> {
    await this.safeFetch(`/api/inventory/${id}`, { method: "DELETE" });
  }

  async adjustInventoryStock(
    id: string,
    amount: number,
    reason: "manual" | "restock",
    note?: string,
  ): Promise<{ item: InventoryItem; adjustment: InventoryAdjustment }> {
    return this.safeFetch(`/api/inventory/${id}/adjust`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount, reason, note }),
    });
  }

  // Credentials
  async getCredentials(): Promise<Credential[]> {
    const data = await this.safeFetch("/api/credentials");
    return Array.isArray(data) ? data : [];
  }

  async getCredential(id: string): Promise<Credential> {
    return this.safeFetch(`/api/credentials/${id}`);
  }

  async createCredential(cred: Partial<Credential>): Promise<Credential> {
    return this.safeFetch("/api/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cred),
    });
  }

  async updateCredential(id: string, updates: Partial<Credential>): Promise<Credential> {
    return this.safeFetch(`/api/credentials/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
  }

  async deleteCredential(id: string): Promise<void> {
    await this.safeFetch(`/api/credentials/${id}`, { method: "DELETE" });
  }

  async getCredentialSettings(): Promise<CredentialSettings> {
    try {
      const data = await this.safeFetch("/api/credentials/settings");
      return {
        services: Array.isArray(data?.services) ? data.services : [],
        defaultNotice: data?.defaultNotice || "",
        fontScale: data?.fontScale === "large" || data?.fontScale === "xlarge" ? data.fontScale : "normal",
      };
    } catch {
      return { services: [], defaultNotice: "", fontScale: "normal" };
    }
  }

  // CVs
  async getCvProfiles(search?: string): Promise<CvProfile[]> {
    const qs = search ? `?search=${encodeURIComponent(search)}` : "";
    const data = await this.safeFetch(`/api/cvs${qs}`);
    return Array.isArray(data) ? data : [];
  }

  async getCvProfile(id: string): Promise<CvProfile> {
    return this.safeFetch(`/api/cvs/${id}`);
  }

  async createCvProfile(profile: { fullName: string; phone?: string; data: CvDocument }): Promise<CvProfile> {
    return this.safeFetch("/api/cvs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profile),
    });
  }

  async updateCvProfile(id: string, updates: { fullName?: string; phone?: string; data?: CvDocument }): Promise<CvProfile> {
    return this.safeFetch(`/api/cvs/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
  }

  async deleteCvProfile(id: string): Promise<void> {
    await this.safeFetch(`/api/cvs/${id}`, { method: "DELETE" });
  }

  async uploadCvPhoto(id: string, file: File): Promise<CvProfile> {
    const formData = new FormData();
    formData.append("photo", file);
    return this.safeFetch(`/api/cvs/${id}/photo`, {
      method: "POST",
      body: formData,
    });
  }

  // The photo route requires admin auth, so a plain <img src> can't load it,
  // and renderHtmlPdf needs a self-contained document anyway (app-relative
  // URLs don't resolve from the tmp file it renders) — fetch it with the
  // bearer token and hand back a data: URL for both the editor preview and
  // the printed document to use directly.
  async fetchCvPhotoDataUrl(id: string): Promise<string | null> {
    const token = this.authToken || localStorage.getItem("ps_admin_token");
    try {
      const res = await fetch(`/api/cvs/${id}/photo`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
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
  }

  async updateCredentialSettings(settings: Partial<CredentialSettings>): Promise<CredentialSettings> {
    return this.safeFetch("/api/credentials/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
  }

  // Discount Rules
  async getDiscountRules(): Promise<DiscountRule[]> {
    return this.safeFetch("/api/discount-rules");
  }

  async getActiveDiscountRules(): Promise<DiscountRule[]> {
    return this.safeFetch("/api/discount-rules/active");
  }

  async createDiscountRule(rule: DiscountRule): Promise<DiscountRule> {
    return this.safeFetch("/api/discount-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rule),
    });
  }

  async updateDiscountRule(id: string, updates: Partial<DiscountRule>): Promise<DiscountRule> {
    return this.safeFetch(`/api/discount-rules/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
  }

  async deleteDiscountRule(id: string): Promise<void> {
    await this.safeFetch(`/api/discount-rules/${id}`, {
      method: "DELETE",
    });
  }

  /** True while the operator has never set an admin password (first run). */
  async isFreshInstall(): Promise<boolean> {
    try {
      const result = await this.safeFetch("/api/auth/status");
      return !!result?.freshInstall;
    } catch {
      return false;
    }
  }

  /** Session token for a fresh install, without asking for a password. */
  async bootstrapSession(): Promise<string | null> {
    try {
      const result = await this.safeFetch("/api/auth/bootstrap", { method: "POST" });
      return result?.success && result.token ? result.token : null;
    } catch {
      return null;
    }
  }

  async verifyPassword(password: string): Promise<{ success: boolean; token?: string; mustChangePassword?: boolean }> {
    try {
      const result = await this.safeFetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      return result;
    } catch {
      return { success: false };
    }
  }

  async logoutOthers(): Promise<void> {
    await this.safeFetch("/api/auth/logout-all", { method: "POST" });
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await this.safeFetch("/api/settings/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  }

  // ── Gmail integration ──────────────────────────────────────

  async getGmailStatus(): Promise<{ connected: boolean; email: string }> {
    return this.safeFetch("/api/gmail/status");
  }

  async getGmailAuthUrl(): Promise<string> {
    const result = await this.safeFetch("/api/gmail/auth");
    return result.url;
  }

  async disconnectGmail(): Promise<void> {
    await this.safeFetch("/api/gmail/disconnect", { method: "POST" });
  }

  async triggerGmailPoll(): Promise<{ success: boolean; imported?: number }> {
    return this.safeFetch("/api/gmail/poll", { method: "POST" });
  }

  async getGmailPollStatus(): Promise<{ lastPolledAt: string | null; isPolling: boolean }> {
    return this.safeFetch("/api/gmail/poll-status");
  }

  async getGmailSettings(): Promise<{
    pollInterval: number;
    replyTemplate: string;
    replyTemplateLang: "en" | "ar";
    readyTemplate: string;
    readyTemplateLang: "en" | "ar";
  }> {
    return this.safeFetch("/api/gmail/settings");
  }

  async getGmailPending(): Promise<GmailPendingEmail[]> {
    return this.safeFetch("/api/gmail/pending");
  }

  async importGmailEmails(ids: number[], overrides?: Record<string, { copies: number; colorMode: string; paperType: string }>): Promise<GmailImportResult> {
    return this.safeFetch("/api/gmail/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, overrides }),
    });
  }

  /**
   * Preview URL for one attachment of a pending (not yet imported) email. The
   * server streams it straight from Gmail, caching the bytes on first hit, so
   * the operator can look at a file before creating a job for it.
   */
  getGmailAttachmentUrl(pendingId: number, attachmentIndex: number): string {
    return `/api/gmail/attachment/${pendingId}/${attachmentIndex}`;
  }

  async discardGmailEmail(id: number): Promise<void> {
    await this.safeFetch(`/api/gmail/pending/${id}`, { method: "DELETE" });
  }

  async restoreGmailEmail(id: number): Promise<void> {
    await this.safeFetch(`/api/gmail/pending/${id}/restore`, { method: "POST" });
  }

  async saveGmailPollInterval(interval: number): Promise<void> {
    await this.safeFetch("/api/gmail/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pollInterval: interval }),
    });
  }

  async saveGmailReplyTemplate(
    template: string,
    lang: "en" | "ar",
  ): Promise<void> {
    await this.safeFetch("/api/gmail/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ replyTemplate: template, replyTemplateLang: lang }),
    });
  }

  async saveGmailReadyTemplate(
    template: string,
    lang: "en" | "ar",
  ): Promise<void> {
    await this.safeFetch("/api/gmail/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ readyTemplate: template, readyTemplateLang: lang }),
    });
  }

  async sendJobReadyNotification(jobId: string): Promise<{ success: boolean; error?: string }> {
    return this.safeFetch(`/api/jobs/${jobId}/notify-ready`, { method: "POST" });
  }

  // ── Bulk Actions ──────────────────────────────────────────

  async bulkDeleteJobs(ids: string[]): Promise<MutationResult> {
    return this.safeFetch("/api/jobs/bulk/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
  }

  async bulkUpdateStatus(ids: string[], status: PrintStatus): Promise<MutationResult> {
    return this.safeFetch("/api/jobs/bulk/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, status }),
    });
  }

  // ── Payment ───────────────────────────────────────────────

  async updatePaymentStatus(id: string, paymentStatus: string, paymentAmount?: number): Promise<MutationResult> {
    return this.safeFetch(`/api/jobs/${id}/payment`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentStatus, paymentAmount }),
    });
  }

  async bulkUpdatePayment(ids: string[], paymentStatus: string): Promise<MutationResult> {
    return this.safeFetch("/api/jobs/bulk/payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, paymentStatus }),
    });
  }

  // ── Backup ────────────────────────────────────────────────

  async downloadBackup(): Promise<void> {
    const token = this.authToken || localStorage.getItem("ps_admin_token");
    const res = await fetch("/api/backup/download", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `atba3li-backup-${new Date().toISOString().slice(0, 10)}.sqlite`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async restoreBackup(file: File): Promise<MutationResult> {
    const formData = new FormData();
    formData.append("file", file);
    return this.safeFetch("/api/backup/restore", {
      method: "POST",
      body: formData,
    });
  }
}

export const storageService = new StorageService();
