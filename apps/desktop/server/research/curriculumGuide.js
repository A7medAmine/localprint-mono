// The Algerian-curriculum authoring guide: exported string builders, not one
// frozen blob, because calibration differs sharply by school level (see
// phase-2-ai-generation.md). Every builder here feeds a system or user
// message for apps/desktop/server/research/aiClient.js#chatJson.
//
// The model is always instructed in English (models follow structured
// English instructions more reliably than instructions in the target
// language), but is told explicitly which language to WRITE the document in.

const LEVEL_LABELS = {
  primary: { ar: "ابتدائي (primary, ages 6–11)" },
  middle: { ar: "متوسط (middle, ages 11–15)" },
  secondary: { ar: "ثانوي (secondary, ages 15–18)" },
};

// Section-count range and paragraph density per level, straight from the
// phase spec's level-calibration table.
const LEVEL_RANGES = {
  primary: { minSections: 3, maxSections: 4, minParagraphs: 1, maxParagraphs: 2, wordsPerParagraph: 55 },
  middle: { minSections: 4, maxSections: 6, minParagraphs: 2, maxParagraphs: 3, wordsPerParagraph: 70 },
  secondary: { minSections: 6, maxSections: 8, minParagraphs: 3, maxParagraphs: 5, wordsPerParagraph: 90 },
};

const WORDS_PER_PAGE = 250;

function levelRange(level) {
  return LEVEL_RANGES[level] || LEVEL_RANGES.middle;
}

export function levelLabel(level) {
  return LEVEL_LABELS[level]?.ar || level;
}

/**
 * Works out how many sections to ask for and how many words each section
 * body should target, given the level's calibration range and the
 * operator's requested page count. Deterministic on purpose — the outline
 * call is told the exact numbers rather than "long" or "short", because
 * models hit a stated word count far better than a vague one.
 */
export function computeSectionPlan(level, targetPages) {
  const range = levelRange(level);
  const pages = Math.max(0.2, Number(targetPages) || 3);

  // Below one page the paper is just a short descriptive paragraph — one
  // section, one paragraph, no room for intro/conclusion padding.
  if (pages < 1) {
    return {
      sectionCount: 1,
      wordsPerSection: Math.round(range.wordsPerParagraph * Math.max(0.5, pages)),
      introWords: 0,
      conclusionWords: 0,
      minParagraphs: 1,
      maxParagraphs: 1,
    };
  }

  // More requested pages nudge the section count toward the level's max,
  // but never past it — a primary paper never gets 8 sections no matter how
  // many pages are requested; it gets longer sections instead within reason.
  const spread = range.maxSections - range.minSections;
  const growth = Math.min(1, (pages - 2) / 6); // saturates around 8 pages
  const sectionCount = Math.max(
    range.minSections,
    Math.min(range.maxSections, Math.round(range.minSections + spread * Math.max(0, growth)))
  );

  const totalWords = pages * WORDS_PER_PAGE;
  // Front matter (cover, TOC) is rendered, not written. Reserve a slice of
  // the budget for intro + conclusion so the sections don't eat the whole
  // page count and leave the paper without a proper close.
  const introWords = Math.round(range.wordsPerParagraph * 1.6);
  const conclusionWords = Math.round(range.wordsPerParagraph * 1.6);
  const sectionsBudget = Math.max(totalWords - introWords - conclusionWords, sectionCount * range.wordsPerParagraph * range.minParagraphs);

  const floorPerSection = range.minParagraphs * range.wordsPerParagraph;
  const ceilPerSection = range.maxParagraphs * range.wordsPerParagraph;
  const wordsPerSection = Math.max(
    floorPerSection,
    Math.min(ceilPerSection, Math.round(sectionsBudget / sectionCount))
  );

  return {
    sectionCount,
    wordsPerSection,
    introWords,
    conclusionWords,
    minParagraphs: range.minParagraphs,
    maxParagraphs: range.maxParagraphs,
  };
}

