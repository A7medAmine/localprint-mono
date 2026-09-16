import { useEffect, useRef, useState } from "react";
import type * as L from "leaflet";

/**
 * Leaflet is ~150KB and only two screens ever need it (the settings picker and
 * the storefront map), so it is imported lazily rather than bundled into the
 * upload page every customer loads. The CSS ships with it and has to be loaded
 * before the map is created or the tiles stack up in one corner.
 */
let leafletPromise: Promise<typeof L> | null = null;

export function loadLeaflet(): Promise<typeof L> {
  if (!leafletPromise) {
    leafletPromise = Promise.all([
      import("leaflet"),
      // Vite turns this into a stylesheet injection; the path has no types.
      import("leaflet/dist/leaflet.css" as string),
    ]).then(([mod]) => {
      const leaflet = (mod.default ?? mod) as typeof L;
      // Leaflet's default marker points at image files by relative URL, which
      // breaks under a bundler. Every marker we create passes its own icon, so
      // the broken default is never used — this just makes that explicit.
      delete (leaflet.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
      return leaflet;
    });
  }
  return leafletPromise;
}

/**
 * A pin drawn as inline SVG, so the map needs no image assets and the marker
 * picks up the app's accent colour.
 */
export function pinIcon(leaflet: typeof L, color = "#2563eb"): L.DivIcon {
  return leaflet.divIcon({
    className: "",
    html: `<svg width="30" height="40" viewBox="0 0 30 40" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M15 0C6.7 0 0 6.7 0 15c0 10.5 13.4 23.8 14 24.4a1.4 1.4 0 0 0 2 0c.6-.6 14-13.9 14-24.4C30 6.7 23.3 0 15 0z" fill="${color}"/>
      <circle cx="15" cy="15" r="5.5" fill="#fff"/>
    </svg>`,
    iconSize: [30, 40],
    iconAnchor: [15, 40],
    popupAnchor: [0, -38],
  });
}

type LoadState = "loading" | "ready" | "failed";

/**
 * Loads Leaflet and reports whether it is usable. The desktop app runs in
 * print shops that are regularly offline, so a caller must be able to fall
 * back to the coordinate field instead of rendering a dead grey box.
 */
export function useLeaflet(): { leaflet: typeof L | null; state: LoadState } {
  const [leaflet, setLeaflet] = useState<typeof L | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    loadLeaflet()
      .then((mod) => {
        if (!mounted.current) return;
        setLeaflet(mod);
        setState("ready");
      })
      .catch(() => {
        if (mounted.current) setState("failed");
      });
    return () => {
      mounted.current = false;
    };
  }, []);

  return { leaflet, state };
}

/** OpenStreetMap's tile server, plus the attribution its policy requires. */
export const OSM_TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
export const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

/** Centre of Algiers — where a picker opens when the shop has no pin yet. */
export const DEFAULT_CENTER = { lat: 36.7538, lng: 3.0588 };
export const DEFAULT_ZOOM = 6;
/** Zoom used once there is an actual pin to look at — street level. */
export const PIN_ZOOM = 16;
