import type { DesktopBrowserExtension } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useEffect, useState } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection, SettingsUnavailableGroup } from "./settingsLayout";

export function BrowserExtensionsSettings() {
  const gt = useGT();
  const [extensions, setExtensions] = useState<ReadonlyArray<DesktopBrowserExtension> | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the extensions the desktop main process has loaded
  useEffect(() => {
    let cancelled = false;
    void previewBridge
      ?.listExtensions()
      .then((list) => {
        if (!cancelled) setExtensions(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const remove = async (extension: DesktopBrowserExtension) => {
    if (!previewBridge) return;
    setRemovingId(extension.id);
    const removed = await previewBridge.removeExtension(extension.id).then(
      () => true,
      () => false,
    );
    if (!removed) {
      toastManager.add({ type: "error", title: gt("Unable to remove the extension") });
    }
    setExtensions(await previewBridge.listExtensions().catch(() => extensions));
    setRemovingId(null);
  };

  return (
    <SettingsSection id="browser-extensions" title={gt("Extensions")}>
      <SettingsUnavailableGroup
        message={previewBridge ? undefined : gt("Only available in the desktop app.")}
      >
        {extensions && extensions.length > 0 ? (
          extensions.map((extension) => (
            <SettingsRow
              key={extension.id}
              title={extension.name}
              description={gt("Version {version}", { version: extension.version })}
              control={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={removingId !== null}
                  onClick={() => void remove(extension)}
                >
                  {gt("Remove")}
                </Button>
              }
            />
          ))
        ) : (
          <SettingsRow
            title={gt("No extensions installed")}
            description={gt(
              "Open chromewebstore.google.com in the browser panel and choose Add to Chrome. Extensions work in every profile except incognito.",
            )}
          />
        )}
      </SettingsUnavailableGroup>
    </SettingsSection>
  );
}