function languageName(language) {
  return { ar: "Arabic", en: "English", fr: "French" }[language] || "Arabic";
}

function levelCalibrationText(level) {
  switch (level) {
    case "primary":
      return [
        "Level calibration — primary (ابتدائي, ages 6-11):",
        "- Simple vocabulary, short sentences, no stacked subordinate clauses.",
        "- Concrete and visual: examples a child sees at home or in the street.",
        "- No statistics, no dates beyond the very well known, no abstract nouns.",
        "- Vowelisation (تشكيل) is not required, but keep words common enough for a child to read.",
        "",
        "If the topic is a single animal (e.g. \"la gazelle\", \"الأسد\", \"the cat\"), this is a classic primary \"éveil scientifique\" animal description — follow this exact style, regardless of document language:",
        "- The section heading is just the animal's name (with its article in French: \"La gazelle\", \"Le lion\"), nothing else.",
        "- One single descriptive paragraph, in this order: (1) what kind of animal it is and where it lives (mammifère/oiseau/reptile... + habitat), (2) what it eats (herbivore/carnivore/omnivore + concrete foods), (3) physical description — coat colour, body parts, distinguishing features (tail, horns, ears, paws...).",
        "- Optionally close with one short, separate sentence stating a single striking trait (e.g. \"La gazelle est un animal très rapide.\"). Keep it to one short sentence, its own paragraph.",
        "- Plain, factual, present tense throughout. No storytelling, no anthropomorphising, no questions to the reader.",
        "- Do not write an introduction or a conclusion for an animal-description topic — the description paragraph(s) are the whole paper.",
      ].join("\n");
    case "secondary":
      return [
        "Level calibration — secondary (ثانوي, ages 15-18):",
        "- Go beyond simple description when the topic allows it: causes, consequences, relationships, comparisons, significance. Don't force advantages/drawbacks onto every topic.",
        "- Reference a law, a treaty, or a scientific principle by name where genuinely relevant.",
        "- Statistics should carry a year when available. Named sources only.",
        "- The conclusion synthesizes findings and, when appropriate, gives a justified outlook — not forced on every topic.",
      ].join("\n");
    case "middle":
    default:
      return [
        "Level calibration — middle (متوسط, ages 11-15):",
        "- Some numbers and dates, defined when used.",
        "- Introduce cause and effect: why it happens, what the result is.",
        "- Give a short definition of any technical term at first use.",
      ].join("\n");
  }
}

function localisationRules(language) {
  const lines = [
    "Algerian localisation rules (apply whatever the level and subject allow):",
    "- Prefer Algerian and Maghrebi examples: Algerian cities, rivers, industries, institutions, historical events, currency in دينار جزائري.",
    "- For Algerian history topics, use the Algerian frame (الثورة التحريرية 1954-1962, أول نوفمبر, the Évian Accords, national figures) when relevant to the topic — don't force it onto unrelated subjects. Get dates right or omit them.",
    "- Geography defaults to Algeria: الصحراء, الأطلس التلي, الهضاب العليا, الساحل, wilayas rather than \"provinces\".",
    "- Civics and religion: respectful, factual tone matching the Algerian curriculum — not devotional prose, not comparative critique.",
    "- Terminology follows the Arabic-language school textbook, not Levantine or Egyptian variants where they differ.",
  ];
  if (language === "fr") {
    lines.push("- This document is in French: use standard French with Algerian context, not France-only references.");
  } else if (language === "en") {
    lines.push("- This document is in English: use standard English; international examples are fine at this level.");
  }
  return lines.join("\n");
}

function sourcePriorityRules() {
  return [
    "Source priority — when listing sources, prefer higher-ranked ones:",
    "1. Official Algerian government and public institutions.",
    "2. Algerian Ministry of Education and official curriculum/textbook materials.",
    "3. Algerian universities and recognized research institutions.",
    "4. International governmental and intergovernmental organizations.",
    "5. Universities, academic publications, recognized scientific organizations.",
    "6. Established educational reference sources.",
    "7. Wikipedia is acceptable for background but should not be the only source for an important claim.",
    "8. Never list blogs, forums, social media, or anonymous sites as sources.",
  ].join("\n");
}

