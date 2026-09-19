// AI-generated research papers ("بحث") built and printed in-shop, saved so
// they can be reprinted later without regenerating. Mirrors cvs.js's shape.
//
// Generation (phase 2) talks to Omniroute in two rounds — see
// server/research/aiClient.js and server/research/curriculumGuide.js:
//   1. one outline call (title, intro, section headings/summaries, conclusion, sources)
//   2. one call per section body, up to 3 in flight at a time
// Nothing is persisted until the whole round succeeds, so a failed
// generate/extend/expand leaves the saved copy (if any) untouched — the
// operator's undo is simply "reload the saved copy".
//
// Latency: generation takes 20-60s end to end. This app has no SSE/streaming
// precedent anywhere in its routes (every route here and in cvs.js is a
// plain request/response), and the route contract below returns the full
// saved row, not a stream of events, so we use a normal request with the
// timeout raised on the OUTBOUND Omniroute calls (aiClient's
// REQUEST_TIMEOUT_MS) rather than SSE. Node's default HTTP server timeout
// (~5 minutes) comfortably covers the 20-60s wait; no server.timeout change
// was needed. A future phase's UI can still show optimistic per-section
// progress client-side without any server change, since the section count
// is known as soon as the outline resolves — but showing the outline itself
// mid-request would require SSE, which is out of scope for this phase.
import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import {
  getResearchPapers,
  getResearchPaper,
  createResearchPaper,
  updateResearchPaper,
  deleteResearchPaper,
} from "../../db.js";
import { requireAdmin } from "../adminAuth.js";
import { getAiConfig } from "../providerConfig.js";
import { UPLOADS_DIR } from "../config.js";
import { chatJson } from "../research/aiClient.js";
import {
  computeSectionPlan,
  buildOutlineSystemPrompt,
  buildOutlineUserPrompt,
  buildSectionSystemPrompt,
  buildSectionUserPrompt,
  buildExtendOutlineSystemPrompt,
  buildExtendOutlineUserPrompt,
} from "../research/curriculumGuide.js";
import { getImageSearchWindow } from "../research/imageSearch.js";
import { saveResearchImages, deleteResearchImageFile } from "../research/imageFetch.js";

const SECTION_CONCURRENCY = 3;
const VALID_LEVELS = new Set(["primary", "middle", "secondary"]);
const VALID_LANGUAGES = new Set(["ar", "en", "fr"]);

// Runs `worker` over `items` with at most `limit` calls in flight at once,
// preserving result order. Rejects (and stops scheduling new work) on the
// first worker rejection, same as Promise.all — a single failed section
// fails the whole round rather than silently dropping it, so nothing half
// -written gets persisted.
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runNext() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  const lane = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: lane }, runNext));
  return results;
}

function makeSectionId() {
  return `sec_${randomBytes(6).toString("hex")}`;
}

// ~2.2 tokens per requested word covers Arabic/French sub-word tokenization
// headroom better than a 1:1 estimate, plus a fixed floor for short asks.
function tokensForWords(words) {
  return Math.max(300, Math.round(words * 2.2));
}

async function generateOutline({ topic, level, subject, language, targetPages, customInstructions, includeSources }) {
  const plan = computeSectionPlan(level, targetPages);
  const system = buildOutlineSystemPrompt({ level, subject, language, includeSources });
  const user = buildOutlineUserPrompt({ topic, level, subject, language, targetPages, customInstructions });
  const maxTokens = tokensForWords(plan.sectionCount * 60 + plan.introWords + plan.conclusionWords + 200);
  const outline = await chatJson({ system, user, maxTokens, temperature: 0.7 });

  if (!outline || typeof outline !== "object" || !Array.isArray(outline.sections) || outline.sections.length === 0) {
    throw new Error("Omniroute returned an outline in an unexpected shape");
  }
  return { outline, plan };
}

