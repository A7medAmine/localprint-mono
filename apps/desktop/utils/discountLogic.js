// Re-export shim. The discount math now lives in the shared package so both
// clients and both Node servers run identical code. Consumed by Node
// (services/gmailPolling.js) and the pricing tests via this path.
export { calculateJobDiscount } from "@atba3li/shared/discountLogic";
