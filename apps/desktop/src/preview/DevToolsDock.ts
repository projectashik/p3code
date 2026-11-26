import { BrowserWindow, WebContentsView } from "electron";

export interface DevToolsDockBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface DockedDevTools {
  readonly guest: Electron.WebContents;
  /** Replaced after a page crash; the entry itself lives until DevTools close. */
  view: WebContentsView;
  readonly window: BrowserWindow;
  readonly dispose: (notify: boolean) => void;
  /** Bumped by every bounds update, so a slow snapshot can't hide a view shown after it. */
  boundsGeneration: number;
}

/**
 * DevTools for a preview guest, hosted in a native view laid over a slot the renderer positions.
 * A `<webview>` can't host the DevTools frontend (it never connects), so the host is a
 * WebContentsView on the guest's window. Adapted from Orca's browser-guest-devtools-dock.
 */
export class DevToolsDock {
  private readonly docks = new Map<number, DockedDevTools>();
  /** Electron opens nothing for a guest until its previous frontend lets go. */
  private readonly releases = new Map<number, Promise<void>>();

  isDocked(guestId: number): boolean {
    return this.docks.has(guestId);
  }

  focus(guestId: number): void {
    this.docks.get(guestId)?.view.webContents.focus();
  }

  /** Resolves false when the guest has no window to dock into. */
  async open(guest: Electron.WebContents, onClosed: () => void): Promise<boolean> {
    await this.releases.get(guest.id);
    if (guest.isDestroyed()) return false;
    if (this.docks.has(guest.id)) {
      this.focus(guest.id);
      return true;
    }
    const host = guest.hostWebContents;
    const window = host ? BrowserWindow.fromWebContents(host) : null;
    if (!window || window.isDestroyed()) return false;
    // Electron ignores a custom host while its own DevTools window exists.
    if (guest.isDevToolsOpened()) guest.closeDevTools();

    let phase: "live" | "crashed" | "reconnecting" = "live";
    const handleCrash = () => {
      phase = "crashed";
    };
    // A crash detaches the frontend for good. Once the page is back, drop the stale host; its
    // devtools-closed then brings up a fresh one in the same place.
    const handleDomReady = () => {
      const dock = this.docks.get(guest.id);
      if (phase === "crashed" && dock) {
        phase = "reconnecting";
        destroyView(window, dock.view);
      }
    };
    // Fires for DevTools' own close button and for the host being destroyed.
    const handleClosed = () => {
      const dock = this.docks.get(guest.id);
      if (dock && phase === "reconnecting") {
        phase = "live";
        const stale = dock.view;
        dock.view = attachDevToolsView(guest, window);
        dock.view.setBounds(stale.getBounds());
        dock.view.setVisible(stale.getVisible());
        return;
      }
      void this.close(guest.id);
    };
    const handleGuestDestroyed = () => void this.close(guest.id);

    guest.on("render-process-gone", handleCrash);
    guest.on("dom-ready", handleDomReady);
    guest.on("devtools-closed", handleClosed);
    guest.once("destroyed", handleGuestDestroyed);
    this.docks.set(guest.id, {
      guest,
      view: attachDevToolsView(guest, window),
      window,
      dispose: (notify) => {
        if (!guest.isDestroyed()) {
          guest.off("render-process-gone", handleCrash);
          guest.off("dom-ready", handleDomReady);
          guest.off("devtools-closed", handleClosed);
          guest.off("destroyed", handleGuestDestroyed);
        }
        if (notify) onClosed();
      },
      boundsGeneration: 0,
    });
    return true;
  }

  /**
   * Bounds are in the host renderer's CSS pixels; null hides the view. With `snapshot`, the hidden
   * view's last frame comes back so the renderer can paint it while its own UI covers the slot.
   */
  async setBounds(
    guestId: number,
    bounds: DevToolsDockBounds | null,
    snapshot: boolean,
  ): Promise<string | null> {
    const dock = this.docks.get(guestId);
    if (!dock || dock.window.isDestroyed()) return null;
    const generation = ++dock.boundsGeneration;
    if (bounds) {
      const zoom = dock.window.webContents.getZoomFactor();
      dock.view.setBounds({
        x: Math.round(bounds.x * zoom),
        y: Math.round(bounds.y * zoom),
        width: Math.max(1, Math.round(bounds.width * zoom)),
        height: Math.max(1, Math.round(bounds.height * zoom)),
      });
      dock.view.setVisible(true);
      return null;
    }
    const host = dock.view.webContents;
    const image =
      snapshot && !host.isDestroyed() && dock.view.getVisible()
        ? await host.capturePage().catch(() => null)
        : null;
    if (dock.boundsGeneration === generation) dock.view.setVisible(false);
    // JPEG: it only shows briefly under an overlay, and encodes far faster than PNG.
    return image && !image.isEmpty()
      ? `data:image/jpeg;base64,${image.toJPEG(85).toString("base64")}`
      : null;
  }

  /** Resolves once Electron has let go of the host, so DevTools can open again. */
  close(guestId: number, options: { readonly notify?: boolean } = {}): Promise<void> {
    const dock = this.docks.get(guestId);
    if (!dock) return this.releases.get(guestId) ?? Promise.resolve();
    this.docks.delete(guestId);
    dock.dispose(options.notify ?? true);
    const released = waitForRelease(dock.guest, dock.view);
    this.releases.set(guestId, released);
    void released.then(() => {
      if (this.releases.get(guestId) === released) this.releases.delete(guestId);
    });
    destroyView(dock.window, dock.view);
    return released;
  }
}

// Electron detaches the frontend when its host is destroyed and reports it as devtools-closed.
function waitForRelease(guest: Electron.WebContents, view: WebContentsView): Promise<void> {
  const host = view.webContents;
  if (host.isDestroyed() || guest.isDestroyed()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (!guest.isDestroyed()) {
        guest.off("devtools-closed", done);
        guest.off("destroyed", done);
      }
      // Let the rest of the host's destruction run before anyone reopens.
      setImmediate(resolve);
    };
    guest.once("devtools-closed", done);
    guest.once("destroyed", done);
    // A frontend that closed itself already reported devtools-closed; its host may not again.
    host.once("destroyed", done);
  });
}

// Each open needs a fresh host: Electron loads the frontend only into one that never navigated.
function attachDevToolsView(guest: Electron.WebContents, window: BrowserWindow): WebContentsView {
  const view = new WebContentsView();
  view.setVisible(false);
  window.contentView.addChildView(view);
  guest.setDevToolsWebContents(view.webContents);
  guest.openDevTools();
  return view;
}

function destroyView(window: BrowserWindow, view: WebContentsView): void {
  if (!window.isDestroyed()) window.contentView.removeChildView(view);
  // closeDevTools() leaves a custom host attached and frozen; destroying the host detaches it.
  if (!view.webContents.isDestroyed()) view.webContents.close();
}
