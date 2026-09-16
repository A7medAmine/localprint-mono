import { readPref } from "@atba3li/shared/lib/prefs";
/**
 * Open the admin SSE stream (`/api/events`).
 *
 * The endpoint requires a valid admin token. EventSource cannot set an
 * Authorization header, so the token travels as a query parameter — the server
 * accepts that fallback for this endpoint only. Keeping the URL construction in
 * one place stops the three call sites from drifting.
 */
export function openAdminEventSource(): EventSource {
  const token = readPref("adminToken", "");
  return new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
}
