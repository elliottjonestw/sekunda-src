import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/**
 * The built app's Content-Security-Policy, injected into `dist/index.html`.
 *
 * It exists because of where the web build runs. `github.io` is a public origin
 * shared with every other project site, and the app keeps the OpenAI key, the
 * iCloud app-specific password and the refresh token in `localStorage` there —
 * so any script execution on that origin is a total compromise of the account
 * and of the user's Apple credentials. GitHub Pages cannot set response
 * headers, which leaves a `<meta http-equiv>` as the only way to say any of
 * this.
 *
 * Injected at BUILD time rather than written into index.html, for two reasons:
 * the dev server needs `eval` and an HMR websocket that a shipped build must
 * not allow, and `connect-src` has to name whichever API this particular build
 * was pointed at (`VITE_API_URL`), which a static file cannot know.
 *
 * Three directives are load-bearing and easy to break:
 *
 *  - **`'wasm-unsafe-eval'` in `script-src`.** `hash-wasm` inlines its wasm as
 *    base64 and compiles it at runtime, so without this every sign-in dies at
 *    the argon2id step — and it dies inside the KDF, which presents as "wrong
 *    password" rather than as a CSP error.
 *  - **`blob:` in `img-src`.** Note images arrive as authenticated bytes and
 *    render through `URL.createObjectURL`, because an `<img src>` cannot carry
 *    a Bearer header. `data:` is there for person photos.
 *  - **`ipc:` and `http://ipc.localhost` in `connect-src`.** The same
 *    `dist/index.html` is what Tauri packages, and that is how the webview
 *    talks to Rust. Omitting them ships a desktop build where every plugin call
 *    — HTTP, notifications, the file dialogs — silently fails.
 *
 * `frame-ancestors` is deliberately absent: it is ignored when delivered in a
 * meta tag, so writing it would be decoration. Framing protection on the
 * published site would need a header, which Pages cannot send.
 */
function contentSecurityPolicy(apiUrl: string): string {
  const connect = [
    "'self'",
    apiUrl,
    // Called straight from the browser on the web build; all three send CORS
    // headers, which is exactly why they need no Worker proxy (Yahoo and
    // iCloud, which don't, go through the Worker and so are covered by
    // `apiUrl`). Inside Tauri these go through plugin-http instead, which is
    // not subject to CSP at all — see src-tauri/capabilities/default.json.
    "https://api.openai.com",
    "https://api.open-meteo.com",
    "https://geocoding-api.open-meteo.com",
    "https://air-quality-api.open-meteo.com",
    // Tauri's IPC bridge — see above.
    "ipc:",
    "http://ipc.localhost",
  ];

  return [
    "default-src 'self'",
    // `challenges.cloudflare.com` is Cloudflare Turnstile: `api.js` loads from
    // there (script-src) and it draws the challenge in an iframe from the same
    // host (frame-src). Web-only — the widget never renders inside Tauri, but
    // the same dist/index.html is packaged, so these directives just permit an
    // asset the desktop build never fetches.
    "script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    // Tailwind compiles to a stylesheet, but React writes inline style
    // attributes in several places.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // Speech playback builds an object URL from the TTS response.
    "media-src 'self' blob:",
    `connect-src ${connect.join(" ")}`,
    "object-src 'none'",
    // The web build installs as a PWA: the manifest and the generated service
    // worker are both same-origin. Stated explicitly so a future tightening of
    // `default-src`/`script-src` can't silently break install/registration.
    // Both are inert inside Tauri — the SW is only registered when !isTauri().
    "manifest-src 'self'",
    "worker-src 'self'",
    "base-uri 'self'",
    // Nothing in this app posts a form anywhere. Saying so closes the classic
    // "inject a form, exfiltrate the DOM" path that survives a strict
    // script-src.
    "form-action 'none'",
  ].join("; ");
}

function cspPlugin(apiUrl: string): Plugin {
  return {
    name: "sekunda-csp",
    // `apply: "build"` keeps it out of `npm run dev`, where Vite needs eval and
    // a websocket. The cost is that a violation only appears in a built bundle,
    // which is why `npx vite build` plus serving `dist/` belongs in the
    // verification routine rather than being an afterthought.
    apply: "build",
    transformIndexHtml(html) {
      return html.replace(
        "<head>",
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(apiUrl)}" />`,
      );
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => {
  // The same fallback lib/api.ts uses, so a build with no VITE_API_URL set
  // still gets a policy matching where it will actually connect.
  const apiUrl =
    loadEnv(mode, process.cwd(), "").VITE_API_URL ?? "http://localhost:8787";

  return {
    plugins: [
      react(),
      // Makes the WEB build installable as a PWA (Android/iOS "Add to Home
      // Screen"). Emits a service worker + web-app manifest into dist/.
      //
      // The same dist/ is what Tauri packages, so both are written to be inert
      // on the desktop: the SW is registered only when `!isTauri()` (see
      // src/lib/registerSW.ts, wired from main.tsx), and the manifest link is
      // harmless in a webview that ignores it.
      //
      // Base-path safe: the plugin applies Vite's resolved `base` (the web
      // deploy passes `--base=/sekunda-web/`) to the SW scope and the
      // navigate-fallback, and the manifest's start_url/scope/icons are given
      // relative so they resolve against wherever the manifest is served.
      VitePWA({
        // We register the SW ourselves so it can be gated on `!isTauri()`.
        injectRegister: false,
        // New assets are hashed, so a new SW precaches them and takes over
        // (skipWaiting + clientsClaim) without forcing a mid-session reload —
        // the fresh bundle loads on the next visit. Avoids clobbering
        // in-progress note edits (see the note editor's debounced writes).
        registerType: "autoUpdate",
        workbox: {
          globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest,woff2}"],
          // Serve the app shell for any navigation offline. This is the SPA
          // fallback the deploy's 404.html provides online; the plugin applies
          // `base`, so it resolves to `<base>index.html`.
          navigateFallback: "index.html",
          // The SW touches ONLY same-origin static assets. Every API call
          // (Worker, OpenAI, iCloud relay, Open-Meteo, Turnstile) is left to
          // the network and the app's own offline layer (networkFirst /
          // lib/cache.ts). Critically, this keeps authed responses — which can
          // carry the OpenAI key, iCloud password and refresh token's context
          // on a shared github.io origin — out of Cache Storage.
          navigateFallbackDenylist: [/^\/v1\//],
        },
        manifest: {
          name: "Sekunda",
          short_name: "Sekunda",
          description:
            "Calendar, reminders, notes, diary and people — with an optional AI assistant.",
          // Relative so they resolve against the manifest's own URL, immune to
          // the deploy's base path.
          start_url: ".",
          scope: ".",
          display: "standalone",
          background_color: "#ffffff",
          theme_color: "#2563eb",
          icons: [
            { src: "icon-192.png", sizes: "192x192", type: "image/png" },
            { src: "icon-512.png", sizes: "512x512", type: "image/png" },
            {
              src: "icon-maskable-512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },
      }),
      cspPlugin(apiUrl),
    ],

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        // 3. tell Vite to ignore watching `src-tauri`
        ignored: ["**/src-tauri/**"],
      },
    },
  };
});
