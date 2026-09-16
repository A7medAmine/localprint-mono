// Environment + on-disk locations, in one place so every server module agrees
// on where things live.
//
// ATBA3LI_UPLOADS_DIR / ATBA3LI_DB_PATH are set by the Electron main
// process for packaged builds (so runtime data lives under userData, not
// Program Files). Fall back to repo-relative paths for `npm run dev`.
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
// server/ lives one level below the app root.
export const APP_ROOT = path.dirname(path.dirname(__filename));

export const NODE_ENV = process.env.NODE_ENV || "development";
export const isDev = NODE_ENV === "development";
export const PORT = process.env.PORT || (isDev ? 3001 : 3000);
export const HOST = process.env.HOST || "127.0.0.1";
export const DEV_ORIGIN = process.env.DEV_CORS_ORIGIN || "http://localhost:3000";

export const DIST_DIR = path.join(APP_ROOT, "dist");
export const PUBLIC_DIR = path.join(APP_ROOT, "public");
export const UPLOADS_DIR = process.env.ATBA3LI_UPLOADS_DIR || path.join(APP_ROOT, "uploads");
export const DB_PATH = process.env.ATBA3LI_DB_PATH || path.join(APP_ROOT, "database.sqlite");
export const PREVIEW_CACHE_DIR = path.join(UPLOADS_DIR, "preview_cache");

/** Create the directories the server writes into. */
export function ensureDirs() {
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  if (!fs.existsSync(DIST_DIR) && !isDev) {
    console.warn("⚠️  DIST_DIR does not exist. Run build first!");
  }
}
