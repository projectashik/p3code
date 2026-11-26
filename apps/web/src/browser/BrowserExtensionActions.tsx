import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { Pin, PinOff, Puzzle, Settings2, Store } from "lucide-react";
import { createElement, useEffect, useState } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "~/components/ui/menu";
import { resolveStorage } from "~/lib/storage";

const CHROME_WEB_STORE_URL = "https://chromewebstore.google.com";

interface BrowserExtensionGuest {
  readonly webContentsId: number;
  readonly partition: string;
}

const useBrowserExtensionGuestStore = create<{
  readonly byTabId: Readonly<Record<string, BrowserExtensionGuest>>;
}>()(() => ({ byTabId: {} }));

export function setBrowserExtensionGuest(tabId: string, guest: BrowserExtensionGuest | null) {
  useBrowserExtensionGuestStore.setState((state) => {
    const byTabId = { ...state.byTabId };
    if (guest) byTabId[tabId] = guest;
    else delete byTabId[tabId];
    return { byTabId };
  });
}

const usePinnedExtensionStore = create<{
  readonly pinnedIds: ReadonlyArray<string>;
  readonly togglePinned: (extensionId: string) => void;
}>()(
  persist(
    (set) => ({
      pinnedIds: [],
      togglePinned: (extensionId) =>
        set((state) => ({
          pinnedIds: state.pinnedIds.includes(extensionId)
            ? state.pinnedIds.filter((id) => id !== extensionId)
            : [...state.pinnedIds, extensionId],
        })),
    }),
    {
      name: "t3code:browser-pinned-extensions:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
    },
  ),
);

interface BrowserActionState {
  readonly actions: ReadonlyArray<{ readonly id: string; readonly title?: string }>;
}

/** The main-world API the desktop preload injects from electron-chrome-extensions. */
interface BrowserActionApi {
  getState(partition: string): Promise<BrowserActionState>;
  addEventListener(name: "update", listener: (state: BrowserActionState) => void): void;
  removeEventListener(name: "update", listener: (state: BrowserActionState) => void): void;
  addObserver(partition: string): void;
  removeObserver(partition: string): void;
  activate(
    partition: string,
    details: {
      eventType: "click";
      extensionId: string;
      tabId: number;
      alignment: string;
      anchorRect: { x: number; y: number; width: number; height: number };
    },
  ): Promise<void>;
}

const browserActionApi = (): BrowserActionApi | null =>
  typeof window === "undefined"
    ? null
    : ((window as unknown as { browserAction?: BrowserActionApi }).browserAction ?? null);

const POPUP_ALIGNMENT = "bottom left";

/** The tab's profile, when it can run extensions: incognito profiles cannot, like Chrome's default. */
function useExtensionGuest(tabId: string) {
  const guest = useBrowserExtensionGuestStore((state) => state.byTabId[tabId]);
  return guest && guest.partition.startsWith("persist:") && browserActionApi() ? guest : null;
}

function useExtensionActions(partition: string | null) {
  const [state, setState] = useState<BrowserActionState>({ actions: [] });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors extension actions the desktop main process owns
  useEffect(() => {
    const api = browserActionApi();
    if (!api || !partition) return;
    // Every persistent profile loads the same extensions, so any profile's update applies here.
    api.addEventListener("update", setState);
    api.addObserver(partition);
    void api.getState(partition).catch(() => undefined);
    return () => {
      api.removeEventListener("update", setState);
      api.removeObserver(partition);
    };
  }, [partition]);
  return state.actions;
}

const extensionIconUrl = (extensionId: string, guest: BrowserExtensionGuest) =>
  `crx://extension-icon/${extensionId}/32/2?${new URLSearchParams({
    tabId: String(guest.webContentsId),
    partition: guest.partition,
  }).toString()}`;

const anchorSelector = (tabId: string) => `[data-browser-extension-anchor="${CSS.escape(tabId)}"]`;

