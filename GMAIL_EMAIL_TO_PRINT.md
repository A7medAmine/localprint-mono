# Gmail Email-to-Print — Architecture & Flow

## Overview

The Gmail Email-to-Print feature lets customers send print jobs via email attachments. The app polls a connected Gmail inbox for unread messages, displays new emails with their attachments in an admin review panel, and allows the admin to selectively import attachments as print jobs. An optional auto-reply can be sent back to the customer.

---

## Architecture

```
Frontend (React/Vite, port 5000)    Backend (Express 5, port 3001)
┌──────────────────────────────┐    ┌──────────────────────────────────────┐
│ AdminView.tsx                │    │ server.js                            │
│  - Gmail tab UI              │◄──►│  - REST API routes (/api/gmail/*)   │
│  - Poll every 30s            │    │  - OAuth callback handler            │
│  - Connection/disconnect     │    │                                      │
│  - Settings form             │    │ gmailService.js                      │
│                              │    │  - Google OAuth2 client             │
│ storageService.ts            │    │  - fetchUnreadEmails()               │
│  - HTTP client for all       │    │  - sendReply()                       │
│    /api/gmail/* endpoints    │    │  - markAsRead()                      │
└──────────────────────────────┘    │                                      │
                                    │ gmailPolling.js                      │
                                    │  - pollGmail() — queue new emails    │
                                    │  - importPendingEmails() — create    │
                                    │    print jobs from attachments       │
                                    │  - startPolling/stopPolling          │
                                    │                                      │
                                    │ db.js                                │
                                    │  - gmail_account table (tokens)      │
                                    │  - gmail_pending table (queue)       │
                                    │  - processed_emissions table         │
                                    │  - settings (credentials, config)   │
                                    └──────────────────────────────────────┘
```

---

## Database Tables

### `gmail_account` (singleton row, id=1)

| Column | Purpose |
|---|---|
| `gmail_email` | Connected email address |
| `access_token` | Encrypted OAuth access token |
| `refresh_token` | Encrypted OAuth refresh token |
| `token_expiry` | ISO timestamp of token expiration |
| `connected_at` | When the account was connected |
| `is_active` | 0/1 flag |

### `gmail_pending`

| Column | Purpose |
|---|---|
| `id` | Auto-increment PK |
| `gmail_message_id` | Gmail's unique message ID (unique constraint) |
| `email_from` | Sender display name |
| `email_address` | Sender email |
| `subject` | Email subject line |
| `body_preview` | First 500 chars of plaintext body |
| `attachment_meta` | JSON array of `{filename, mimeType, attachmentId, size}` |
| `received_at` | Date header from the email |
| `fetched_at` | When the system queued this email |

### `processed_emails`

| Column | Purpose |
|---|---|
| `id` | Auto-increment PK |
| `gmail_message_id` | Unique Gmail message ID |
| `processed_at` | Timestamp |

Prevents re-importing the same message.

### `settings` (relevant keys)

| Key | Value |
|---|---|
| `google_client_id` | Google OAuth client ID |
| `google_client_secret` | Google OAuth client secret |
| `gmailPollInterval` | Polling interval in seconds (default 60) |
| `gmailReplyTemplate` | Auto-reply template text |

---

## OAuth 2.0 Flow

Google OAuth credentials (Client ID + Client Secret) must be saved in the admin panel first. These are stored in the `settings` table under keys `google_client_id` and `google_client_secret`.

### Step-by-step

1. **Admin clicks "Connect Gmail"** → frontend calls `GET /api/gmail/auth`
2. **Server constructs redirect URI** from the request host: `{protocol}://{host}/api/gmail/callback`
3. **Server creates an OAuth2 client** from stored credentials and generates an auth URL with these scopes:
   - `gmail.readonly` — read emails
   - `gmail.modify` — mark messages as read
   - `gmail.send` — auto-reply
4. **Browser opens a popup** to Google's consent screen
5. **User authorizes** → Google redirects to `/api/gmail/callback?code=...`
6. **Server exchanges the code** for access + refresh tokens
7. **Server fetches the user's Gmail profile** to get the email address
8. **Tokens are encrypted and saved** to `gmail_account` row
9. **Polling starts** automatically
10. **Popup closes**, frontend polls every 1s for popup closure, then calls `loadGmailStatus()` to reflect the connected state

