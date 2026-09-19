// Thin fetch wrapper around Omniroute, a self-hosted OpenAI-compatible chat
// completions gateway. No `openai` SDK dependency — this app keeps its HTTP
// thin (see apps/desktop/server/routes/settings.js's map-link resolver for
// the same plain-fetch style). Server-side only: the caller must never let
// the resolved key or base URL reach the renderer.
import { getAiConfig } from "../providerConfig.js";

const REQUEST_TIMEOUT_MS = 90_000;
const RETRY_DELAY_MS = 1_500;

/**
 * Pulls the outermost {...} out of a string that may have prose wrapped
 * around genuine JSON — some models behind a gateway ignore
 * response_format and answer with "Here is the JSON:\n{...}\n" anyway.
 * Returns the original string untouched if no brace is found, so a normal
 * JSON.parse failure still surfaces a clear error.
 */
function stripToOutermostObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return text;
  return text.slice(start, end + 1);
}

async function postChatCompletion(config, { system, user, maxTokens, temperature }) {
  const response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: maxTokens,
      temperature: temperature ?? 0.7,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return response;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calls Omniroute's chat/completions endpoint and returns the parsed JSON
 * body of the model's reply. Retries once on 429/5xx with a short backoff.
 * Throws a caller-friendly Error — readable by a shop operator, not a raw
 * fetch/parse exception — on every failure path.
 */
export async function chatJson({ system, user, maxTokens, temperature }) {
  const config = getAiConfig();
  if (!config) {
    throw new Error("Omniroute is not configured — set the AI provider in Settings");
  }

  let response;
  try {
    response = await postChatCompletion(config, { system, user, maxTokens, temperature });
  } catch (err) {
    throw new Error(`Could not reach Omniroute: ${err.message || "network error"}`);
  }

  if (!response.ok && (response.status === 429 || response.status >= 500)) {
    await sleep(RETRY_DELAY_MS);
    try {
      response = await postChatCompletion(config, { system, user, maxTokens, temperature });
    } catch (err) {
      throw new Error(`Could not reach Omniroute: ${err.message || "network error"}`);
    }
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(
      `Omniroute request failed (${response.status}): ${bodyText.slice(0, 300) || response.statusText}`
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Omniroute returned a response that was not valid JSON");
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Omniroute returned an empty response");
  }

  try {
    return JSON.parse(content);
  } catch {
    try {
      return JSON.parse(stripToOutermostObject(content));
    } catch {
      throw new Error("Omniroute returned text that could not be parsed as JSON");
    }
  }
}
