// The handful of app-wide signals that travel on `window`.
//
// They stay window events because some of them are dispatched from outside
// React (the storage service on a 401, the Electron bridge), but the payloads
// are declared here so a listener and a dispatcher cannot disagree about the
// shape — and so the full set is greppable in one file.

export interface AppEventMap {
  /** The admin token was rejected; the UI must return to the login screen. */
  "session-expired": undefined;
  /** The backend refuses admin writes until the default password is changed. */
  "must-change-password": undefined;
  /** UI language switched; non-React listeners re-render their own content. */
  "ps:langchange": "en" | "ar";
  /** Ctrl+N: open the manual job-entry dialog on the dashboard. */
  "ps:new-job": undefined;
}

export type AppEventName = keyof AppEventMap;

export function emitAppEvent<K extends AppEventName>(
  name: K,
  ...[detail]: AppEventMap[K] extends undefined ? [] : [AppEventMap[K]]
): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

/** Subscribe to an app event. Returns the unsubscribe function, so a React
 *  effect can simply `return onAppEvent(...)`. */
export function onAppEvent<K extends AppEventName>(
  name: K,
  handler: (detail: AppEventMap[K]) => void,
): () => void {
  const listener = (event: Event) => {
    handler((event as CustomEvent<AppEventMap[K]>).detail);
  };
  window.addEventListener(name, listener);
  return () => window.removeEventListener(name, listener);
}
