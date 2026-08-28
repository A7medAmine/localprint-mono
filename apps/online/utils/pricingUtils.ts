// Re-export shim. The single price + discount calculator now lives in the
// shared package (@localprint/shared/pricing, plain .js so the Node servers can
// import the same code the client uses). Types come from the co-located
// pricing.d.ts. This unifies on the canonical calculator: the old inline copy
// here logged verbose console output and discounted on actualPages rather than
// totalPages (pages × copies) — both dropped in favor of the shared code.
export * from "@localprint/shared/pricing";
