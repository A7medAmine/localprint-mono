// Type declarations for geo.js (which is plain .js so the Node servers can
// import it). Keeps the TypeScript clients fully typed.

export type LocationSource = "map" | "gps" | "url" | "manual";

/** A coordinate pair with no provenance — what a parser returns. */
export interface Coordinates {
  lat: number;
  lng: number;
}

/** What a shop stores as its `location` setting. */
export interface ShopLocation extends Coordinates {
  /** Radius in metres reported by the GPS fix, when the pin came from one. */
  accuracy?: number;
  source: LocationSource;
  /** Human-readable place name, shown under the map. */
  label?: string;
  updatedAt: string;
}

export const LOCATION_SOURCES: LocationSource[];

export function toFiniteNumber(value: unknown): number | null;
export function isValidLatitude(value: unknown): boolean;
export function isValidLongitude(value: unknown): boolean;
export function normalizeLocation(input: unknown): ShopLocation | null;
export function parseCoordinatePair(raw: unknown): Coordinates | null;
export function isShortMapLink(raw: unknown): boolean;
export function parseMapUrl(raw: unknown): Coordinates | null;
export function distanceKm(
  from: Coordinates | null | undefined,
  to: Coordinates | null | undefined,
): number | null;
export function formatDistance(km: number | null, locale?: string): string;
export function sortByDistance<T extends { location?: ShopLocation | null }>(
  shops: T[],
  origin: Coordinates | null | undefined,
): (T & { distanceKm: number | null })[];
export function directionsUrl(location: unknown): string | null;
