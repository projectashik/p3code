import { PanelBottom, PanelRight, SquareArrowOutUpRight, X } from "lucide-react";
import { useGT } from "gt-react";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { previewBridge } from "~/components/preview/previewBridge";
import { Button } from "~/components/ui/button";
import { SharedTooltipTrigger } from "~/components/ui/shared-tooltip";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { devToolsDockFraction, useDevToolsDockStore } from "./devToolsDockStore";

/** Splits the page area with docked DevTools when the tab's DevTools are docked. */
export function BrowserDevToolsDockLayout(props: {
  readonly tabId: string;
  readonly visible: boolean;
  readonly children: ReactNode;
}) {
  const { tabId, visible, children } = props;
  const docked = useDevToolsDockStore((state) => state.dockedTabIds[tabId] === true);
  const side = useDevToolsDockStore((state) => state.side);
  const fraction = useDevToolsDockStore(devToolsDockFraction);
  const containerRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={containerRef}
      className={cn("absolute inset-0 flex", side === "bottom" ? "flex-col" : "flex-row")}
    >
      <div
        className="relative min-h-0 min-w-0"
        style={{ flex: docked ? `${1 - fraction} 1 0%` : "1 1 0%" }}
      >
        {children}
      </div>
      {docked ? (
        <>
          <DevToolsDockDivider containerRef={containerRef} />
          <DevToolsDockPanel tabId={tabId} visible={visible} fraction={fraction} />
        </>
      ) : null}
    </div>
  );
}