### Token Refresh

`getGmailClient()` checks `token_expiry`. If expired, it calls `oauth2Client.refreshAccessToken()` and updates the stored tokens. A `tokens` event listener also captures and persists token refreshes that happen during API calls.

---

## Polling Mechanism

### Server-side (configurable interval, default 60s)

Managed by `gmailPolling.js` — `startPolling(intervalMs)` sets up a `setInterval` that calls `pollGmail()`.

`pollGmail()` flow:

1. Check if `gmail_account` is active; return early if not
2. Call `fetchUnreadEmails()` which queries Gmail API for `is:unread` (max 20)
3. For each unread message:
   - Skip if already processed or already pending (dedup by `gmail_message_id`)
   - Extract headers: From, Subject, Date
   - Parse sender name + email from the `From` header
   - Extract plaintext body from the MIME payload
   - Extract attachment metadata (filename, mimeType, attachmentId, size)
   - Insert into `gmail_pending` table
4. Returns `{ new: count, skipped: count }`

### Client-side (30s interval)

A `useEffect` in `AdminView.tsx` runs every 30 seconds when Gmail is connected:

1. Call `storageService.triggerGmailPoll()` (triggers server-side `pollGmail()`)
2. Call `storageService.getGmailPending()` to refresh the pending list
3. If count increased, show a toast notification: "X new email(s)"

### Auto-start on server boot

When the Express server starts, it checks `gmail_account.is_active`. If connected, it automatically starts polling with the saved interval.

---

## Pending Email Queue

Emails fetched by polling are stored in `gmail_pending` and displayed in a review table in the admin panel.

### Table UI features

- Each row shows: sender (name + email), subject (truncated), attachments (with file type icons + sizes), and date
- Rows are clickable to toggle selection
- "Select All" checkbox in the header
- Sticky toolbar: "Import Selected (N)" and "Discard" buttons
- Empty state: the table only appears when there are pending emails

### Attachment Preview

Each attachment in the pending table has a "Preview" button that fetches the attachment data via `GET /api/gmail/attachment/:pendingId/:index` and displays it. PDFs render in an iframe, images display full-size, other files show a download link.

---

## Import Process

When the admin clicks "Import Selected":

### `POST /api/gmail/import` → `importPendingEmails(ids)`

For each selected pending email:

1. **Retrieve the pending email** from the DB by ID
2. **For each attachment:**
   - Fetch attachment data from Gmail API using `attachmentId`
   - Save to `uploads/` directory via `saveAttachment()`
   - Create a `jobs` row:
     - `customerName` = sender's display name
     - `customerEmail` = sender's email
     - `notes` = `"From: {subject}\n\n{body_preview}"`
     - `fileName` = attachment filename
     - `fileType` = MIME type
     - `source` = `'gmail'`
     - Status = `'PENDING'`
     - Default `colorMode` = `'color'`, `copies` = 1, `paperType` = `'normal'`
3. **Mark as read** in Gmail (remove UNREAD label)
4. **Add to `processed_emails`** to prevent re-import
5. **Remove from `gmail_pending`** queue
6. **Send auto-reply** (if configured — see below)

Per-email error handling: if one email fails, the batch continues with the rest. Results show `{ id, subject, jobs }` for successes and `{ id, error }` for failures.

### Error Recovery

- `GET /api/gmail/pending` re-parses `attachment_meta` from JSON string to array
- Individual email failures in a batch import don't block others
- Server logs warnings for non-critical failures (mark-as-read, auto-reply)

---

## Auto-Reply

After a successful import, the system can automatically reply to the customer.

### Template

The reply body is generated from a customizable template stored in `settings.gmailReplyTemplate`. Default template:

```
Thank you for your print request!

We have received your file(s) and will process them shortly.
Files received: {fileCount}
{jobBreakdown}
Estimated total: {totalPrice}

We will notify you when your prints are ready.

Best regards,
{shopName}
```

### Price calculation

Prices in the reply are computed per attachment using **the admin's import settings** (color mode, copies, paper type) chosen in the review panel, multiplied by the **real page count** of the file (PDFs via `pdf-lib`, images = 1 page, DOCX estimated from file size). The per-page rate comes from the matching row in `paper_types`, falling back to `settings.pricing.*PerPage`. Active discount rules are then applied per-attachment using the shared logic in `utils/discountLogic.js` (matches what the admin dashboard shows). The same `pageCount` is persisted on the job row, so the dashboard and the customer email quote the same number.