function hardRules() {
  return [
    "Hard rules — follow all of these without exception:",
    "- Never invent a statistic, a date, a named study, or a quotation. If a number is not certain, describe the trend in words instead — never manufacture false precision.",
    "- Never fabricate a source. List only sources that genuinely exist and plausibly cover this topic: a real textbook name, Wikipedia, a well known institution. Do not invent titles or URLs.",
    "- The student must be able to understand and explain every claim orally. Avoid unnecessarily advanced vocabulary; define a technical term simply the first time it appears.",
    "- Never address the reader as a chatbot: no \"سأتحدث في هذا البحث\", no \"Here is your research\", no meta-commentary, no offers to help further.",
    "- Never use markdown syntax in body text (no #, *, -, numbered lists, bold). Plain paragraphs separated by blank lines only. The renderer owns all formatting.",
    "- Write in the requested language throughout. Do not mix languages except for a technical term in parentheses at first use.",
    "- Section headings are short noun phrases, 2 to 6 words, never a question.",
    "- Respond with a single JSON object and nothing else — no prose before or after it.",
  ].join("\n");
}

/**
 * System prompt for the outline call (call 1). Establishes the persona, the
 * level calibration, localisation, and hard rules, then states the exact
 * JSON shape expected back.
 */
export function buildOutlineSystemPrompt({ level, subject, language, includeSources = true }) {
  return [
    `You are an experienced Algerian school teacher writing a "بحث" (school research paper) outline for a ${levelLabel(level)} student on the subject "${subject}".`,
    `Write the outline content in ${languageName(language)}.`,
    "",
    levelCalibrationText(level),
    "",
    localisationRules(language),
    "",
    hardRules(),
    "",
    ...(includeSources ? [sourcePriorityRules(), ""] : []),
    "Output a single JSON object with exactly this shape:",
    `{"title": "…", "introduction": "…", "sections": [{"heading": "…", "summary": "…", "imageQuery": "…"}], "conclusion": "…", "sources": [${includeSources ? '"…"' : ""}]}`,
    "",
    "- introduction: states what the topic is and why it matters, and ends by announcing what the paper will cover. Leave it as an empty string if the requested length is too short to fit one.",
    "- sections[].summary: 1-2 sentences describing what that section will cover — this guides a later call that writes the full body, so be specific.",
    "- sections[].imageQuery: an ENGLISH search query, 2 to 4 words, concrete and depictable (e.g. \"solar panel farm\", not \"the importance of energy\"). Always English regardless of document language — image search engines index English far better.",
    "- conclusion: summarises and closes with an opinion or outlook. Never introduces new facts. Leave it as an empty string if the requested length is too short to fit one.",
    includeSources
      ? "- sources: plausibly real references only (textbook name, Wikipedia, a well known institution)."
      : "- sources: always an empty array — the operator turned off the sources list for this paper.",
  ].join("\n");
}

export function buildOutlineUserPrompt({ topic, level, subject, language, targetPages, customInstructions }) {
  const plan = computeSectionPlan(level, targetPages);
  const isParagraphOnly = plan.introWords === 0 && plan.conclusionWords === 0;
  const lines = [
    `Topic: ${topic}`,
    `Subject: ${subject || "general"}`,
    isParagraphOnly
      ? `Requested length: just one short descriptive paragraph — this is not a full paper, keep it to a single section and leave introduction and conclusion as empty strings.`
      : `Requested length: about ${targetPages} A4 page(s).`,
    `Write exactly ${plan.sectionCount} section${plan.sectionCount > 1 ? "s" : ""}.`,
    `Each section will later be expanded to about ${plan.wordsPerSection} words (${plan.minParagraphs}-${plan.maxParagraphs} paragraphs) — write the summary with enough substance to guide that.`,
  ];
  if (customInstructions && customInstructions.trim()) {
    lines.push(`Operator's custom instructions (follow these too, without breaking the hard rules above): ${customInstructions.trim()}`);
  }
  return lines.join("\n");
}

