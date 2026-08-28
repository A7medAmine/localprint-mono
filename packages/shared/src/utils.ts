import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

// Merge Tailwind class strings, resolving conflicts (last wins) via
// tailwind-merge after clsx flattens conditionals. Identical helper both apps
// used from their own lib/utils.ts before Phase 4.2 folded them into one.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
