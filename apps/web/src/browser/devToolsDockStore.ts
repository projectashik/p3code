import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { previewBridge } from "~/components/preview/previewBridge";
import { resolveStorage } from "~/lib/storage";

export type DevToolsDockSide = "bottom" | "right";

const MIN_FRACTION = 0.15;
const MAX_FRACTION = 0.85;

const clampDevToolsDockFraction = (value: number) =>
  Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, value));

interface DevToolsDockState {
  readonly side: DevToolsDockSide;
  readonly bottomFraction: number;
  readonly rightFraction: number;
  readonly dockedTabIds: Readonly<Record<string, true>>;
  /** While the divider drags, the native DevTools view hides so the pointer reaches the page. */
  readonly resizing: boolean;
  readonly setSide: (side: DevToolsDockSide) => void;
  readonly setFraction: (fraction: number) => void;
  readonly setResizing: (resizing: boolean) => void;
  readonly setDocked: (tabId: string, docked: boolean) => void;
}

export const useDevToolsDockStore = create<DevToolsDockState>()(
  persist(
    (set) => ({
      side: "bottom",
      bottomFraction: 0.4,
      rightFraction: 0.45,
      dockedTabIds: {},
      resizing: false,
      setSide: (side) => set({ side }),
      setFraction: (fraction) =>
        set((state) =>
          state.side === "bottom"
            ? { bottomFraction: clampDevToolsDockFraction(fraction) }
            : { rightFraction: clampDevToolsDockFraction(fraction) },
        ),
      setResizing: (resizing) => set({ resizing }),
      setDocked: (tabId, docked) =>
        set((state) => {
          if ((state.dockedTabIds[tabId] === true) === docked) return state;
          const dockedTabIds = { ...state.dockedTabIds };
          if (docked) dockedTabIds[tabId] = true;
          else delete dockedTabIds[tabId];
          return { dockedTabIds };
        }),
    }),
    {
      name: "t3code:browser-devtools-dock:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        side: state.side,
        bottomFraction: state.bottomFraction,
        rightFraction: state.rightFraction,
      }),
    },
  ),
);

export const devToolsDockFraction = (state: DevToolsDockState) =>
  state.side === "bottom" ? state.bottomFraction : state.rightFraction;

// Main reports dock changes for tabs whose panel may be unmounted, so listen for the app's lifetime.
previewBridge?.onDevToolsDockChanged((tabId, docked) =>
  useDevToolsDockStore.getState().setDocked(tabId, docked),
);
