import { describe, it, expect } from "vitest";
import { buildCvHtml, normalizeCvDocument } from "../components/cvDocument";
import type { CvDocument, CvProfile } from "../types";

const profile = (data: Partial<CvDocument>, extra: Partial<CvProfile> = {}): CvProfile => ({
  id: "cv_1",
  fullName: "Amina Benali",
  phone: "+213 555 12 34 56",
  photoFilename: "",
  data: data as CvDocument,
  ...extra,
});

describe("normalizeCvDocument", () => {
  it("fills every missing field of an old or partial record", () => {
    const doc = normalizeCvDocument({ language: "fr", skills: ["Excel"] } as Partial<CvDocument>);
    expect(doc.language).toBe("fr");
    expect(doc.templateId).toBe("modern");
    expect(doc.fields.experience).toBe(true);
    expect(doc.experience).toEqual([]);
    expect(doc.customSections).toEqual([]);
    expect(doc.skills).toEqual(["Excel"]);
  });

  it("survives garbage without throwing", () => {
    expect(() => normalizeCvDocument(null)).not.toThrow();
    const doc = normalizeCvDocument({ templateId: "nope", experience: "x" } as unknown as Partial<CvDocument>, "en");
    expect(doc.templateId).toBe("modern");
    expect(doc.language).toBe("en");
    expect(doc.experience).toEqual([]);
  });
});

describe("buildCvHtml", () => {
  it("renders a record saved before newer fields existed", () => {
    const html = buildCvHtml({ profile: profile({ language: "ar" } as Partial<CvDocument>), photoDataUrl: null });
    expect(html).toContain("Amina Benali");
    expect(html).toContain('dir="rtl"');
  });

  it("escapes user text", () => {
    const html = buildCvHtml({ profile: profile({ summary: "<script>x</script>" }), photoDataUrl: null });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("isolates the phone number so Arabic layout cannot reorder it", () => {
    const html = buildCvHtml({ profile: profile({ language: "ar" }), photoDataUrl: null });
    expect(html).toContain('<bdi dir="ltr">+213 555 12 34 56</bdi>');
  });

  it("azure: the Contact toggle hides phone, email and address", () => {
    const base = { language: "fr" as const, templateId: "azure" as const, email: "amina@example.com", address: "Oran" };
    const on = buildCvHtml({ profile: profile(base), photoDataUrl: null });
    expect(on).toContain("amina@example.com");
    expect(on).toContain("+213 555");

    const off = buildCvHtml({
      profile: profile({ ...base, fields: { ...normalizeCvDocument({}).fields, contact: false } }),
      photoDataUrl: null,
    });
    expect(off).toContain("Amina Benali");
    expect(off).not.toContain("amina@example.com");
    expect(off).not.toContain("+213 555");
    expect(off).not.toContain("Oran");
  });

  it("azure: keeps the experience description", () => {
    const html = buildCvHtml({
      profile: profile({
        templateId: "azure",
        experience: [{ id: "e1", title: "Vendeuse", subtitle: "Magasin", period: "2021", description: "Accueil des clients" }],
      }),
      photoDataUrl: null,
    });
    expect(html).toContain("Vendeuse — Magasin — 2021");
    expect(html).toContain("Accueil des clients");
  });

  it("leaves out sections that are switched off or empty", () => {
    const html = buildCvHtml({
      profile: profile({
        skills: ["Excel"],
        summary: "Hello",
        fields: { ...normalizeCvDocument({}).fields, skills: false },
      }),
      photoDataUrl: null,
    });
    expect(html).not.toContain("Excel");
    expect(html).toContain("Hello");
    expect(html).not.toMatch(/Experience<\/h2>/);
  });
});
