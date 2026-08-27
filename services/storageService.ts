import { PrintJob, PrintStatus, ShopSettings, DiscountRule, InventoryItem, InventoryAdjustment } from "../types";

class StorageService {
  private authToken: string | null = null;

  setAuthToken(token: string | null) {
    this.authToken = token;
  }

  getAuthToken(): string | null {
    return this.authToken || localStorage.getItem("ps_admin_token");
  }

  private async safeFetch(url: string, options?: RequestInit) {
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
        window.dispatchEvent(new CustomEvent("session-expired"));
        throw new Error("Session expired");
      }

      if (response.status === 403) {
        try {
          const errBody = JSON.parse(text);
          if (errBody.mustChangePassword) {
            window.dispatchEvent(new CustomEvent("must-change-password"));
          }
        } catch {}
      }

      if (!response.ok) {
        let msg = `Server error: ${response.status}`;
        try { const errBody = JSON.parse(text); if (errBody.error) msg = errBody.error; } catch {}
        throw new Error(msg);
      }

      if (!text) return {};

      try {
        return JSON.parse(text);
      } catch (parseError) {
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
    onProgress?: (p: number) => void
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
          } catch (e) {
            reject(new Error("Malformed response from server"));
          }
        } else {
          reject(new Error(`Upload failed with status ${xhr.status}`));
        }
      };

      xhr.onerror = () => reject(new Error("Network error during upload"));
      xhr.send(formData);
    });
  }

  // New method to replace a file for an existing job
  async updateJobFile(jobId: string, file: File): Promise<void> {
    const formData = new FormData();
    formData.append("file", file);

    await this.safeFetch(`/api/jobs/${jobId}/file`, {
      method: "POST",
      body: formData,
    });
  }

  async getMetadata(): Promise<PrintJob[]> {
    const data = await this.safeFetch("/api/jobs");
    return Array.isArray(data) ? data : [];
  }

  getMyJobIds(): string[] {
    try {
      const data = localStorage.getItem("my_upload_ids");
      return data ? JSON.parse(data) : [];
    } catch (e) {
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
    } catch (e) {
      return [];
    }
  }

  async getFileUrl(id: string): Promise<string | null> {
    return `/api/files/public/${id}`;
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
    cloudSyncUrl?: string;
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

  async deleteJob(id: string): Promise<void> {
    const deleteToken = this.getMyDeleteTokens()[id];
    await this.safeFetch(`/api/jobs/${id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deleteToken }),
    });
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
      let settings: any;
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
        shopName: settings?.shopName || "PrintShop Hub",
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
        cloudSyncUrl: settings?.cloudSyncUrl || undefined,
        shopApiToken: settings?.shopApiToken || undefined,
        cloudSyncPollInterval: settings?.cloudSyncPollInterval || undefined,
        autoAcceptCloudJobs: settings?.autoAcceptCloudJobs !== false,
        autoDeductStock: settings?.autoDeductStock === true,
        defaultPrinterName: settings?.defaultPrinterName || "",
        printerDefaults: settings?.printerDefaults && typeof settings.printerDefaults === "object"
          ? settings.printerDefaults
          : {},
      };
    } catch (e) {
      return { shopName: "PrintShop Hub", logoUrl: null, phoneNumbers: [], email: "", address: "", workingHours: "", returnPolicy: "" };
    }
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

  async triggerGmailPoll(): Promise<any> {
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

  async getGmailPending(): Promise<any[]> {
    return this.safeFetch("/api/gmail/pending");
  }

  async importGmailEmails(ids: number[], overrides?: Record<string, { copies: number; colorMode: string; paperType: string }>): Promise<any> {
    return this.safeFetch("/api/gmail/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, overrides }),
    });
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

  async bulkDeleteJobs(ids: string[]): Promise<any> {
    return this.safeFetch("/api/jobs/bulk/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
  }

  async bulkUpdateStatus(ids: string[], status: PrintStatus): Promise<any> {
    return this.safeFetch("/api/jobs/bulk/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, status }),
    });
  }

  // ── Payment ───────────────────────────────────────────────

  async updatePaymentStatus(id: string, paymentStatus: string, paymentAmount?: number): Promise<any> {
    return this.safeFetch(`/api/jobs/${id}/payment`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentStatus, paymentAmount }),
    });
  }

  async bulkUpdatePayment(ids: string[], paymentStatus: string): Promise<any> {
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
    a.download = `printshop-backup-${new Date().toISOString().slice(0, 10)}.sqlite`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async restoreBackup(file: File): Promise<any> {
    const formData = new FormData();
    formData.append("file", file);
    return this.safeFetch("/api/backup/restore", {
      method: "POST",
      body: formData,
    });
  }
}

export const storageService = new StorageService();
