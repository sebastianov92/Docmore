# Docmore desktop

An Electron window around your own Docmore server: your session stays in the app, web notifications become native ones with a dock badge, outside links open in the system browser, `docmore://` links open in the window, and the usual shortcuts work (Cmd/Ctrl+Shift+H home, Cmd/Ctrl+Shift+A AI chat, Cmd/Ctrl+, settings, Cmd/Ctrl+[ / ] back and forward).

It is not part of the pnpm workspace on purpose: the server image never installs Electron.

```bash
cd desktop
npm install
npm start            # asks for the server address the first time
npm run dist:mac     # or dist:win / dist:linux -> desktop/dist
```

Signing and notarization are left to whoever builds: set the usual `CSC_*` / `APPLE_*` environment variables for electron-builder.

The web app itself is also installable as a PWA (Chrome, Edge, Safari "Add to Dock") from `/manifest.json`; the desktop shell adds what a PWA cannot: a persistent session per server, native notifications when the window is closed, deep links and menu shortcuts.
