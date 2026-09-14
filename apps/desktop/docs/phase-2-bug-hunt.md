# Phase 2 — Bug-hunt report

Structured review of both servers, the sync layer, Electron main, and Gmail
polling. Severity: **critical** (data loss / auth bypass), **high** (wrong data
or money, hard to notice), **medium** (recoverable / narrow trigger), **low**
(cosmetic / defensive).

Items marked **[fixed]** were addressed in the Phase 2 commits. Items marked
**[deferred]** are noted for Phase 3/4.

---

## 2.1 – 2.6 Confirmed bugs

| # | Item | State |
|---|------|-------|
| 2.1 | CardIDTool "Add to Jobs" ghost job | **[fixed]** server already owns the id + defaults (`Phase 1.3`); NULL-id cleanup migration already in `db.js`. Remaining client-side shape bug fixed in `CardIDTool.submitJob` (sends `customerName`/`phoneNumber`/`fileName`/`status`/`printPreferences`, real `colorMode`, `paperType: "cardboard"`). |
| 2.2 | CardIDTool PDF source images don't render | **[fixed]** `<img src=blob(pdf)>` never rasterises. New shared path `lib/pdfRender.ts` (`getPdfjs` + `renderPdfFirstPageToDataUrl`); `CardIDTool`, `PdfRenderer`, `PDFJobManager` all use it now — one pdf.js path, not three. |
| 2.3 | Stale `lastPdfBlob` | **[fixed]** `handleAddToJobs` already gated on a fresh blob; `submitJob` now regenerates from current state instead of trusting `lastPdfBlob`. |
| 2.4 | Auth rate limiter self-lockout | **[fixed]** already superseded by `Phase 1.2` (`loginGuard` counts **failed** `/api/auth/verify` only, success clears). Removed the now-dead `rateLimit()` + its cleanup interval. |
| 2.5 | `reopenDb()` drops committed data | **[fixed]** `db.js` now `wal_checkpoint(TRUNCATE)` before `close()` and no longer deletes `-wal`/`-shm` on the normal path (`checkpointAndClose` helper). Restore flow rewritten — see 2.7. |
| 2.6 | Startup crash on missing env | **[fixed]** `checkEnv.js` in both repos: collects every missing/invalid var, prints a numbered fix list, exits 1. Called from `db.js` (earliest reliable point under ESM) and, in the desktop app, from `electron/main.js` before the server import → Electron error dialog instead of white screen. |

---

## 2.7 Structured pass — findings

### Desktop `server.js`