function openExtensionPopup(tabId: string, guest: BrowserExtensionGuest, extensionId: string) {
  const api = browserActionApi();
  const pinned = document.querySelector(
    `${anchorSelector(tabId)} [id="${CSS.escape(extensionId)}"]`,
  );
  const anchor = pinned ?? document.querySelector(anchorSelector(tabId));
  if (!api || !anchor) return;
  const rect = anchor.getBoundingClientRect();
  void api
    .activate(guest.partition, {
      eventType: "click",
      extensionId,
      tabId: guest.webContentsId,
      alignment: POPUP_ALIGNMENT,
      anchorRect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    })
    .catch(() => undefined);
}

/** Pinned extension buttons; also the anchor popups open under when opened from the menu. */
export function BrowserExtensionActions(props: { readonly tabId: string }) {
  const guest = useExtensionGuest(props.tabId);
  const actions = useExtensionActions(guest?.partition ?? null);
  const pinnedIds = usePinnedExtensionStore((state) => state.pinnedIds);
  if (!guest) return null;
  const pinned = actions.filter((action) => pinnedIds.includes(action.id));
  return (
    <div data-browser-extension-anchor={props.tabId} className="flex shrink-0 items-center gap-0.5">
      {pinned.map((action) =>
        // The custom button draws its icon and badge and opens the popup or context menu itself.
        createElement("button", {
          key: action.id,
          is: "browser-action",
          type: "button",
          id: action.id,
          tab: String(guest.webContentsId),
          partition: guest.partition,
          alignment: POPUP_ALIGNMENT,
          "aria-label": action.title,
          className:
            "relative size-7 shrink-0 rounded-md bg-center bg-no-repeat bg-size-[60%] hover:bg-accent sm:size-6 [&_.badge]:absolute [&_.badge]:right-0 [&_.badge]:bottom-0 [&_.badge]:h-3 [&_.badge]:rounded-sm [&_.badge]:px-0.5 [&_.badge]:text-[9px] [&_.badge]:leading-3",
        }),
      )}
    </div>
  );
}

/** The "Extensions" submenu of the browser's more menu. */
export function BrowserExtensionsMenu(props: {
  readonly tabId: string;
  readonly onOpenUrl: (url: string) => void;
}) {
  const { tabId, onOpenUrl } = props;
  const gt = useGT();
  const navigate = useNavigate();
  const guest = useExtensionGuest(tabId);
  const actions = useExtensionActions(guest?.partition ?? null);
  const pinnedIds = usePinnedExtensionStore((state) => state.pinnedIds);
  const togglePinned = usePinnedExtensionStore((state) => state.togglePinned);
  if (!guest) return null;

  return (
    <MenuSub>
      <MenuSubTrigger>
        <Puzzle />
        <T>Extensions</T>
      </MenuSubTrigger>
      <MenuSubPopup>
        {actions.length === 0 ? (
          <MenuItem disabled>
            <T>No extensions installed</T>
          </MenuItem>
        ) : (
          actions.map((action) => {
            const pinned = pinnedIds.includes(action.id);
            return (
              <MenuSub key={action.id}>
                <MenuSubTrigger>
                  <img
                    alt=""
                    src={extensionIconUrl(action.id, guest)}
                    className="size-4 shrink-0"
                  />
                  <span className="min-w-0 flex-1 truncate">{action.title ?? action.id}</span>
                  {pinned ? <Pin className="text-muted-foreground" /> : null}
                </MenuSubTrigger>
                <MenuSubPopup>
                  <MenuItem
                    // The popup opens after the menu closes so the menu doesn't cover it.
                    onClick={() =>
                      requestAnimationFrame(() => openExtensionPopup(tabId, guest, action.id))
                    }
                  >
                    <T>Open</T>
                  </MenuItem>
                  <MenuItem onClick={() => togglePinned(action.id)}>
                    {pinned ? <PinOff /> : <Pin />}
                    {pinned ? gt("Unpin from toolbar") : gt("Pin to toolbar")}
                  </MenuItem>
                </MenuSubPopup>
              </MenuSub>
            );
          })
        )}
        <MenuSeparator />
        <MenuItem onClick={() => onOpenUrl(CHROME_WEB_STORE_URL)}>
          <Store />
          <T>Visit Chrome Web Store</T>
        </MenuItem>
        <MenuItem onClick={() => void navigate({ to: "/settings/browser" })}>
          <Settings2 />
          <T>Manage extensions</T>
        </MenuItem>
      </MenuSubPopup>
    </MenuSub>
  );
}