/**
 * System prompt for a section-body call (call 2, one per section).
 */
export function buildSectionSystemPrompt({ level, subject, language }) {
  return [
    `You are an experienced Algerian school teacher writing one section of a "بحث" (school research paper) for a ${levelLabel(level)} student on the subject "${subject}".`,
    `Write the section body in ${languageName(language)}.`,
    "",
    levelCalibrationText(level),
    "",
    localisationRules(language),
    "",
    hardRules(),
    "",
    "Output a single JSON object with exactly this shape:",
    '{"body": "…"}',
    "- body: plain paragraphs separated by a blank line (\\n\\n). No heading, no markdown, no numbering — just the prose.",
  ].join("\n");
}

export function buildSectionUserPrompt({ topic, level, subject, language, outline, section, wordTarget, customInstructions }) {
  const otherHeadings = (outline?.sections || [])
    .filter((s) => s.heading !== section.heading)
    .map((s) => `- ${s.heading}: ${s.summary}`)
    .join("\n");
  const lines = [
    `Document topic: ${topic}`,
    `Document title: ${outline?.title || topic}`,
    `Full outline, for coherence (do not repeat content from these other sections):\n${otherHeadings || "(none)"}`,
    "",
    `Write the body for this section only:`,
    `Heading: ${section.heading}`,
    `What it should cover: ${section.summary}`,
    `Target length: about ${wordTarget} words.`,
  ];
  if (customInstructions && customInstructions.trim()) {
    lines.push(`Operator's custom instructions (follow these too, without breaking the hard rules above): ${customInstructions.trim()}`);
  }
  return lines.join("\n");
}

/**
 * User prompt for "extend" — new sections appended to an existing document.
 * Existing headings are passed so the model does not repeat ground already
 * covered.
 */
export function buildExtendOutlineUserPrompt({ topic, level, subject, language, targetPages, customInstructions, existingHeadings, sectionCount }) {
  const plan = computeSectionPlan(level, targetPages);
  const wordTarget = plan.wordsPerSection;
  const lines = [
    `Topic: ${topic}`,
    `Subject: ${subject || "general"}`,
    `This document already has these sections — do NOT repeat their content, cover what is still missing:`,
    (existingHeadings || []).map((h) => `- ${h}`).join("\n") || "(none)",
    `Write exactly ${sectionCount} NEW sections that extend the document.`,
    `Each section will later be expanded to about ${wordTarget} words (${plan.minParagraphs}-${plan.maxParagraphs} paragraphs) — write the summary with enough substance to guide that.`,
  ];
  if (customInstructions && customInstructions.trim()) {
    lines.push(`Operator's custom instructions (follow these too, without breaking the hard rules above): ${customInstructions.trim()}`);
  }
  return { prompt: lines.join("\n"), wordTarget };
}

/**
 * System prompt for the extend-outline call — same shape as the outline
 * call but without introduction/conclusion (the document already has both).
 */
export function buildExtendOutlineSystemPrompt({ level, subject, language }) {
  return [
    `You are an experienced Algerian school teacher adding new sections to an existing "بحث" (school research paper) for a ${levelLabel(level)} student on the subject "${subject}".`,
    `Write in ${languageName(language)}.`,
    "",
    levelCalibrationText(level),
    "",
    localisationRules(language),
    "",
    hardRules(),
    "",
    "Output a single JSON object with exactly this shape:",
    '{"sections": [{"heading": "…", "summary": "…", "imageQuery": "…"}]}',
    "- imageQuery: an ENGLISH search query, 2 to 4 words, concrete and depictable, always English regardless of document language.",
  ].join("\n");
}

export { WORDS_PER_PAGE };
