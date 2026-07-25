/**
 * Service-worker registration for the PWA (web build only).
 *
 * The service worker exists solely to make the web build installable and to
 * serve the app shell offline (see the VitePWA config in vite.config.ts). It is
 * deliberately NOT registered inside Tauri: the same dist/ is packaged into the
 * desktop app, where a worker under `tauri://localhost` is pointless and risks
 * interfering with the IPC/asset loading the app depends on.
 *
 * `registerType: "autoUpdate"` means a new worker precaches the freshly hashed
 * assets and claims the page (skipWaiting + clientsClaim) without a forced
 * reload, so the update lands on the next visit rather than interrupting an
 * in-progress edit.
 */
import { isTauri } from "./platform";

export function registerServiceWorker(): void {
  if (isTauri()) return;
  if (!("serviceWorker" in navigator)) return;

  // Imported lazily so the virtual module is only pulled in on the web path.
  // vite-plugin-pwa provides a no-op stub for this import during `npm run dev`.
  void import("virtual:pwa-register").then(({ registerSW }) => {
    registerSW({ immediate: true });
  });
}
