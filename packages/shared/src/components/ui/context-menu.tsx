import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./icon";

/** One entry in a context menu. A separator needs nothing but its type. */
export type ContextMenuEntry =
  | { type: "separator" }
  | {
      type?: "item";
      label: string;
      icon?: IconName;
      onSelect: () => void;
      disabled?: boolean;
      /** Renders in the destructive colour and sits apart from the safe actions. */
      destructive?: boolean;
      /** Shows a check mark — for the "current value" entry of a group. */
      checked?: boolean;
      /** Right-aligned hint, e.g. a keyboard shortcut. */
      hint?: string;
    };

interface MenuState<T> {
  x: number;
  y: number;
  payload: T;
}

/**
 * Right-click plumbing for a list: remembers which row was clicked and where
 * the pointer was, so one `<ContextMenu>` instance can serve every row.
 *
 * ```tsx
 * const menu = useContextMenu<PrintJob>();
 * <tr onContextMenu={menu.open(job)} />
 * {menu.state && <ContextMenu {...menu.state} items={build(menu.state.payload)} onClose={menu.close} />}
 * ```
 */
export function useContextMenu<T>() {
  const [state, setState] = useState<MenuState<T> | null>(null);

  const open = useCallback(
    (payload: T) => (e: React.MouseEvent) => {
      // Let the browser menu through when a text field or a link is the target —
      // copy/paste and "open in new tab" are more useful there than our items.
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, a[href], select")) return;
      e.preventDefault();
      e.stopPropagation();
      setState({ x: e.clientX, y: e.clientY, payload });
    },
    [],
  );

  const close = useCallback(() => setState(null), []);

  return { state, open, close };
}

export interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuEntry[];
  onClose: () => void;
  isRtl?: boolean;
  /** Optional heading above the items, usually the row's name. */
  title?: string;
}

const MARGIN = 8;

/**
 * A pointer-anchored menu rendered in a portal.
 *
 * Deliberately not a Radix primitive: the app ships Radix's dropdown but not its
 * context menu, and this needs no new dependency — it is one flat list, closed
 * by Escape, an outside click, a scroll or a resize.
 */
export const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose, isRtl, title }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);

  const selectable = items
    .map((item, i) => (item.type === "separator" || item.disabled ? -1 : i))
    .filter((i) => i >= 0);

  // Place after measuring so the menu never hangs off the viewport. In RTL the
  // pointer anchors the menu's right edge, mirroring the OS behaviour.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    let left = isRtl ? x - width : x;
    let top = y;
    if (left + width > window.innerWidth - MARGIN) left = window.innerWidth - width - MARGIN;
    if (left < MARGIN) left = MARGIN;
    if (top + height > window.innerHeight - MARGIN) top = Math.max(MARGIN, y - height);
    setPos({ left, top });
  }, [x, y, isRtl, items.length]);

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((current) => {
          const at = selectable.indexOf(current);
          const next =
            e.key === "ArrowDown"
              ? selectable[(at + 1 + selectable.length) % selectable.length]
              : selectable[(at - 1 + selectable.length) % selectable.length];
          return next ?? -1;
        });
      }
    };
    // `true` so a scroll inside the jobs table closes the menu too, not just the
    // window scroll — otherwise the menu floats away from its row.
    const onScroll = () => onClose();
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    window.addEventListener("blur", onScroll);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("blur", onScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, items]);

  useEffect(() => {
    if (activeIndex < 0) return;
    const el = ref.current?.querySelector<HTMLButtonElement>(`[data-index="${activeIndex}"]`);
    el?.focus();
  }, [activeIndex]);

  const run = (entry: Extract<ContextMenuEntry, { label: string }>) => {
    onClose();
    entry.onSelect();
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={ref}
      role="menu"
      dir={isRtl ? "rtl" : "ltr"}
      style={{
        position: "fixed",
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        visibility: pos ? "visible" : "hidden",
      }}
      className="z-[100] min-w-[13rem] max-w-[18rem] py-1 rounded-xl border border-border bg-popover text-popover-foreground shadow-lg shadow-black/10 dark:shadow-black/40 animate-in fade-in-0 zoom-in-95"
      onContextMenu={(e) => e.preventDefault()}
    >
      {title && (
        <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground truncate border-b border-border mb-1">
          {title}
        </div>
      )}
      {items.map((entry, i) =>
        entry.type === "separator" ? (
          <div key={`sep-${i}`} role="separator" className="my-1 h-px bg-border" />
        ) : (
          <button
            key={`${entry.label}-${i}`}
            type="button"
            role="menuitem"
            data-index={i}
            disabled={entry.disabled}
            onClick={() => run(entry)}
            className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-start outline-none disabled:opacity-40 disabled:pointer-events-none ${
              entry.destructive
                ? "text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 focus:bg-red-50 dark:focus:bg-red-900/20"
                : "hover:bg-accent focus:bg-accent"
            }`}
          >
            {entry.icon ? (
              <Icon name={entry.icon} className="w-4 h-4 shrink-0" />
            ) : (
              <span className="w-4 h-4 shrink-0" />
            )}
            <span className="flex-1 truncate">{entry.label}</span>
            {entry.checked && <Icon name="check" className="w-3.5 h-3.5 shrink-0 opacity-70" />}
            {entry.hint && <span className="text-xs text-muted-foreground shrink-0">{entry.hint}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
};