| Sev | Location | Finding | State |
|-----|----------|---------|-------|
| **critical** | `/api/backup/restore` | Wrote `req.file.buffer` straight over the live DB with zero validation — a truncated upload or wrong file bricked the install. | **[fixed]** now: write to `*.incoming`, open read-only, `PRAGMA integrity_check` + assert a `jobs` table, only then checkpoint/close/swap/reopen; snapshot to `*.before_restore` and roll back on any error; drop stale `-wal`/`-shm` (they belong to the replaced file). |
| **high** | `applyAutoDeductForJob` | Not idempotent: `PRINTED → PENDING → PRINTED` deducts inventory twice (guard only checks `previousStatus === 'PRINTED'`). | **[fixed]** new `hasAutoDeductForJob(jobId, itemId)` — skips any job/item that already has an `auto_deduct` adjustment row. Note: does **not** re-credit stock when a job leaves PRINTED (deferred — needs a product decision). |
| **medium** | `/api/jobs/bulk` (delete) | `fs.unlinkSync` ran inside the `db.transaction` — FS ops aren't transactional, so a throw mid-loop left files deleted for rows that rolled back. | **[fixed]** file names collected in the txn, unlinked after commit. |
| **low** | `/api/events` (SSE) | No auth on the event bus — any LAN client can subscribe and watch job ids / gmail counts flow by. No server-side heartbeat (dead NAT'd connections linger until TCP timeout; capped at 50). | **[fixed]** the endpoint now requires a valid admin token (header, or `?token=` since EventSource cannot set headers — `utils/adminEvents.ts` builds the URL), sends a `: ping` every 25s, and caps connections at 5 per IP on top of the global 50. |
| **low** | bulk status → cloud sync | `import('./services/cloudSync.js')` per bulk call; fine, but errors are swallowed silently (`.catch(() => {})`) — a shop with a broken cloud token gets no signal. | **[fixed]** `warnCloudSyncFailed()` logs once per minute (not per job) and broadcasts a `cloud-sync-error` SSE event; `useAdminJobs` raises a destructive toast. |

### Online `server.js`

| Sev | Location | Finding | State |
|-----|----------|---------|-------|
| **high** | `/api/shop/settings-sync` | `discount_rules` were `delete().eq(shop_id)` then `insert(...)` with no atomicity — a failed insert left the shop with **zero** discount rules. | **[fixed]** snapshot existing rules first; on insert failure, restore the snapshot before throwing. (True atomicity needs a Postgres RPC — deferred to Phase 4.) |
| **medium** | `backfillPageCounts`, `cleanupOldOrders` | Run on a bare `setInterval`/`setTimeout` with no lock — two instances (or a restart mid-run) double-process. | **[deferred]** fine for a single instance; documented. Needs an advisory lock if the host ever scales past 1. |
| **medium** | `optionalCustomerAuth` 503 path | Covered by `Phase 1.5`; re-confirmed the lenient variant degrades to guest instead of hard-failing uploads. | ok |
| **low** | `statusSubscribers` map | Per-order SSE `res` set; a client that never closes leaks the `res`. No max-age, no per-IP cap. | **[fixed]** 5 concurrent streams per IP (checked before the Supabase round-trip) and a 30-minute hard close; cleanup is idempotent and runs on both `req`/`res` close. |

### Sync layer (`services/cloudSync.js`)

| Sev | Location | Finding | State |
|-----|----------|---------|-------|
| **medium** | column naming | Desktop is `camelCase`, online Postgres is `lowercase`; `/api/shop/pending` must hand back camelCase and every field is hand-mapped. Fragile, silent on drift. | **[deferred → Phase 4]** single translation table + a round-trip test. |
| **low** | `importOrder` partial failure | DB insert failure unlinks the downloaded file (good). Ack failure after a successful import is reconciled on the next poll (dedupe re-acks). `pending_review` orders are intentionally never acked until the shop decides. No infinite-stuck state found. | ok |
| **low** | `acknowledgeOrder` / `rejectCloudOrder` | Return `false` on failure; callers log and move on. Retried next poll via dedupe. Acceptable. | ok |

### Electron `electron/main.js`

| Sev | Location | Finding | State |
|-----|----------|---------|-------|
| **medium** | silent print to a stale printer | `silent: !!printer` — if the saved `defaultPrinterName` no longer exists, `webContents.print` silently no-ops and the job vanishes. | **[fixed]** `assertPrinterExists()` validates `printerName` against `getPrintersAsync()` before `nativePrint` in both `print-data` and `print-file`; throws a clear "pick a printer again in Settings" error. |
| **low** | grayscale = CSS `filter: grayscale()` hack | Documented at length in `nativePrint` (lines ~387-424): Chromium's `color:false` prints solid black on this driver stack, so the code forces `color:true` + a post-composite CSS filter. Works, but is a real mono print (desaturated pixels), not the printer's own mono mode. | **[deferred → Phase 3]** try `webContents.print({ color:false })` first, fall back to the filter only if the driver misbehaves. |
| **low** | hidden print `BrowserWindow` | `nativePrint` uses `show:true` off-screen (needed for compositing) and `win.destroy()` in a `settled`-guarded `finish()` on every path incl. `did-fail-load`. No leak found. | ok |
| **low** | crash handler | `uncaughtException`/`unhandledRejection` → logfile + `dialog.showErrorBox` + `app.quit()`. Does not swallow — it logs and surfaces. | ok |

### Gmail polling (`services/gmailPolling.js`)

| Sev | Location | Finding | State |
|-----|----------|---------|-------|
| **medium** | attachment ingest | `attResponse.data.data` (base64) is loaded fully into memory with **no size cap**, and `att.mimeType` is **not** checked against the upload allowlist or magic bytes — the `/api/upload` protections are bypassed for email-sourced jobs. | **[fixed]** `attachmentService.js` now imports the shared `ALLOWED_MIMES` (it had its own drifting copy) and runs `magicBytesMatch` on the decoded header; `attachmentRejectReason()` rejects on MIME + the 25 MB cap from the message metadata, so `gmailPolling` skips the part **before** downloading its base64 body. Covered by `test/validation.test.ts`. |
| **low** | dedupe | `processed_emails` (UNIQUE `gmail_message_id`) + `gmail_pending` UNIQUE — double-insert is `INSERT OR IGNORE`. Solid. | ok |
| **low** | token refresh | Handled in `gmailService.getGmailClient()`; encrypted at rest via `db.js` `encryptToken`. | ok |

### Frontend (spot checks)

| Sev | Location | Finding | State |
|-----|----------|---------|-------|
| **low** | `CardIDTool` colorMode | Tool state was `"bw"`; server/pricing expect `"blackWhite"`. Card jobs were priced as colour. | **[fixed]** mapped in `submitJob`. |
| **medium** | `UploadView` vs server pricing | Client `utils/pricingUtils.ts` heuristics (docx page estimate) vs server `pdf-lib` count can drift; customer sees one price, shop another. | **[fixed]** the online `/upload` handler recomputes the price with the shared calculator against the shop's real settings and persists **that**; `metadata.quotedPrice` is advisory and a mismatch is logged. The client already labels its number an estimate and shows none for Office files. |
| **low** | pre-existing `tsc` errors | 3 unrelated type errors exist on `main` (`AdminView.tsx:483`, `PDFJobManager.tsx:348`, `UploadView.tsx:121`). Not introduced by Phase 2; flagged for Phase 4 typecheck gate. | **[fixed]** both apps' tsconfigs now carry an `exclude` list (stale `dist`/`release` bundles were what `tsc` choked on) and a dead `@ts-expect-error` was removed. `npm run typecheck` is clean in both workspaces, so the CI gate passes. |

---

## Not reproduced / no action

- SSE handler registration (`broadcastEvent`) — `/api/events` **is** registered
  (server.js ~1860) and cleans up on `req.on('close')`.
- `reopenDb` double-open — callers (`/api/backup/restore`) close before calling;
  `will-quit` now uses `checkpointAndClose` instead of a raw `db.close()`.
