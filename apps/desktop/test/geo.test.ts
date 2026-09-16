import { describe, it, expect } from "vitest";
import {
  distanceKm,
  formatDistance,
  isShortMapLink,
  normalizeLocation,
  parseCoordinatePair,
  parseMapUrl,
  sortByDistance,
  directionsUrl,
} from "@atba3li/shared/geo";
import type { ShopLocation } from "@atba3li/shared/geo";

// Algiers, Place des Martyrs — the reference point for the distance cases.
const ALGIERS = { lat: 36.7853, lng: 3.0602 };

describe("parseMapUrl", () => {
  it("prefers the place pin over the camera viewport", () => {
    // A Google place URL carries both: @… is where the map was looking,
    // !3d…!4d… is the pin itself. Picking the viewport puts the shop up to a
    // few hundred metres off.
    const url =
      "https://www.google.com/maps/place/Alger/@36.7000,3.0000,14z/data=!3m1!4b1!4m6!3d36.7853!4d3.0602";
    expect(parseMapUrl(url)).toEqual({ lat: 36.7853, lng: 3.0602 });
  });

  it("reads a plain Google viewport link", () => {
    expect(parseMapUrl("https://www.google.com/maps/@36.7538,3.0588,17z")).toEqual({
      lat: 36.7538,
      lng: 3.0588,
    });
  });

  it("reads a ?q= coordinate query, encoded comma included", () => {
    expect(parseMapUrl("https://maps.google.com/?q=36.7538,3.0588")).toEqual({
      lat: 36.7538,
      lng: 3.0588,
    });
    expect(parseMapUrl("https://maps.google.com/?q=36.7538%2C3.0588")).toEqual({
      lat: 36.7538,
      lng: 3.0588,
    });
  });

  it("reads Waze and OpenStreetMap links", () => {
    expect(parseMapUrl("https://www.waze.com/ul?ll=36.7538,3.0588&navigate=yes")).toEqual({
      lat: 36.7538,
      lng: 3.0588,
    });
    expect(parseMapUrl("https://www.openstreetmap.org/#map=17/36.7538/3.0588")).toEqual({
      lat: 36.7538,
      lng: 3.0588,
    });
    expect(
      parseMapUrl("https://www.openstreetmap.org/?mlat=36.7538&mlon=3.0588#map=17/36.75/3.05"),
    ).toEqual({ lat: 36.7538, lng: 3.0588 });
  });

  it("keeps southern and western hemispheres negative", () => {
    expect(parseMapUrl("https://www.google.com/maps/@-33.8688,-70.6693,12z")).toEqual({
      lat: -33.8688,
      lng: -70.6693,
    });
  });

  it("returns null for a link with no position in it", () => {
    expect(parseMapUrl("https://www.google.com/maps/search/imprimerie+alger")).toBeNull();
    expect(parseMapUrl("https://maps.app.goo.gl/AbCdEf123")).toBeNull();
    expect(parseMapUrl("")).toBeNull();
    expect(parseMapUrl(null)).toBeNull();
  });

  it("rejects out-of-range coordinates rather than storing them", () => {
    expect(parseMapUrl("https://www.google.com/maps/@136.7538,3.0588,17z")).toBeNull();
  });
});

describe("isShortMapLink", () => {
  it("flags the links that must be followed before parsing", () => {
    expect(isShortMapLink("https://maps.app.goo.gl/AbCdEf123")).toBe(true);
    expect(isShortMapLink("https://goo.gl/maps/AbCdEf123")).toBe(true);
    expect(isShortMapLink("https://www.google.com/maps/@36.75,3.05,17z")).toBe(false);
  });
});

describe("parseCoordinatePair", () => {
  it("accepts comma, semicolon and whitespace separators", () => {
    expect(parseCoordinatePair("36.7538, 3.0588")).toEqual({ lat: 36.7538, lng: 3.0588 });
    expect(parseCoordinatePair("36.7538 3.0588")).toEqual({ lat: 36.7538, lng: 3.0588 });
    expect(parseCoordinatePair("36.7538;3.0588")).toEqual({ lat: 36.7538, lng: 3.0588 });
  });

  it("accepts the Arabic decimal separator", () => {
    expect(parseCoordinatePair("36٫7538, 3٫0588")).toEqual({
      lat: 36.7538,
      lng: 3.0588,
    });
  });

  it("rejects a single number or junk", () => {
    expect(parseCoordinatePair("36.7538")).toBeNull();
    expect(parseCoordinatePair("here")).toBeNull();
  });
});

