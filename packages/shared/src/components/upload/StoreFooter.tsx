import React from "react";
import { ShopSettings } from "../../types";
import { activeSocialLinks } from "../../social";
import { StoreSocialLinks } from "../StoreSocialLinks";
import { Icon } from "../ui/icon";

export interface StoreFooterProps {
  isRtl: boolean;
  shopSettings: ShopSettings | null;
}

/**
 * The shop's own sign-off at the bottom of the upload screen: who they are
 * (description) and where else to find them (social links).
 *
 * Optional by design — a shop that filled neither field gets no empty footer.
 * Contact details stay in the Store Info dialog; this is the public-face row,
 * not a second copy of the address book.
 */
export const StoreFooter: React.FC<StoreFooterProps> = ({ isRtl, shopSettings }) => {
  const description = (shopSettings?.description || "").trim();
  const hasSocials = activeSocialLinks(shopSettings?.socialLinks).length > 0;
  if (!description && !hasSocials) return null;

  return (
    <footer className="mt-10 border-t border-border pt-6 pb-8 text-center">
      {shopSettings?.shopName && (
        <p className="flex items-center justify-center gap-2 text-sm font-bold text-foreground" dir="auto">
          <Icon name="print" className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
          {shopSettings.shopName}
        </p>
      )}
      {description && (
        <p
          dir="auto"
          className="mx-auto mt-2 max-w-xl whitespace-pre-line text-sm text-muted-foreground"
        >
          {description}
        </p>
      )}
      {hasSocials && (
        <>
          <p className="mt-4 text-xs font-semibold text-muted-foreground">
            {isRtl ? "تابعنا على" : "Follow us"}
          </p>
          <StoreSocialLinks
            socialLinks={shopSettings?.socialLinks}
            isRtl={isRtl}
            variant="plain"
            className="mt-2 justify-center"
          />
        </>
      )}
    </footer>
  );
};
