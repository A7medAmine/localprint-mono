// Server-side-only access to the Research Generator's two providers
// (Omniroute for AI text, the shop's SearXNG gateway for images). Both keys
// are in SECRET_SETTINGS_KEYS and must never reach the renderer — the
// renderer asks this Express server, and only this server (via these
// helpers) talks to Omniroute / SearXNG. Phases 2 and 3 consume these.
import { getSettings } from "../db.js";

/**
 * Returns { baseUrl, apiKey, model } or null when the shop hasn't configured
 * an AI provider yet.
 */
export function getAiConfig() {
  const settings = getSettings();
  const baseUrl = String(process.env.AI_BASE_URL || settings.aiBaseUrl || "").trim();
  const apiKey = String(process.env.AI_API_KEY || settings.aiApiKey || "").trim();
  const model = String(process.env.AI_MODEL || settings.aiModel || "").trim();
  if (!baseUrl || !apiKey || !model) return null;
  return { baseUrl, apiKey, model };
}

/**
 * Returns { baseUrl, apiKey } or null when the shop hasn't configured the
 * image search gateway yet.
 */
export function getImageSearchConfig() {
  const settings = getSettings();
  const baseUrl = String(process.env.IMAGE_SEARCH_URL || settings.imageSearchUrl || "").trim();
  const apiKey = String(process.env.IMAGE_SEARCH_KEY || settings.imageSearchKey || "").trim();
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
}