describe("normalizeLocation", () => {
  it("rounds to six decimals and stamps a source and time", () => {
    const result = normalizeLocation({ lat: 36.78531234567, lng: 3.06021234567, source: "gps" });
    expect(result?.lat).toBe(36.785312);
    expect(result?.lng).toBe(3.060212);
    expect(result?.source).toBe("gps");
    expect(Number.isNaN(Date.parse(result!.updatedAt))).toBe(false);
  });

  it("drops unknown keys so the public record can't carry smuggled data", () => {
    const result = normalizeLocation({
      lat: 36.7853,
      lng: 3.0602,
      shopApiToken: "secret",
    } as Record<string, unknown>);
    expect(result).not.toHaveProperty("shopApiToken");
  });

  it("falls back to 'manual' for an unknown source", () => {
    expect(normalizeLocation({ lat: 36.7853, lng: 3.0602, source: "telepathy" })?.source).toBe(
      "manual",
    );
  });

  it("drops a nonsense accuracy but keeps the pin", () => {
    const result = normalizeLocation({ lat: 36.7853, lng: 3.0602, accuracy: -5 });
    expect(result).not.toHaveProperty("accuracy");
    expect(result?.lat).toBe(36.7853);
  });

  it("rejects an empty string rather than reading it as zero", () => {
    // Number("") is 0, a valid latitude — this is the case that would silently
    // drop every shop into the Gulf of Guinea.
    expect(normalizeLocation({ lat: "", lng: "" })).toBeNull();
    expect(normalizeLocation({ lat: null, lng: 3.06 })).toBeNull();
    expect(normalizeLocation(null)).toBeNull();
    expect(normalizeLocation({ lat: 91, lng: 3.06 })).toBeNull();
  });
});

describe("distanceKm", () => {
  it("measures a known city pair within a percent", () => {
    // Algiers → Oran is about 355km great-circle.
    const km = distanceKm(ALGIERS, { lat: 35.6976, lng: -0.6337 });
    expect(km).toBeGreaterThan(350);
    expect(km).toBeLessThan(360);
  });

  it("is zero for the same point and null for a missing one", () => {
    expect(distanceKm(ALGIERS, ALGIERS)).toBe(0);
    expect(distanceKm(ALGIERS, null)).toBeNull();
    expect(distanceKm(ALGIERS, { lat: "x", lng: 3 } as never)).toBeNull();
  });
});

describe("formatDistance", () => {
  it("switches unit under a kilometre and loses the decimal past ten", () => {
    expect(formatDistance(0.85)).toBe("850 m");
    expect(formatDistance(2.44)).toBe("2.4 km");
    expect(formatDistance(37.2)).toBe("37 km");
    expect(formatDistance(2.44, "ar")).toBe("2.4 كم");
    expect(formatDistance(null)).toBe("");
  });
});

describe("sortByDistance", () => {
  const shops: { slug: string; location: ShopLocation | null }[] = [
    { slug: "far", location: { lat: 35.6976, lng: -0.6337, source: "map", updatedAt: "" } },
    { slug: "unset", location: null },
    { slug: "near", location: { lat: 36.79, lng: 3.06, source: "map", updatedAt: "" } },
    { slug: "unset-2", location: null },
  ];

  it("orders by distance and sinks the shops with no pin, in order", () => {
    const sorted = sortByDistance(shops, ALGIERS);
    expect(sorted.map((s) => s.slug)).toEqual(["near", "far", "unset", "unset-2"]);
    expect(sorted[0].distanceKm).toBeLessThan(1);
    expect(sorted[2].distanceKm).toBeNull();
  });

  it("leaves the list alone when there is no origin", () => {
    const sorted = sortByDistance(shops, null);
    expect(sorted.map((s) => s.slug)).toEqual(["far", "unset", "near", "unset-2"]);
  });
});

describe("directionsUrl", () => {
  it("builds a Google directions link, or null without a pin", () => {
    expect(directionsUrl({ lat: 36.7853, lng: 3.0602 })).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=36.7853,3.0602",
    );
    expect(directionsUrl(null)).toBeNull();
  });
});
