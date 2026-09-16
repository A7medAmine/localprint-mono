// Re-export shim. The single price + discount calculator now lives in the
// shared package (@atba3li/shared/pricing, plain .js so the Node servers can
// import the same code the client uses). Types come from the co-located
// pricing.d.ts.
export * from "@atba3li/shared/pricing";
