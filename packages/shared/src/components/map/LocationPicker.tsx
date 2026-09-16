import React, { useCallback, useEffect, useRef, useState } from "react";
import type * as L from "leaflet";
import type { Coordinates, LocationSource, ShopLocation } from "../../geo";
import {
  isShortMapLink,
  normalizeLocation,
  parseCoordinatePair,
  parseMapUrl,
} from "../../geo";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Icon } from "../ui/icon";
import {
  DEFAULT_CENTER,
  DEFAULT_ZOOM,
  OSM_ATTRIBUTION,
  OSM_TILE_URL,
  PIN_ZOOM,
  pinIcon,
  useLeaflet,
} from "./useLeaflet";

export interface LocationPickerProps {
  value: ShopLocation | null;
  onChange: (location: ShopLocation | null) => void;
  isRtl?: boolean;
  /**
   * Resolves a short map link (maps.app.goo.gl/...) into coordinates. Needs a
   * server round trip, so the host app supplies it; without one the picker
   * still accepts every link that carries its position in the URL.
   */
  resolveShortLink?: (url: string) => Promise<Coordinates | null>;
}

type Status = { kind: "idle" } | { kind: "busy"; message: string } | { kind: "error"; message: string };

const text = {
  en: {
    pasteLabel: "Paste a map link",
    pasteHint: "Google Maps, Waze or OpenStreetMap — the share link from your listing",
    pasteAction: "Read link",
    gps: "Use my current position",
    coordsLabel: "Or type coordinates",
    coordsPlaceholder: "36.7538, 3.0588",
    coordsAction: "Set",
    mapHint: "Click the map or drag the pin to place your shop exactly.",
    clear: "Remove location",
    noPin: "No location set yet.",
    pinSet: "Pin set",
    accuracy: (m: number) => `accurate to about ${m} m`,
    errLink: "That link has no location in it. Open it in the map app, then copy the link again.",
    errShortLink: "Short links need the app to be online. Paste the full link, or pick on the map.",
    errCoords: "Enter a latitude and longitude, like 36.7538, 3.0588",
    errGpsDenied: "Location permission was refused. Pick on the map instead.",
    errGpsUnavailable: "Could not get a position from this device. Pick on the map instead.",
    busyLink: "Reading the link…",
    busyGps: "Getting your position…",
    mapUnavailable: "The map could not load (no internet?). You can still paste a link or type coordinates.",
  },
  ar: {
    pasteLabel: "الصق رابط خريطة",
    pasteHint: "خرائط جوجل أو Waze أو OpenStreetMap — رابط المشاركة من صفحة محلك",
    pasteAction: "قراءة الرابط",
    gps: "استعمل موقعي الحالي",
    coordsLabel: "أو اكتب الإحداثيات",
    coordsPlaceholder: "36.7538, 3.0588",
    coordsAction: "تعيين",
    mapHint: "انقر على الخريطة أو اسحب العلامة لتحديد موقع المحل بدقة.",
    clear: "حذف الموقع",
    noPin: "لم يتم تحديد موقع بعد.",
    pinSet: "تم تحديد الموقع",
    accuracy: (m: number) => `بدقة حوالي ${m} م`,
    errLink: "هذا الرابط لا يحتوي على موقع. افتحه في تطبيق الخرائط ثم انسخ الرابط من جديد.",
    errShortLink: "الروابط المختصرة تحتاج اتصالاً بالإنترنت. الصق الرابط الكامل أو حدد على الخريطة.",
    errCoords: "أدخل خط العرض وخط الطول، مثل 36.7538, 3.0588",
    errGpsDenied: "تم رفض إذن الموقع. حدد الموقع على الخريطة.",
    errGpsUnavailable: "تعذر الحصول على الموقع من هذا الجهاز. حدد الموقع على الخريطة.",
    busyLink: "جارٍ قراءة الرابط…",
    busyGps: "جارٍ تحديد موقعك…",
    mapUnavailable: "تعذر تحميل الخريطة (لا يوجد إنترنت؟). يمكنك لصق رابط أو كتابة الإحداثيات.",
  },
};

