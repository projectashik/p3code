import { contextBridge, ipcRenderer } from "electron";

import { EXTENSION_INSTALL_DETAILS_CHANNEL } from "./ipc/channels.ts";

interface InstalledDetails {
  readonly reason: "install" | "update";
  readonly previousVersion?: string;
}

interface InstalledEvent {
  addListener(listener: (details: InstalledDetails) => void): void;
}

/**
 * Electron loads extensions without ever firing `chrome.runtime.onInstalled`, so extensions skip
 * their first-run setup (Bitwarden never turns on its inline autofill menu, for example). This
 * captures the worker's listeners and calls them once main reports an install or update.
 */
// The preload realm has no `location`; the worker's own world checks its origin.
if (process.type === "service-worker") {
  contextBridge.executeInMainWorld({
    func: (installDetails: () => Promise<InstalledDetails | null>) => {
      const root = globalThis as {
        chrome?: { runtime?: { onInstalled?: InstalledEvent } };
        location?: { protocol: string };
      };
      const event = root.chrome?.runtime?.onInstalled;
      if (root.location?.protocol !== "chrome-extension:" || !event) return;
      const listeners: Array<(details: InstalledDetails) => void> = [];
      const addListener = event.addListener.bind(event);
      event.addListener = (listener) => {
        listeners.push(listener);
        addListener(listener);
      };
      // Resolves after the worker's top-level script, which is where listeners get added.
      void installDetails().then((details) => {
        if (!details) return;
        for (const listener of listeners) {
          try {
            listener(details);
          } catch (error) {
            reportError(error);
          }
        }
      });
    },
    args: [() => ipcRenderer.invoke(EXTENSION_INSTALL_DETAILS_CHANNEL)],
  });
}