function DevToolsDockDivider(props: { readonly containerRef: RefObject<HTMLDivElement | null> }) {
  const gt = useGT();
  const side = useDevToolsDockStore((state) => state.side);
  const resizing = useDevToolsDockStore((state) => state.resizing);
  const setFraction = useDevToolsDockStore((state) => state.setFraction);
  const setResizing = useDevToolsDockStore((state) => state.setResizing);

  const onPointerDown = (event: ReactPointerEvent) => {
    const container = props.containerRef.current;
    if (!container || event.button !== 0) return;
    event.preventDefault();
    setResizing(true);
    const onMove = (move: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      setFraction(
        side === "bottom"
          ? (rect.bottom - move.clientY) / rect.height
          : (rect.right - move.clientX) / rect.width,
      );
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setResizing(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const cursor = side === "bottom" ? "cursor-row-resize" : "cursor-col-resize";
  return (
    <>
      <div
        role="separator"
        aria-label={gt("Resize DevTools")}
        aria-orientation={side === "bottom" ? "horizontal" : "vertical"}
        className={cn(
          "group relative z-10 shrink-0 touch-none select-none bg-border",
          side === "bottom" ? "h-px" : "w-px",
          cursor,
        )}
        onPointerDown={onPointerDown}
      >
        <span
          aria-hidden
          className={cn(
            "absolute transition-colors duration-150 group-hover:bg-primary/40",
            side === "bottom" ? "inset-x-0 -inset-y-1" : "-inset-x-1 inset-y-0",
          )}
        />
      </div>
      {/* The page webview sits in its own layer and would swallow the drag without this shield. */}
      {resizing
        ? createPortal(<div className={cn("fixed inset-0 z-[9999]", cursor)} />, document.body)
        : null}
    </>
  );
}

function DevToolsDockPanel(props: {
  readonly tabId: string;
  readonly visible: boolean;
  readonly fraction: number;
}) {
  const { tabId, visible, fraction } = props;
  const gt = useGT();
  const side = useDevToolsDockStore((state) => state.side);
  const setSide = useDevToolsDockStore((state) => state.setSide);
  const [placeholder, setPlaceholder] = useState<HTMLDivElement | null>(null);
  const snapshot = useDevToolsDockBounds(tabId, placeholder, visible);
  const nextSide = side === "bottom" ? "right" : "bottom";

  return (
    <section
      aria-label={gt("DevTools")}
      className="flex min-h-0 min-w-0 flex-col bg-background"
      style={{ flex: `${fraction} 1 0%` }}
    >
      <div className="flex h-7 shrink-0 items-center gap-0.5 border-b border-border px-2">
        <span className="mr-auto truncate text-xs text-muted-foreground">{gt("DevTools")}</span>
        <DockAction
          label={nextSide === "right" ? gt("Dock to right") : gt("Dock to bottom")}
          onClick={() => setSide(nextSide)}
        >
          {nextSide === "right" ? <PanelRight /> : <PanelBottom />}
        </DockAction>
        <DockAction
          label={gt("Open in separate window")}
          onClick={() => void previewBridge?.openDevTools(tabId, { detach: true })}
        >
          <SquareArrowOutUpRight />
        </DockAction>
        <DockAction
          label={gt("Close DevTools")}
          onClick={() => void previewBridge?.closeDevTools(tabId)}
        >
          <X />
        </DockAction>
      </div>
      <div ref={setPlaceholder} className="relative min-h-0 flex-1 overflow-hidden">
        {snapshot ? (
          <img
            alt=""
            src={snapshot.url}
            className="pointer-events-none absolute top-0 left-0 max-w-none"
            style={{ width: snapshot.width, height: snapshot.height }}
          />
        ) : null}
      </div>
    </section>
  );
}

function DockAction(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <SharedTooltipTrigger
      render={
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          aria-label={props.label}
          onClick={props.onClick}
        />
      }
      label={props.label}
    >
      {props.children}
    </SharedTooltipTrigger>
  );
}

// Floating UI that would sit under the native DevTools view, which paints above all HTML.
const OVERLAY_SELECTOR = '[data-slot$="-popup"], [data-slot$="-backdrop"]';

function isCoveredByOverlay(placeholder: HTMLElement, rect: DOMRect): boolean {
  for (const element of document.querySelectorAll(OVERLAY_SELECTOR)) {
    if (placeholder.contains(element)) continue;
    const other = element.getBoundingClientRect();
    if (
      other.width > 0 &&
      other.height > 0 &&
      other.left < rect.right &&
      other.right > rect.left &&
      other.top < rect.bottom &&
      other.bottom > rect.top
    ) {
      return true;
    }
  }
  return false;
}

interface DevToolsDockSnapshot {
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

/**
 * Keeps the native DevTools view over `placeholder`. While app UI covers that area or the divider
 * drags, the view hides and its last frame is painted in the placeholder instead.
 */
function useDevToolsDockBounds(
  tabId: string,
  placeholder: HTMLElement | null,
  visible: boolean,
): DevToolsDockSnapshot | null {
  const [snapshot, setSnapshot] = useState<DevToolsDockSnapshot | null>(null);
  const resizing = useDevToolsDockStore((state) => state.resizing);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- positions the native DevTools view, which lives outside the DOM, over its placeholder
  useEffect(() => {
    if (!placeholder || !previewBridge) return;
    const bridge = previewBridge;
    let applied = "";
    let frame: number | null = null;
    const sync = () => {
      frame = null;
      const rect = placeholder.getBoundingClientRect();
      const shown = visible && rect.width > 0 && rect.height > 0 && placeholder.checkVisibility();
      const covered = shown && (resizing || isCoveredByOverlay(placeholder, rect));
      const next = !shown
        ? "hidden"
        : covered
          ? "covered"
          : `${rect.left}|${rect.top}|${rect.width}|${rect.height}|${window.devicePixelRatio}`;
      if (next === applied) return;
      applied = next;
      if (!shown || covered) {
        void bridge
          .setDevToolsDockBounds(tabId, null, covered)
          .then((url) => {
            if (url && applied === "covered") {
              setSnapshot({ url, width: rect.width, height: rect.height });
            }
          })
          .catch(() => undefined);
        return;
      }
      setSnapshot(null);
      void bridge
        .setDevToolsDockBounds(tabId, {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        })
        .catch(() => undefined);
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(sync);
    };
    const observed: Element[] = [placeholder];
    const panel = placeholder.closest('[data-preview-panel-mode="inline"]');
    if (panel) observed.push(panel);
    observed.push(...document.querySelectorAll('[data-slot="sidebar-gap"]'));
    const stopObserving = observeResize(observed, schedule);
    // Popups mount and unmount through portals on body.
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { childList: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    sync();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      stopObserving();
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      void bridge.setDevToolsDockBounds(tabId, null).catch(() => undefined);
    };
  }, [tabId, placeholder, visible, resizing]);

  return snapshot;
}