/**
 * The four ways a shop owner sets their position, in one panel: paste a map
 * link, read the device GPS, click/drag on the map, or type the numbers.
 *
 * They are four routes to the same pin rather than four modes, because the
 * owner does not know in advance which one will work: GPS is unreliable on a
 * desktop machine, a link only exists if the shop is already listed somewhere,
 * and the map needs the internet. Whichever succeeds, the pin lands on the map
 * and the owner confirms it there before saving.
 */
export default function LocationPicker({
  value,
  onChange,
  isRtl = false,
  resolveShortLink,
}: LocationPickerProps) {
  const t = isRtl ? text.ar : text.en;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const { leaflet, state: mapState } = useLeaflet();

  const [linkInput, setLinkInput] = useState("");
  const [coordsInput, setCoordsInput] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // Kept in a ref so the map's click handler — registered once — always sees
  // the current callback instead of the one from the first render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const setPin = useCallback((coords: Coordinates, source: LocationSource, extra?: Partial<ShopLocation>) => {
    const location = normalizeLocation({ ...coords, ...extra, source, updatedAt: new Date().toISOString() });
    if (!location) return;
    onChangeRef.current(location);
    setStatus({ kind: "idle" });
    mapRef.current?.setView([location.lat, location.lng], PIN_ZOOM);
  }, []);

  // ── The map: created once, then kept in sync with `value` ──
  useEffect(() => {
    if (!leaflet || !containerRef.current || mapRef.current) return;

    const start = value ?? DEFAULT_CENTER;
    const map = leaflet.map(containerRef.current, {
      center: [start.lat, start.lng],
      zoom: value ? PIN_ZOOM : DEFAULT_ZOOM,
    });
    leaflet.tileLayer(OSM_TILE_URL, { attribution: OSM_ATTRIBUTION, maxZoom: 19 }).addTo(map);
    map.on("click", (event: L.LeafletMouseEvent) => {
      setPin({ lat: event.latlng.lat, lng: event.latlng.lng }, "map");
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // Created once — `value` is read for the initial view only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaflet, setPin]);

  // The marker follows `value` whichever of the four routes produced it, so
  // pasting a link and dragging the pin land in exactly the same place.
  useEffect(() => {
    const map = mapRef.current;
    if (!leaflet || !map) return;

    if (!value) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }

    if (markerRef.current) {
      markerRef.current.setLatLng([value.lat, value.lng]);
      return;
    }

    const marker = leaflet
      .marker([value.lat, value.lng], { icon: pinIcon(leaflet), draggable: true })
      .addTo(map);
    marker.on("dragend", () => {
      const { lat, lng } = marker.getLatLng();
      setPin({ lat, lng }, "map");
    });
    markerRef.current = marker;
  }, [leaflet, value, setPin]);

  // Leaflet measures the container when the map is created. Inside a dialog
  // that animates open, that measurement happens while the element is still
  // zero-height, leaving the tiles bunched in a corner until something forces
  // a recalculation.
  useEffect(() => {
    if (!mapRef.current || !containerRef.current) return;
    const observer = new ResizeObserver(() => mapRef.current?.invalidateSize());
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [leaflet]);

  // ── Route 1: a pasted map link ──
  const handleLink = async () => {
    const raw = linkInput.trim();
    if (!raw) return;

    const direct = parseMapUrl(raw);
    if (direct) {
      setPin(direct, "url");
      setLinkInput("");
      return;
    }

    if (!isShortMapLink(raw) || !resolveShortLink) {
      setStatus({ kind: "error", message: isShortMapLink(raw) ? t.errShortLink : t.errLink });
      return;
    }

    setStatus({ kind: "busy", message: t.busyLink });
    try {
      const coords = await resolveShortLink(raw);
      if (!coords) {
        setStatus({ kind: "error", message: t.errLink });
        return;
      }
      setPin(coords, "url");
      setLinkInput("");
    } catch (err) {
      // The resolver reports why it failed ("that link has no location in it",
      // "could not reach the map service"); pass it through rather than
      // flattening every failure into the offline message.
      const message = err instanceof Error && err.message ? err.message : t.errShortLink;
      setStatus({ kind: "error", message });
    }
  };

  // ── Route 2: the device's own position ──
  const handleGps = () => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setStatus({ kind: "error", message: t.errGpsUnavailable });
      return;
    }
    setStatus({ kind: "busy", message: t.busyGps });
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setPin(
          { lat: position.coords.latitude, lng: position.coords.longitude },
          "gps",
          { accuracy: position.coords.accuracy },
        );
      },
      (error) => {
        // On a desktop machine Chromium resolves position through a network
        // service that an Electron build has no key for, so this path fails
        // far more often here than it does in a phone browser. The map stays
        // the reliable route, and the message says so.
        setStatus({
          kind: "error",
          message: error.code === error.PERMISSION_DENIED ? t.errGpsDenied : t.errGpsUnavailable,
        });
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    );
  };

  // ── Route 4: typed numbers (route 3 is the map itself) ──
  const handleCoords = () => {
    const coords = parseCoordinatePair(coordsInput);
    if (!coords) {
      setStatus({ kind: "error", message: t.errCoords });
      return;
    }
    setPin(coords, "manual");
    setCoordsInput("");
  };

  const busy = status.kind === "busy";

  return (
    <div className="space-y-4" dir={isRtl ? "rtl" : "ltr"}>
      <div className="space-y-1.5">
        <label className="text-sm font-medium">{t.pasteLabel}</label>
        <div className="flex gap-2">
          <Input
            value={linkInput}
            onChange={(e) => setLinkInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleLink();
              }
            }}
            placeholder="https://maps.app.goo.gl/…"
            dir="ltr"
            disabled={busy}
          />
          <Button type="button" variant="secondary" onClick={handleLink} disabled={busy || !linkInput.trim()}>
            {t.pasteAction}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t.pasteHint}</p>
      </div>

      <Button type="button" variant="outline" onClick={handleGps} disabled={busy} className="w-full">
        <Icon name="map-pin" className="h-4 w-4" />
        {t.gps}
      </Button>

      {mapState === "failed" ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          {t.mapUnavailable}
        </p>
      ) : (
        <div className="space-y-1.5">
          <div ref={containerRef} className="h-64 w-full rounded-md border" />
          <p className="text-xs text-muted-foreground">{t.mapHint}</p>
        </div>
      )}

      <div className="space-y-1.5">
        <label className="text-sm font-medium">{t.coordsLabel}</label>
        <div className="flex gap-2">
          <Input
            value={coordsInput}
            onChange={(e) => setCoordsInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleCoords();
              }
            }}
            placeholder={t.coordsPlaceholder}
            dir="ltr"
            disabled={busy}
          />
          <Button type="button" variant="secondary" onClick={handleCoords} disabled={busy || !coordsInput.trim()}>
            {t.coordsAction}
          </Button>
        </div>
      </div>

      {status.kind !== "idle" && (
        <p className={status.kind === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
          {status.message}
        </p>
      )}

      <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2 text-sm">
        {value ? (
          <span dir="ltr" className="font-mono text-xs">
            {value.lat.toFixed(5)}, {value.lng.toFixed(5)}
            {value.accuracy ? <span className="ms-2 font-sans text-muted-foreground">{t.accuracy(Math.round(value.accuracy))}</span> : null}
          </span>
        ) : (
          <span className="text-muted-foreground">{t.noPin}</span>
        )}
        {value && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
            {t.clear}
          </Button>
        )}
      </div>
    </div>
  );
}
