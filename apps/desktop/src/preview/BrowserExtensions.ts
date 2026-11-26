// @effect-diagnostics nodeBuiltinImport:off - The extension libraries take plain paths outside any Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { app, BrowserWindow, dialog, type Session } from "electron";
import type { ElectronChromeExtensions } from "electron-chrome-extensions";

import { EXTENSION_INSTALL_DETAILS_CHANNEL } from "../ipc/channels.ts";

export interface BrowserExtensionSummary {
  readonly id: string;
  readonly name: string;
  readonly version: string;
}

// Loaded on first use: the libraries touch Electron APIs at import time, which unit-test mocks lack.
const loadExtensionsLibrary = () => import("electron-chrome-extensions");
const loadWebStoreLibrary = () => import("electron-chrome-web-store");

const extensionsBySession = new Map<Session, ElectronChromeExtensions>();
const enabling = new Map<Session, Promise<void>>();
const iconSessions = new WeakSet<Session>();

// Every persistent browser profile loads the same installs, like Chrome's per-user extensions.
const extensionsPath = () => NodePath.join(app.getPath("userData"), "BrowserExtensions");

const confirmInstall = async (details: {
  readonly localizedName: string;
  readonly browserWindow?: BrowserWindow;
}) => {
  const parent = details.browserWindow ?? BrowserWindow.getFocusedWindow();
  const options = {
    type: "question" as const,
    buttons: ["Add extension", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    message: `Add "${details.localizedName}"?`,
    detail: "It will be available in every browser profile except incognito.",
  };
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return { action: response === 0 ? ("allow" as const) : ("deny" as const) };
};

/** Tabs opened by `chrome.tabs.create` (options and welcome pages) get their own window. */
const openExtensionTab = async (
  session: Session,
  url: string | undefined,
): Promise<[Electron.WebContents, BrowserWindow]> => {
  const window = new BrowserWindow({
    width: 1100,
    height: 800,
    webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  extensionsBySession.get(session)?.addTab(window.webContents, window);
  if (url) await window.webContents.loadURL(url);
  return [window.webContents, window];
};

/** `chrome.windows.create` (Bitwarden's passkey picker, extension popouts) opens a real window. */
const openExtensionWindow = async (
  session: Session,
  details: {
    readonly url?: string | ReadonlyArray<string> | undefined;
    readonly width?: number | undefined;
    readonly height?: number | undefined;
    readonly left?: number | undefined;
    readonly top?: number | undefined;
    readonly focused?: boolean | undefined;
  },
): Promise<BrowserWindow> => {
  const window = new BrowserWindow({
    width: details.width ?? 500,
    height: details.height ?? 700,
    ...(details.left === undefined ? {} : { x: details.left }),
    ...(details.top === undefined ? {} : { y: details.top }),
    show: details.focused !== false,
    webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  extensionsBySession.get(session)?.addTab(window.webContents, window);
  const [url] = typeof details.url === "string" ? [details.url] : (details.url ?? []);
  if (url) await window.webContents.loadURL(url);
  return window;
};

const shareLoadedExtensions = (session: Session) => {
  // The web store installs into the session it was used from; other profiles pick it up here.
  session.extensions.on("extension-loaded", (_event, extension) => {
    for (const other of extensionsBySession.keys()) {
      if (other !== session && !other.extensions.getExtension(extension.id)) {
        void other.extensions.loadExtension(extension.path).catch(() => undefined);
      }
    }
  });
};

// Profiles keep separate extension storage, so each profile gets its own install event.
const installRecordsPath = () =>
  NodePath.join(app.getPath("userData"), "BrowserExtensionInstalls.json");
let installRecords: Promise<Record<string, string>> | null = null;
const readInstallRecords = () =>
  (installRecords ??= NodeFSP.readFile(installRecordsPath(), "utf8")
    .then((text) => JSON.parse(text) as Record<string, string>)
    .catch((): Record<string, string> => ({})));

const installDetailsFor = async (session: Session, extensionId: string) => {
  const extension = session.extensions.getExtension(extensionId);
  if (!extension) return null;
  const records = await readInstallRecords();
  const key = `${session.storagePath ?? ""}|${extensionId}`;
  const previousVersion = records[key];
  if (previousVersion === extension.version) return null;
  records[key] = extension.version;
  await NodeFSP.writeFile(installRecordsPath(), JSON.stringify(records)).catch(() => undefined);
  return previousVersion === undefined
    ? { reason: "install" as const }
    : { reason: "update" as const, previousVersion };
};

const answerInstallDetails = (session: Session) => {
  const handled = new WeakSet<Electron.ServiceWorkerMain>();
  session.serviceWorkers.on("running-status-changed", ({ runningStatus, versionId }) => {
    if (runningStatus !== "starting") return;
    const worker = session.serviceWorkers.getWorkerFromVersionID(versionId);
    if (!worker || handled.has(worker) || !worker.scope.startsWith("chrome-extension://")) return;
    handled.add(worker);
    const extensionId = new URL(worker.scope).host;
    worker.ipc.handle(EXTENSION_INSTALL_DETAILS_CHANNEL, () =>
      installDetailsFor(session, extensionId),
    );
  });
};

const enable = async (session: Session) => {
  const [{ ElectronChromeExtensions }, { installChromeWebStore }] = await Promise.all([
    loadExtensionsLibrary(),
    loadWebStoreLibrary(),
  ]);
  const extensions = new ElectronChromeExtensions({
    session,
    createTab: (details) => openExtensionTab(session, details.url),
    createWindow: (details) => openExtensionWindow(session, details),
    removeWindow: (window) => {
      if (!window.isDestroyed()) window.close();
    },
  });
  extensionsBySession.set(session, extensions);
  shareLoadedExtensions(session);
  answerInstallDetails(session);
  session.registerPreloadScript({
    id: "t3code-extension-install-events",
    type: "service-worker",
    filePath: NodePath.join(__dirname, "extension-worker-preload.cjs"),
  });
  await installChromeWebStore({
    session,
    extensionsPath: extensionsPath(),
    beforeInstall: confirmInstall,
  });
};

export function enableBrowserExtensions(session: Session): Promise<void> {
  let pending = enabling.get(session);
  if (!pending) {
    pending = enable(session);
    enabling.set(session, pending);
  }
  return pending;
}

/** Makes a preview guest visible to `chrome.tabs` and extension actions. */
export function trackBrowserExtensionTab(guest: Electron.WebContents, window: BrowserWindow): void {
  void enabling
    .get(guest.session)
    ?.then(() => {
      if (!guest.isDestroyed()) extensionsBySession.get(guest.session)?.addTab(guest, window);
    })
    .catch(() => undefined);
}

export function selectBrowserExtensionTab(guest: Electron.WebContents): void {
  extensionsBySession.get(guest.session)?.selectTab(guest);
}

/** Lets the app renderer show extension icons through `<browser-action-list>`. */
export function allowBrowserExtensionIcons(session: Session): void {
  if (iconSessions.has(session)) return;
  iconSessions.add(session);
  void loadExtensionsLibrary()
    .then(({ ElectronChromeExtensions }) => ElectronChromeExtensions.handleCRXProtocol(session))
    .catch(() => undefined);
}

export function listBrowserExtensions(): ReadonlyArray<BrowserExtensionSummary> {
  const byId = new Map<string, BrowserExtensionSummary>();
  for (const session of extensionsBySession.keys()) {
    for (const extension of session.extensions.getAllExtensions()) {
      byId.set(extension.id, {
        id: extension.id,
        name: extension.name,
        version: extension.version,
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function removeBrowserExtension(extensionId: string): Promise<void> {
  const [first, ...rest] = extensionsBySession.keys();
  if (!first) return;
  const { uninstallExtension } = await loadWebStoreLibrary();
  // Deletes the files once and unloads the extension from the first session.
  await uninstallExtension(extensionId, { session: first, extensionsPath: extensionsPath() });
  for (const session of rest) {
    if (session.extensions.getExtension(extensionId))
      session.extensions.removeExtension(extensionId);
  }
}
