// Print Studio work-in-progress persistence.
//
// Two levels:
//  - In-session (always on): every snapshot is also held in a module-level
//    cache. That survives unmounting — switching Print Studio tools, and
//    above all navigating away to the dashboard and back, which tears the
//    whole PrintStudio route down. It dies with the page (reload / restart).
//  - Across restarts: on by default, switchable off in Settings → Print
//    Studio. The same snapshot is written to IndexedDB, which — unlike
//    localStorage — stores File/Blob/ArrayBuffer values directly via
//    structured clone, so the actual images and PDFs come back, not just the
//    options around them.
//
// ImageBitmap and canvases are deliberately never put in a snapshot: they are
// re-derived from the stored File on restore.

import { useEffect, useRef } from "react";
import { readPref, writePref } from "@atba3li/shared/lib/prefs";

export type StudioToolId = "cards" | "photos" | "pdf";

const DB_NAME = "printstudio";
const DB_VERSION = 1;
const STORE = "sessions";

/** Snapshots older than this are dropped on read — a week-old half-finished
 *  card is noise, not work in progress. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** On unless the shop explicitly turned it off — an unset preference means a
 *  fresh install, where keeping work is the expected behaviour. */
export function isStudioPersistEnabled(): boolean {
  return readPref("studioPersist") !== "0";
}

export function setStudioPersistEnabled(enabled: boolean): void {
  writePref("studioPersist", enabled ? "1" : "0");
  if (!enabled) void clearAllStudioSnapshots();
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const store = db.transaction(STORE, mode).objectStore(STORE);
          const req = run(store);
          req.onsuccess = () => resolve(req.result ?? null);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

interface Envelope<T> {
  savedAt: number;
  state: T;
}

/** Live snapshots for this page session, kept whether or not the
 *  across-restarts setting is on. */
const memCache = new Map<StudioToolId, unknown>();

/** Write (or, for an empty state, drop) this tool's snapshot. Always updates
 *  the in-memory cache; only touches IndexedDB while the across-restarts
 *  setting is on, so that setting stays the only thing that writes files to
 *  disk. */
export async function saveStudioSnapshot<T>(tool: StudioToolId, state: T | null): Promise<void> {
  if (state == null) memCache.delete(tool);
  else memCache.set(tool, state);
  if (!isStudioPersistEnabled()) return;
  if (state == null) {
    await clearStudioSnapshot(tool);
    return;
  }
  const envelope: Envelope<T> = { savedAt: Date.now(), state };
  await tx("readwrite", (store) => store.put(envelope, tool) as IDBRequest<IDBValidKey>);
}

export async function loadStudioSnapshot<T>(tool: StudioToolId): Promise<T | null> {
  // Same page session — the live state is still in memory and is newer than
  // anything on disk.
  const cached = memCache.get(tool);
  if (cached) return cached as T;
  if (!isStudioPersistEnabled()) return null;
  const envelope = (await tx("readonly", (store) => store.get(tool) as IDBRequest<Envelope<T>>)) as Envelope<T> | null;
  if (!envelope || typeof envelope.savedAt !== "number") return null;
  if (Date.now() - envelope.savedAt > MAX_AGE_MS) {
    await clearStudioSnapshot(tool);
    return null;
  }
  return envelope.state ?? null;
}

/** Whether anything is stored for this tool — used by callers that have their
 *  own, narrower restore path and must not run it on top of ours. */
export async function hasStudioSnapshot(tool: StudioToolId): Promise<boolean> {
  return (await loadStudioSnapshot(tool)) != null;
}

export async function clearStudioSnapshot(tool: StudioToolId): Promise<void> {
  memCache.delete(tool);
  await tx("readwrite", (store) => store.delete(tool) as IDBRequest<undefined>);
}

export async function clearAllStudioSnapshots(): Promise<void> {
  memCache.clear();
  await tx("readwrite", (store) => store.clear() as IDBRequest<undefined>);
}

/**
 * Keep `state` for `tool` whenever it changes, debounced so dragging a
 * slider doesn't write a PDF to disk on every frame. `state` is rebuilt on
 * each render by the caller, so it must be cheap — put Files in it, never
 * decoded bitmaps.
 *
 * Pass `ready: false` until the tool has finished restoring, otherwise the
 * empty initial state overwrites the snapshot before it is read.
 */
export function useStudioSnapshot<T>(tool: StudioToolId, state: T | null, ready: boolean, delayMs = 600): void {
  const stateRef = useRef(state);
  stateRef.current = state;
  const readyRef = useRef(ready);
  readyRef.current = ready;

  // Leaving the route unmounts the tool, usually well inside the debounce
  // window — write the final state straight out instead of losing it.
  useEffect(
    () => () => {
      if (readyRef.current) void saveStudioSnapshot(tool, stateRef.current);
    },
    [tool],
  );

  useEffect(() => {
    if (!ready) return;
    const id = window.setTimeout(() => {
      void saveStudioSnapshot(tool, stateRef.current);
    }, delayMs);
    return () => window.clearTimeout(id);
    // The snapshot object is rebuilt each render; JSON-ish identity is not
    // available (it holds Files), so the effect intentionally re-runs on every
    // render and the debounce collapses the writes.
  });
}

/**
 * Restore a snapshot once on mount. `apply` is called only when a snapshot
 * exists; `done` always runs afterwards so the caller can flip its ready flag.
 */
export function useStudioRestore<T>(
  tool: StudioToolId,
  apply: (state: T) => void | Promise<void>,
  done: () => void,
): void {
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const doneRef = useRef(done);
  doneRef.current = done;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const state = await loadStudioSnapshot<T>(tool);
        if (!cancelled && state) await applyRef.current(state);
      } catch (e) {
        console.error(`Failed to restore Print Studio ${tool} session:`, e);
      } finally {
        if (!cancelled) doneRef.current();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tool]);
}
