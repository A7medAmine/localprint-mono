import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

// Merge Tailwind class strings, resolving conflicts (last wins) via
// tailwind-merge after clsx flattens conditionals. Identical helper both apps
// used from their own lib/utils.ts before Phase 4.2 folded them into one.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// What a caught value can be shown as. `catch` binds `unknown`, and an
// annotation of `any` there just hides the fact that a thrown string, a DOMException
// or a rejected fetch are all possible.
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}