async function generateSectionBody({ topic, level, subject, language, outline, section, wordTarget, customInstructions }) {
  const system = buildSectionSystemPrompt({ level, subject, language });
  const user = buildSectionUserPrompt({ topic, level, subject, language, outline, section, wordTarget, customInstructions });
  const maxTokens = tokensForWords(wordTarget + 150);
  const result = await chatJson({ system, user, maxTokens, temperature: 0.7 });
  const body = typeof result?.body === "string" ? result.body.trim() : "";
  if (!body) throw new Error(`Omniroute returned an empty body for section "${section.heading}"`);
  return body;
}

// Runs the section-body calls with a concurrency limit and assembles a
// plain ResearchDocument-shaped sections array. Does not touch the
// database — callers persist only once this resolves.
//
// `sectionsToGenerate` are the sections that actually get a body call.
// `contextOutline` is what each call sees for coherence (it can carry
// extra sections — e.g. ones the document already has — that are NOT
// regenerated); it defaults to `{ title: topic, sections: sectionsToGenerate }`.
async function generateSections({ topic, level, subject, language, sectionsToGenerate, contextOutline, wordTarget, customInstructions }) {
  const outline = contextOutline || { title: topic, sections: sectionsToGenerate };
  const bodies = await mapWithConcurrency(sectionsToGenerate, SECTION_CONCURRENCY, (section) =>
    generateSectionBody({ topic, level, subject, language, outline, section, wordTarget, customInstructions })
  );
  return sectionsToGenerate.map((section, i) => ({
    id: makeSectionId(),
    heading: String(section.heading || "").trim(),
    body: bodies[i],
    imageIds: [],
  }));
}

function defaultTypography(language) {
  return {
    fontSize: 14,
    lineHeight: 1.6,
    fontFamily: language === "ar" ? "naskh" : "sans",
    showCoverPage: false,
    showToc: false,
    mode: "simple",
  };
}

function validateGenerateBody(body) {
  const topic = String(body?.topic || "").trim();
  const level = VALID_LEVELS.has(body?.level) ? body.level : null;
  const language = VALID_LANGUAGES.has(body?.language) ? body.language : null;
  const targetPages = Number(body?.targetPages);
  if (!topic) return { error: "Missing required field (topic)" };
  if (!level) return { error: "level must be one of primary, middle, secondary" };
  if (!language) return { error: "language must be one of ar, en, fr" };
  if (!Number.isFinite(targetPages) || targetPages <= 0) return { error: "targetPages must be a positive number" };
  const subject = String(body?.subject || "").trim();
  const customInstructions = String(body?.customInstructions || "").trim();
  const includeSources = body?.includeSources !== false;
  return { topic, level, language, targetPages, subject, customInstructions, includeSources };
}

