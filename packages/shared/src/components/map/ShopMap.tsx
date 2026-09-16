import React, { useEffect, useRef } from "react";
import type * as L from "leaflet";
import type { ShopLocation } from "../../geo";
import {
  OSM_ATTRIBUTION,
  OSM_TILE_URL,
  PIN_ZOOM,
  pinIcon,
  useLeaflet,
} from "./useLeaflet";

export interface ShopMapProps {
  location: ShopLocation | { lat: number; lng: number };
  /** Rendered under the pin in a popup — usually the shop name and address. */
  title?: string;
  /** Tailwind height class; the map needs an explicit height or it collapses. */
  className?: string;
  zoom?: number;
  /** Shown instead of the map when Leaflet or its tiles can't load. */
  fallback?: React.ReactNode;
}

/**
 * Read-only map with one pin: the storefront page's "here is the shop".
 * Interaction is deliberately limited — no scroll-wheel zoom, because a map
 * inside a scrolling page that eats the wheel is the classic way to trap a
 * customer halfway down the page.
 */
export default function ShopMap({
  location,
  title,
  className = "h-56 w-full",
  zoom = PIN_ZOOM,
  fallback = null,
}: ShopMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const { leaflet, state } = useLeaflet();

  useEffect(() => {
    if (!leaflet || !containerRef.current || mapRef.current) return;

    const map = leaflet.map(containerRef.current, {
      center: [location.lat, location.lng],
      zoom,
      scrollWheelZoom: false,
      attributionControl: true,
    });
    leaflet.tileLayer(OSM_TILE_URL, { attribution: OSM_ATTRIBUTION, maxZoom: 19 }).addTo(map);

    const marker = leaflet.marker([location.lat, location.lng], { icon: pinIcon(leaflet) }).addTo(map);
    if (title) marker.bindPopup(title);

    mapRef.current = map;
    markerRef.current = marker;
    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // The map is created once; position changes are handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaflet]);

  // A shop that moves its pin while the page is open (the settings preview)
  // should not tear the whole map down and rebuild it.
  useEffect(() => {
    if (!mapRef.current) return;
    mapRef.current.setView([location.lat, location.lng], zoom);
    markerRef.current?.setLatLng([location.lat, location.lng]);
  }, [location.lat, location.lng, zoom]);

  if (state === "failed") return <>{fallback}</>;

  return <div ref={containerRef} className={className} aria-label={title || "Map"} role="img" />;
}
