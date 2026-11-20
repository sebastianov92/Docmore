# Docmore Web Clipper

A small browser extension (Manifest V3, Chrome / Edge / Brave / Firefox) that
saves the current page, or the text you selected, as a new page in Docmore.

## Install (unpacked)

- Chrome, Edge, Brave: `chrome://extensions` → Developer mode → Load unpacked → this folder.
- Firefox: `about:debugging` → This Firefox → Load Temporary Add-on → `manifest.json`.

## Set up

Open the extension options and enter your Docmore address, an API key with
**write** scope (Settings → Account → API keys) and the default space. "Load
spaces" checks the key.

## How it works

The popup reads the active tab (`<article>`, else `<main>`, else the body, or
the selection) and posts it to `POST /api/clipper/clip` with the API key as a
bearer token. The server cleans the HTML, prepends "Clipped from <site>" and
creates the page. Without the extension, the bookmarklet in Settings → Account
→ Web clipper sends only the address and the server fetches the page itself.