export function registerResearchRoutes(app) {
  app.get("/api/research", requireAdmin, (req, res) => {
    try {
      res.status(200).json(getResearchPapers(req.query.search ? String(req.query.search) : undefined));
    } catch (err) {
      console.error("❌ Error fetching research papers:", err);
      res.status(500).json({ error: "Failed to fetch research papers" });
    }
  });

  app.get("/api/research/:id", requireAdmin, (req, res) => {
    try {
      const paper = getResearchPaper(req.params.id);
      if (!paper) return res.status(404).json({ error: "Research paper not found" });
      res.status(200).json(paper);
    } catch (err) {
      console.error("❌ Error fetching research paper:", err);
      res.status(500).json({ error: "Failed to fetch research paper" });
    }
  });

  app.post("/api/research", requireAdmin, (req, res) => {
    try {
      const { title, subject, level, language, data } = req.body;
      if (!title || !String(title).trim()) {
        return res.status(400).json({ error: "Missing required field (title)" });
      }
      const paper = createResearchPaper({
        id: `res_${randomBytes(8).toString("hex")}`,
        title: String(title).trim(),
        subject: subject ? String(subject).trim() : "",
        level: level || "middle",
        language: language || "ar",
        data: data && typeof data === "object" ? data : {},
      });
      res.status(201).json(paper);
    } catch (err) {
      console.error("❌ Error creating research paper:", err);
      res.status(500).json({ error: "Failed to create research paper" });
    }
  });

  app.put("/api/research/:id", requireAdmin, (req, res) => {
    try {
      const { title, subject, level, language, data } = req.body;
      const updates = {};
      if (title !== undefined) updates.title = String(title).trim();
      if (subject !== undefined) updates.subject = String(subject).trim();
      if (level !== undefined) updates.level = level;
      if (language !== undefined) updates.language = language;
      if (data !== undefined && typeof data === "object") updates.data = data;

      const paper = updateResearchPaper(req.params.id, updates);
      if (!paper) return res.status(404).json({ error: "Research paper not found" });
      res.status(200).json(paper);
    } catch (err) {
      console.error("❌ Error updating research paper:", err);
      res.status(500).json({ error: "Failed to update research paper" });
    }
  });

  app.delete("/api/research/:id", requireAdmin, (req, res) => {
    try {
      const paper = getResearchPaper(req.params.id);
      if (!paper) return res.status(404).json({ error: "Research paper not found" });
      deleteResearchPaper(req.params.id);
      res.status(200).json({ success: true, id: req.params.id });
    } catch (err) {
      console.error("❌ Error deleting research paper:", err);
      res.status(500).json({ error: "Failed to delete research paper" });
    }
  });

  // ── Generation (phase 2) ──────────────────────────────────────────────

  // Full generate: outline call, then one call per section body (up to 3 in
  // flight), assembled into a ResearchDocument and persisted only once the
  // whole round has succeeded.
  app.post("/api/research/generate", requireAdmin, async (req, res) => {
    const parsed = validateGenerateBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { topic, level, language, targetPages, subject, customInstructions, includeSources } = parsed;

    if (!getAiConfig()) {
      return res.status(400).json({ error: "Omniroute is not configured — set the AI provider in Settings" });
    }

    try {
      const { outline, plan } = await generateOutline({ topic, level, subject, language, targetPages, customInstructions, includeSources });
      const sections = await generateSections({
        topic, level, subject, language,
        sectionsToGenerate: outline.sections,
        contextOutline: outline,
        wordTarget: plan.wordsPerSection,
        customInstructions,
      });

      const config = getAiConfig();
      const data = {
        level,
        language,
        subject,
        targetPages,
        customInstructions,
        studentName: "",
        schoolName: "",
        schoolYear: "",
        teacherName: "",
        introduction: String(outline.introduction || "").trim(),
        sections,
        conclusion: String(outline.conclusion || "").trim(),
        sources: includeSources && Array.isArray(outline.sources) ? outline.sources.map((s) => String(s).trim()).filter(Boolean) : [],
        images: [],
        typography: defaultTypography(language),
        generatedBy: config?.model,
        generatedAt: new Date().toISOString(),
      };

      const title = String(outline.title || topic).trim();
      const paper = createResearchPaper({
        id: `res_${randomBytes(8).toString("hex")}`,
        title,
        subject,
        level,
        language,
        data,
      });
      res.status(201).json(paper);
    } catch (err) {
      console.error("❌ Error generating research paper:", err);
      res.status(502).json({ error: err.message || "Failed to generate research paper" });
    }
  });

  // Extend: append N new sections covering ground the document doesn't
  // cover yet. Non-destructive — existing sections are never touched, and
  // nothing is written until the new sections have all been generated.
  app.post("/api/research/:id/extend", requireAdmin, async (req, res) => {
    const paper = getResearchPaper(req.params.id);
    if (!paper) return res.status(404).json({ error: "Research paper not found" });

    const sectionCount = Math.round(Number(req.body?.sectionCount));
    if (!Number.isFinite(sectionCount) || sectionCount < 1 || sectionCount > 6) {
      return res.status(400).json({ error: "sectionCount must be a number between 1 and 6" });
    }
    if (!getAiConfig()) {
      return res.status(400).json({ error: "Omniroute is not configured — set the AI provider in Settings" });
    }

    const { level, language, subject, data } = paper;
    const topic = data?.title || paper.title;
    const targetPages = data?.targetPages || 3;
    const customInstructions = data?.customInstructions || "";
    const existingHeadings = (data?.sections || []).map((s) => s.heading);

    try {
      const system = buildExtendOutlineSystemPrompt({ level, subject, language });
      const { prompt: user, wordTarget } = buildExtendOutlineUserPrompt({
        topic, level, subject, language, targetPages, customInstructions, existingHeadings, sectionCount,
      });
      const maxTokens = tokensForWords(sectionCount * 60 + 200);
      const outline = await chatJson({ system, user, maxTokens, temperature: 0.7 });
      if (!outline || !Array.isArray(outline.sections) || outline.sections.length === 0) {
        throw new Error("Omniroute returned an extension outline in an unexpected shape");
      }

      // Full outline for section-writing context: existing headings
      // (summary unknown for already-written sections, so fall back to a
      // short stand-in) plus the newly proposed ones, so each new section
      // call still sees the whole document shape and avoids repeating it —
      // but only the newly proposed sections actually get a body call.
      const contextOutline = {
        title: topic,
        sections: [
          ...(data?.sections || []).map((s) => ({ heading: s.heading, summary: "(already written)" })),
          ...outline.sections,
        ],
      };

      const appended = await generateSections({
        topic, level, subject, language,
        sectionsToGenerate: outline.sections,
        contextOutline,
        wordTarget,
        customInstructions,
      });

      const updatedData = {
        ...data,
        sections: [...(data?.sections || []), ...appended],
      };
      const updated = updateResearchPaper(req.params.id, { data: updatedData });
      res.status(200).json(updated);
    } catch (err) {
      console.error("❌ Error extending research paper:", err);
      res.status(502).json({ error: err.message || "Failed to extend research paper" });
    }
  });

  // Expand: regenerate one section at a longer word target, keeping its
  // heading. Replaces only that section's body; every other section (and
  // the images attached to this one) is untouched.
  app.post("/api/research/:id/sections/:sectionId/expand", requireAdmin, async (req, res) => {
    const paper = getResearchPaper(req.params.id);
    if (!paper) return res.status(404).json({ error: "Research paper not found" });

    const wordTarget = Math.round(Number(req.body?.wordTarget));
    if (!Number.isFinite(wordTarget) || wordTarget < 30 || wordTarget > 2000) {
      return res.status(400).json({ error: "wordTarget must be a number between 30 and 2000" });
    }
    const sections = paper.data?.sections || [];
    const targetIndex = sections.findIndex((s) => s.id === req.params.sectionId);
    if (targetIndex === -1) return res.status(404).json({ error: "Section not found" });
    if (!getAiConfig()) {
      return res.status(400).json({ error: "Omniroute is not configured — set the AI provider in Settings" });
    }

    const { level, language, subject, data } = paper;
    const topic = data?.title || paper.title;
    const customInstructions = data?.customInstructions || "";
    const section = sections[targetIndex];
    const outlineForContext = {
      title: topic,
      sections: sections.map((s) => ({
        heading: s.heading,
        summary: s.id === section.id ? "(rewrite this section, longer)" : "(already written)",
      })),
    };

    try {
      const body = await generateSectionBody({
        topic, level, subject, language,
        outline: outlineForContext,
        section: { heading: section.heading, summary: section.heading },
        wordTarget,
        customInstructions,
      });

      const updatedSections = sections.map((s, i) => (i === targetIndex ? { ...s, body } : s));
      const updated = updateResearchPaper(req.params.id, { data: { ...data, sections: updatedSections } });
      res.status(200).json(updated);
    } catch (err) {
      console.error("❌ Error expanding research section:", err);
      res.status(502).json({ error: err.message || "Failed to expand section" });
    }
  });

  // ── Images (phase 3) ───────────────────────────────────────────────────

  // Search: "refresh for new ones" windowing over a 10-minute in-memory
  // cache (falling back to the 30-day disk cache, then SearXNG) — see
  // server/research/imageSearch.js.
  app.get("/api/research/images/search", requireAdmin, async (req, res) => {
    const query = req.query.q ? String(req.query.q).trim() : "";
    if (!query) return res.status(400).json({ error: "q is required" });
    const window = Number(req.query.window) || 0;

    try {
      const result = await getImageSearchWindow({ query, window });
      res.status(200).json(result);
    } catch (err) {
      console.error("❌ Error searching images:", err);
      res.status(502).json({ error: err.message || "Failed to search images" });
    }
  });

  // Download-on-selection: each candidate is fetched, validated and stored
  // independently — one bad host never fails the whole save (per-image
  // failures come back in `failures` alongside the updated document).
  app.post("/api/research/:id/images", requireAdmin, async (req, res) => {
    const paper = getResearchPaper(req.params.id);
    if (!paper) return res.status(404).json({ error: "Research paper not found" });

    const candidates = Array.isArray(req.body?.candidates) ? req.body.candidates : [];
    if (candidates.length === 0) {
      return res.status(400).json({ error: "candidates must be a non-empty array" });
    }

    try {
      const { images, failures } = await saveResearchImages(candidates);
      const data = paper.data || {};
      const updatedData = { ...data, images: [...(data.images || []), ...images] };
      const updated = updateResearchPaper(req.params.id, { data: updatedData });
      res.status(200).json({ ...updated, failures });
    } catch (err) {
      console.error("❌ Error saving research images:", err);
      res.status(500).json({ error: err.message || "Failed to save images" });
    }
  });

  // Serves a stored research image's bytes. Mirrors GET /api/cvs/:id/photo,
  // including its path-traversal guard.
  app.get("/api/research/:id/images/:imageId/file", requireAdmin, (req, res) => {
    const paper = getResearchPaper(req.params.id);
    if (!paper) return res.status(404).json({ error: "Research paper not found" });
    const image = (paper.data?.images || []).find((img) => img.id === req.params.imageId);
    if (!image?.filename) return res.status(404).json({ error: "Image not found" });

    const filePath = path.resolve(path.join(UPLOADS_DIR, image.filename));
    if (!filePath.startsWith(path.resolve(UPLOADS_DIR)) || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Image file not found" });
    }
    res.sendFile(filePath);
  });

  // Recaption / move an image to a different section.
  app.put("/api/research/:id/images/:imageId", requireAdmin, (req, res) => {
    const paper = getResearchPaper(req.params.id);
    if (!paper) return res.status(404).json({ error: "Research paper not found" });

    const data = paper.data || {};
    const images = data.images || [];
    const index = images.findIndex((img) => img.id === req.params.imageId);
    if (index === -1) return res.status(404).json({ error: "Image not found" });

    const { caption, sectionId } = req.body || {};
    const updatedImages = images.slice();
    if (caption !== undefined) {
      updatedImages[index] = { ...updatedImages[index], caption: String(caption) };
    }

    let sections = data.sections || [];
    if (sectionId !== undefined) {
      const targetSectionId = sectionId === null ? null : String(sectionId);
      if (targetSectionId !== null && !sections.some((s) => s.id === targetSectionId)) {
        return res.status(400).json({ error: "sectionId does not match any section" });
      }
      sections = sections.map((s) => ({
        ...s,
        imageIds: (s.imageIds || []).filter((imgId) => imgId !== req.params.imageId),
      }));
      if (targetSectionId !== null) {
        sections = sections.map((s) =>
          s.id === targetSectionId ? { ...s, imageIds: [...(s.imageIds || []), req.params.imageId] } : s
        );
      }
    }

    const updated = updateResearchPaper(req.params.id, {
      data: { ...data, images: updatedImages, sections },
    });
    res.status(200).json(updated);
  });

  // Removes the file and the reference (and drops it from whichever section held it).
  app.delete("/api/research/:id/images/:imageId", requireAdmin, (req, res) => {
    const paper = getResearchPaper(req.params.id);
    if (!paper) return res.status(404).json({ error: "Research paper not found" });

    const data = paper.data || {};
    const images = data.images || [];
    const image = images.find((img) => img.id === req.params.imageId);
    if (!image) return res.status(404).json({ error: "Image not found" });

    deleteResearchImageFile(image.filename);

    const updatedImages = images.filter((img) => img.id !== req.params.imageId);
    const sections = (data.sections || []).map((s) => ({
      ...s,
      imageIds: (s.imageIds || []).filter((imgId) => imgId !== req.params.imageId),
    }));

    const updated = updateResearchPaper(req.params.id, {
      data: { ...data, images: updatedImages, sections },
    });
    res.status(200).json(updated);
  });
}
