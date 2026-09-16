// Type declarations for social.js (plain .js so the Node servers can import it).

export type SocialPlatformId =
  | "facebook"
  | "instagram"
  | "tiktok"
  | "whatsapp"
  | "telegram"
  | "youtube"
  | "website";

export interface SocialPlatform {
  id: SocialPlatformId;
  label: string;
  labelAr: string;
  /** An example LINK — every field takes a URL, never a username. */
  placeholder: string;
}

/** What a shop stores as its `socialLinks` setting: platform id → https URL. */
export type SocialLinks = Partial<Record<SocialPlatformId, string>>;

export const SOCIAL_PLATFORMS: SocialPlatform[];
export const SOCIAL_PLATFORM_IDS: SocialPlatformId[];
export const MAX_DESCRIPTION_LENGTH: number;

export function normalizeSocialUrl(platformId: string, raw: unknown): string | null;
export function normalizeSocialLinks(raw: unknown): SocialLinks;
export function activeSocialLinks(
  links: SocialLinks | null | undefined,
): { platform: SocialPlatform; url: string }[];
export function normalizeDescription(raw: unknown): string;
