import React from "react";
import type { SocialLinks, SocialPlatformId } from "../social";
import { activeSocialLinks } from "../social";

// lucide dropped its brand marks, so the six platforms carry their own paths.
// They are simple single-path glyphs drawn on the same 24×24 grid as every
// other icon, which keeps them visually consistent with lucide's stroke icons
// even though these are filled.
const BRAND_PATHS: Record<Exclude<SocialPlatformId, "website">, string> = {
  facebook:
    "M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06C2 17.08 5.66 21.24 10.44 22v-7.03H7.9v-2.91h2.54V9.85c0-2.52 1.49-3.91 3.77-3.91 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.78-1.63 1.57v1.89h2.78l-.45 2.91h-2.33V22C18.34 21.24 22 17.08 22 12.06z",
  instagram:
    "M12 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.42.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.42.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41-.56-.22-.96-.48-1.38-.9-.42-.42-.68-.82-.9-1.38-.16-.42-.36-1.06-.41-2.23-.06-1.27-.07-1.65-.07-4.85s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.16 1.06-.36 2.23-.41 1.27-.06 1.65-.07 4.85-.07zm0 6.68a3.16 3.16 0 100 6.32 3.16 3.16 0 000-6.32zm0-1.8a4.96 4.96 0 110 9.92 4.96 4.96 0 010-9.92zm6.3-.23a1.16 1.16 0 11-2.32 0 1.16 1.16 0 012.32 0z",
  tiktok:
    "M16.6 5.82A4.28 4.28 0 0115.54 3h-3.09v12.4a2.59 2.59 0 01-2.59 2.5 2.59 2.59 0 01-2.59-2.59 2.59 2.59 0 013.27-2.5v-3.13a5.71 5.71 0 00-.68-.04A5.68 5.68 0 004.2 15.31 5.68 5.68 0 0015.54 15.5V9.16a7.34 7.34 0 004.3 1.38V7.45a4.29 4.29 0 01-3.24-1.63z",
  whatsapp:
    "M12.04 2c-5.5 0-9.96 4.46-9.96 9.96 0 1.76.46 3.48 1.34 5L2 22l5.17-1.36a9.93 9.93 0 004.87 1.25h.01c5.5 0 9.96-4.46 9.96-9.96A9.9 9.9 0 0019.1 4.9 9.9 9.9 0 0012.04 2zm0 1.82c2.18 0 4.23.85 5.77 2.39a8.12 8.12 0 012.39 5.77c0 4.5-3.66 8.15-8.16 8.15a8.14 8.14 0 01-4.15-1.14l-.3-.18-3.07.81.82-3-.19-.31a8.1 8.1 0 01-1.25-4.34c0-4.5 3.66-8.15 8.14-8.15zm-2.4 4.1c-.19 0-.5.07-.76.35-.26.28-1 .98-1 2.39s1.02 2.77 1.17 2.96c.14.19 2.01 3.07 4.87 4.19.68.29 1.21.46 1.63.59.68.22 1.3.19 1.79.12.55-.08 1.68-.69 1.92-1.35.24-.66.24-1.23.17-1.35-.07-.12-.26-.19-.54-.33-.28-.14-1.68-.83-1.94-.92-.26-.1-.45-.14-.64.14-.19.28-.73.92-.89 1.11-.17.19-.33.21-.61.07-.28-.14-1.2-.44-2.28-1.41-.84-.75-1.41-1.68-1.58-1.96-.16-.28-.02-.43.12-.57.13-.13.28-.33.42-.5.14-.16.19-.28.28-.47.09-.19.05-.35-.02-.5-.07-.14-.63-1.55-.87-2.12-.22-.54-.45-.47-.62-.48h-.53z",
  telegram:
    "M21.94 4.6l-3.02 14.25c-.23 1-.82 1.25-1.66.78l-4.59-3.38-2.21 2.13c-.25.25-.45.45-.92.45l.33-4.67 8.5-7.68c.37-.33-.08-.51-.57-.18l-10.5 6.61-4.52-1.42c-.98-.31-1-.98.21-1.45l17.67-6.81c.82-.3 1.54.19 1.28 1.37z",
  youtube:
    "M23 12s0-3.2-.41-4.74a2.5 2.5 0 00-1.76-1.77C19.29 5.07 12 5.07 12 5.07s-7.29 0-8.83.42a2.5 2.5 0 00-1.76 1.77C1 8.8 1 12 1 12s0 3.2.41 4.74c.23.85.9 1.52 1.76 1.75 1.54.42 8.83.42 8.83.42s7.29 0 8.83-.42a2.5 2.5 0 001.76-1.75C23 15.2 23 12 23 12zM9.75 15.02V8.98L15.5 12l-5.75 3.02z",
};

const WEBSITE_ICON = (
  <>
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <path d="M3 12h18" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <path
      d="M12 3c2.5 2.5 3.8 5.6 3.8 9S14.5 18.5 12 21c-2.5-2.5-3.8-5.6-3.8-9S9.5 5.5 12 3z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    />
  </>
);

export const SocialIcon: React.FC<{ id: SocialPlatformId; className?: string }> = ({
  id,
  className,
}) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className={className} focusable="false">
    {id === "website" ? WEBSITE_ICON : <path fill="currentColor" d={BRAND_PATHS[id]} />}
  </svg>
);

export interface StoreSocialLinksProps {
  socialLinks?: SocialLinks | null;
  isRtl: boolean;
  /** "chip" for the storefront card, "plain" for the upload footer. */
  variant?: "chip" | "plain";
  className?: string;
}

/**
 * The shop's social links as icon buttons. Renders nothing when the shop set
 * none, so callers can drop it in without guarding.
 *
 * Every URL here was normalized to http(s) before it was stored — see
 * `normalizeSocialLinks` — which is what makes it safe to put straight into an
 * `href` on a public page.
 */
export const StoreSocialLinks: React.FC<StoreSocialLinksProps> = ({
  socialLinks,
  isRtl,
  variant = "chip",
  className = "",
}) => {
  const links = activeSocialLinks(socialLinks);
  if (links.length === 0) return null;

  const base =
    variant === "chip"
      ? "inline-flex h-8 w-8 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors hover:bg-indigo-50 hover:text-indigo-700 dark:hover:bg-indigo-900/30 dark:hover:text-indigo-300"
      : "inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition-colors hover:border-indigo-200 hover:text-indigo-600 dark:hover:border-indigo-800/50 dark:hover:text-indigo-400";

  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      {links.map(({ platform, url }) => (
        <a
          key={platform.id}
          href={url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          title={isRtl ? platform.labelAr : platform.label}
          aria-label={isRtl ? platform.labelAr : platform.label}
          className={base}
        >
          <SocialIcon id={platform.id} className="h-4 w-4" />
        </a>
      ))}
    </div>
  );
};