### Placeholders

| Placeholder | Replaced with |
|---|---|
| `{shopName}` | `settings.shopName` (or "Print Shop") |
| `{fileName}` | Comma-separated filenames from the created jobs |
| `{fileCount}` | Number of jobs created |
| `{jobBreakdown}` | Multi-line per-file breakdown; discounted lines show `original → final (rule name)` |
| `{totalPrice}` | Grand total **after discount** — this is the number the customer pays |
| `{originalTotal}` | Grand total **before discount** |
| `{discountAmount}` | Total money saved across all attachments |
| `{savingsPercentage}` | e.g. `20%` — savings share of the original total |
| `{discountRule}` | Comma-separated names of the rules that fired (or `—`) |
| `{totalPages}` | Sum of page counts across imported files |
| `{totalCopies}` | Sum of copies across imported files |
| `{totalSheets}` | Sum of `pageCount × copies` across imported files |
| `{pageCount}` | Page count of the first imported file (single-attachment shortcut) |
| `{copies}` | Copies chosen for the first imported file |
| `{currency}` | Currency code (currently `DZD`) |
| `{estimatedPrice}` | **Deprecated alias for `{totalPrice}`** — kept so old templates keep working |

### How it's sent

`sendReply(originalMessageId, replyBody)`:

1. Fetch the original message with `format: 'metadata'` and requested headers: From, Subject, Message-ID, References, In-Reply-To
2. Construct a raw RFC 2822 reply:
   - `To:` = the original sender (from the `From` header)
   - `Subject:` = `Re: {original subject}`
   - `In-Reply-To:` = original Message-ID
   - `References:` = original References + Message-ID
   - `ThreadId:` = original thread (so reply nests in the same conversation)
3. Base64url-encode the raw message
4. Send via `gmail.users.messages.send`

If auto-reply fails (e.g., recipient parsing issue), the import still succeeds — the error is logged as a warning only.

---

## Settings & Configuration

All settings are managed in the admin panel under the Email tab.

### Google OAuth Credentials

- Hidden behind "Show OAuth settings" toggle
- Two inputs: Client ID, Client Secret
- "Save Gmail Credentials" button
- On GET, the secret is masked as `'********'`; `hasClientSecret` boolean signals whether one is saved
- Saved to `settings` table keys `google_client_id` / `google_client_secret`

### Poll Interval

- Number input (10–3600 seconds, default 60)
- Separate "Save" button
- On save: persists to `settings.gmailPollInterval` and calls `restartPolling()` with the new interval

### Auto-reply Template

- Textarea with placeholder list of available placeholders
- Separate "Save Template" button
- Saved to `settings.gmailReplyTemplate`

---

## API Route Reference

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/gmail/status` | Return `{ connected, email }` |
| GET | `/api/gmail/auth` | Return OAuth URL for Google consent |
| GET | `/api/gmail/callback` | OAuth callback — exchange code for tokens |
| POST | `/api/gmail/disconnect` | Clear account, stop polling |
| POST | `/api/gmail/poll` | Trigger one manual poll cycle |
| GET | `/api/gmail/pending` | List all queued pending emails |
| POST | `/api/gmail/import` | Import selected emails as print jobs |
| DELETE | `/api/gmail/pending/:id` | Discard a pending email |
| GET | `/api/gmail/attachment/:pendingId/:index` | Fetch attachment data for preview |
| GET | `/api/gmail/settings` | Get saved credentials + config |
| POST | `/api/gmail/settings` | Save credentials / poll interval / reply template |

---

## Key Files

| File | Role |
|---|---|
| `services/gmailService.js` | Google API client, OAuth flow, fetch/send/mark |
| `services/gmailPolling.js` | Poll loop, pending queue management, import logic |
| `services/storageService.ts` | Frontend HTTP client for all Gmail endpoints |
| `views/AdminView.tsx` | Gmail tab UI — connection, settings, pending table |
| `server.js` | All `/api/gmail/*` Express route handlers |
| `db.js` | SQLite tables and helper functions for Gmail data |
