<div align="center">
    <h1><b>Docmore</b></h1>
    <p>
        Self-hosted collaborative wiki and documentation software for the homelab.
        <br />
        A fork of <a href="https://github.com/docmost/docmost"><strong>Docmost</strong></a>.
    </p>
</div>
<br />

Docmore is Docmost with the branding changed and the defaults tuned for a
single self-hosted instance: no upstream telemetry, image built from source,
secrets read from `.env`. Everything else (editor, spaces, permissions,
comments, history, search, imports/exports) is upstream Docmost.

## Built-in features

Docmost keeps some features behind an enterprise license whose server code
is not public. Docmore re-implements the ones a homelab needs under AGPL,
outside the `ee/` directories, so they are always on:

- **API keys**: personal keys under Settings > API keys, every key in the
  workspace under Settings > API management. Read-only or read-and-write,
  expiry up to three years, revocable. Send them as
  `Authorization: Bearer <key>`. An admin-only switch limits key creation
  to admins.
- **Two-factor authentication**: TOTP with any authenticator app plus ten
  single-use backup codes, under Settings > Profile. Admins can require it
  for everyone from Settings > General; members without it set it up at
  their next login. Secrets are encrypted at rest with `APP_SECRET`.
- **Templates**: reusable starting points for pages, workspace-wide or per
  space, with a gallery at /templates, a picker in the page editor and the
  space menu, and a preview before use. Admins manage them; members can
  create templates in their spaces when Settings > General allows it.
- **Word export**: any page exports to .docx from the export dialog, with
  images embedded and page mentions turned into links.
- **Page permissions**: the Share dialog of a page can restrict it to chosen
  people and groups, as viewers or editors. Restrictions apply to the page
  and everything under it; the last editor can never be removed. Space
  admins and anyone who can edit the page manage its access.
- **Single sign-on (OpenID Connect)**: Settings > Security & SSO takes any
  OIDC provider (Authelia, Authentik, Keycloak, Pocket ID, Google, Entra):
  issuer URL, client ID and secret, a callback URL to register with the
  provider. Authorization code flow with PKCE. Accounts are matched by
  email; "Allow signup" creates new members on first sign-in, limited by
  the allowed email domains and honouring pending invitations. "Group sync"
  adds members to the groups named in the provider's `groups` claim.
  "Enforce SSO" turns off password login once a provider is active; the
  last active provider cannot be disabled while enforced. Client secrets
  are encrypted at rest with `APP_SECRET`. The provider is trusted on the
  email it reports, so only connect providers you control. Plain `http`
  issuers are accepted for private networks.
- **Sharing, export and trash controls**: Settings > Security & SSO can
  turn off public sharing for the whole workspace (existing public links
  are removed), turn off export and printing for everyone including admins,
  and set how long trashed pages are kept before they are deleted for good.
  Each space has its own public-sharing and export switches under its
  settings; the workspace rule wins when stricter.
- **Viewer comments and resolved threads**: a space can let read-only
  members comment. Anyone who may comment can resolve a thread or re-open
  it; the inline highlight follows for everyone with the page open.
- **Personal spaces**: once allowed in Settings > General, every member can
  create one space of their own from the workspace menu. The creator is its
  only admin; it cannot be archived.
- **Search inside attachments**: PDF, Word (.docx), .txt, .md and .csv
  files attached to pages are read in the background and indexed in
  Postgres, so the search dialog's "Attachments" type finds them by content
  as well as by file name, with a highlighted snippet. Files from before
  the upgrade are indexed on the next start. Results follow page and space
  access; files over 50 MB and images are not read. Admins can force a
  full re-index with `POST /api/search-attachments/reindex`.
- **Word and PDF import**: the Import dialog of a space takes .docx and
  .pdf files next to Markdown and HTML. Word keeps headings, lists,
  tables, links, bold/italic, quotes and code; embedded images become page
  attachments. PDFs are read page by page (headings and tables where the
  layout allows) and their embedded JPEG and PNG images are placed after
  the text of their page. Scanned PDFs without a text layer are refused
  with a message asking for OCR first; the 30 MB import limit applies.
- **Audit logs**: every action the server already reports (sign-ins,
  members and roles, spaces, groups, pages, sharing, comments, API keys,
  SSO, settings) is written to the `audit` table with who did it, from
  which address and what changed. The workspace owner reads it under
  Settings > Audit logs, filtered by event and date, newest first, with
  the before/after of each change. Rows older than the retention period
  (one year by default, adjustable on that page) are deleted daily.
- **Page verification**: from a page's menu, "Add verification" offers two
  workflows. Recurring verification: named verifiers confirm the page and
  it stays verified for a period, until a date or indefinitely; verifiers
  are notified a week before it expires and when it does. Approval
  workflow: the page moves draft → in approval → approved → obsolete, with
  approvers who approve or return it with a comment. Either way, an edit
  to a verified or approved page flags it (recurring) or sends it back to
  draft (approval), and "Review changes" shows the diff against the last
  verified or returned version. Verified and approved pages open read-only
  until you choose to edit. Settings > Verified pages lists them all.
- **Confluence import**: the Import dialog accepts the HTML export of a
  Confluence space (Server, Data Center or Cloud) as a zip. The page tree
  and order come from the export's index, titles from the page headers,
  and the body is converted: info/note/warning/tip panels become callouts,
  code macros keep their language, expand macros become collapsible
  sections, status lozenges, task lists, page layouts (columns), tables,
  links between pages (turned into mentions or internal links) and
  attachments, including draw.io diagrams with their previews.
- **AI, bring your own provider**: Settings > AI takes API keys for
  OpenAI, Anthropic (Claude) and Google Gemini, the address of an Ollama
  server, or any OpenAI-compatible endpoint (LM Studio, vLLM, LiteLLM,
  OpenRouter). "Test and load models" checks the key and lists that
  provider's models so you pick the writing and embedding models from real
  lists. Keys are encrypted at rest with `APP_SECRET` and never returned.
  With a writing model chosen and "Ask AI in the editor" on, members get
  Ask AI from the selection toolbar: improve, fix, shorten, lengthen,
  simplify, summarize, explain, continue, change tone, translate, or a
  free request, streamed in and then replaced, inserted or copied. The
  upstream `AI_DRIVER` environment variables still work as a fallback.
- **AI search (AI Answers)**: with an embedding model chosen and "AI
  search" on in Settings > AI, every page is split into chunks, embedded
  with that model and stored in Postgres with pgvector (`page_embeddings`).
  The search dialog gets an "AI Answers" switch: a question is matched
  against the chunks of the pages that member may read (space membership,
  page permissions, nothing trashed, archived spaces left out), the
  sources are shown, and the writing model answers from those excerpts
  only, citing them. Edits are re-embedded in the background, trashed
  pages drop out at once, changing the embedding model re-indexes
  everything, and Settings > AI shows the index progress with a
  "Re-index all pages" button. Needs the pgvector extension: the compose
  file uses the `pgvector/pgvector:pg18-trixie` image (plain Postgres 18 plus the
  extension, same data directory). Without it the switch stays off and
  everything else keeps working.
- **AI chat**: with "AI chat" on in Settings > AI, members get a chat at
  /ai (the header link, the prompt on the home page) and beside every page
  (the AI Chat panel, with that page as context). The writing model answers
  with tools: list spaces, search pages (semantic when AI search is on,
  full-text otherwise), read a page, and, unless "Chat is read-only" is
  set, create or update pages. Every tool runs as the member asking, with
  their space membership and page permissions, and the steps are shown
  under each answer. Messages can mention pages with @ and attach PDF,
  Word, text, CSV, Markdown or images (sent to the model as images; the
  model has to support them). "Workspace knowledge only" keeps answers to
  the pages. Chats are private to their author, searchable, renamable, and
  deleting one removes its files.
- **PDF export**: the export dialog of a page offers PDF. The server asks
  Gotenberg (a Chromium in its own container, in the compose file) to print
  the page exactly as the app renders it, read-only and in print layout,
  including images and diagrams; the file is ready in a few seconds and
  downloaded from the dialog, and kept for a day for anyone who may read
  the page. Needs `GOTENBERG_URL`; `PDF_RENDER_BASE_URL` is the address
  Chromium uses to reach the app (the compose file sets both).
- **Announcements**: Settings > Announcements puts a banner over the app
  for members, or over the login and public pages too. One line of text
  with bold, italic, underline and links, a type with its icon, a color,
  an optional start and end, and whether people may dismiss it (a
  dismissed banner comes back if its text changes). One announcement shows
  at a time: saving one that overlaps another lists the clash and offers
  to replace it, which ends the earlier one when the new one starts.
  Archived announcements can be restored while their window is open.
- **Typesense search**: with `SEARCH_DRIVER=typesense` (the compose
  default, with its own `typesense` container) page search tolerates
  typos, matches prefixes and ranks titles above bodies, with the same
  visibility rules as before: space membership, page permissions, nothing
  trashed, archived spaces left out. Every page is indexed on start and
  kept current from the page events; `POST /api/search-index/status` shows
  the index and `POST /api/search-index/reindex` rebuilds it (admins).
  Share and public-space searches, browsing by label or creator, and any
  moment Typesense is unreachable fall back to the Postgres search. Set
  `SEARCH_DRIVER=database` to go without the container.
- **MCP server with OAuth**: Settings > AI > MCP switches on a Model
  Context Protocol server at `/mcp` (Streamable HTTP). Claude, Cursor,
  ChatGPT and other assistants add it as a remote server, register
  themselves, and send the member to a sign-in page here that asks what
  they may do (read, or read and write). Tokens come from the built-in
  OAuth 2.1 authorization server (authorization code with PKCE, rotating
  refresh tokens, revocation, discovery under `/.well-known/`), and every
  tool runs as that member with their space membership and page
  permissions: `get_current_user`, `list_spaces`, `list_pages`,
  `search_pages`, `get_page`, and with write access `create_page` and
  `update_page`. Settings > My Profile lists the connected apps with a
  revoke button. Unless "Sign-in only" is on, an API key also works as the
  bearer token, with its own read or write scope.
- **Bases**: a page can be a database. Type `/base` or `/kanban` in any
  page to embed one, or pick Base or Kanban on an empty page to turn it
  into one. Properties of every kind (text, long text, number, select,
  status, multi-select, date, person, file, page, checkbox, URL, email,
  created/edited stamps and formulas evaluated on the server), table and
  kanban views with filters, sorts and per-user drafts (a board groups by
  a select, a status or a multi-select: a card with several options shows
  under each of them), a row detail
  modal, type conversion with a background job for large tables, realtime
  updates, CSV export and CSV import (map columns to existing or new
  properties; options and people are resolved by name), a calendar view by
  any date property, duplicating a page copies its bases, bases on shared
  pages and published spaces are readable without an account, rows show up
  in workspace search, and the MCP server exposes `list_bases`, `get_base`,
  `list_base_rows`, `create_base_row` and `update_base_row`. The code comes
  from upstream's AGPL base-kan branch, before the feature moved to the
  enterprise tree, adapted to the current schema; the formula engine is
  the AGPL copy in `packages/base-formula-core`.
  Also list and gallery views (grouping, cover image, card size), row
  templates, a structure lock, phone and auto-numbered ID properties
  (v3).
- **Share links** can ask for a password and expire on a date; readers
  unlock once per browser session.
- **Admin content search**: owners and admins can search every space
  from the search dialog; each such search is audited.
- **Audit export**: the audit log downloads as CSV with the same filters.
- **Sitemap and SEO**: `/sitemap.xml` lists indexed public spaces and
  links, `/robots.txt` points to it, and public pages carry description,
  canonical and Open Graph metas.
- **Reading preferences**: per-user page font (default, serif, mono), text
  size and a high contrast mode, from Preferences or the page menu.
- **Page owner**: every page has an editable owner (seeded from the
  creator), shown in the page details.
- **Space visibility**: open (any member joins), closed (listed, join by
  request, space admins approve) or private (hidden); the Spaces page
  lists the spaces you can join.
- **Invite requests**: members ask admins to invite someone; approving
  sends the invitation.
- **People**: `/people` lists everyone with search; each person has a
  profile with the pages they created.
- **Verified domains**: prove a domain with a DNS TXT record; with
  auto-join on, emails on it sign up alone from `/signup`.
- **AI limits per person**: daily request cap and the roles allowed to use
  AI, under Settings > AI.
- **Markdown API and CLI**: `POST /pages/markdown` returns a page body as
  Markdown; `/pages/create` and `/pages/update` take `format: markdown`.
  `tools/docmore-cli/docmore.mjs` wraps the API (login, spaces, pages,
  get, create, update, search, export) with an API key.
- **Bases, second batch**: relation and rollup properties (rows of
  another base, with the reverse side and server-side aggregates),
  sub-items and blocks / blocked-by dependencies, a timeline view, grouping
  and sub-grouping in the table, a chart view (bar, line, pie), linked
  views (`/base` can embed one view of any base, so a page works as a
  dashboard), per-column visibility (everyone, editors, admins), row
  comments, cell history with restore, automations (row created or changed,
  form submitted or a button pressed; conditions as a filter tree; set
  cells, create a row, notify people, call a webhook; a run log), button
  blocks (one that adds a row to a base shown on the same page opens the
  new row to be filled in) and button properties, public forms that create
  rows, and AI
  autofill of a property from a prompt.
- **Links and files**: a bookmark card for any URL (Open Graph, with an
  SSRF guard), PDF export of a whole space or workspace as a ZIP, and a
  browser web clipper (`apps/clipper`, plus `/clip`) that saves a readable
  copy of a page into a space with an API key.
- **People and access**: a guest role that reaches pages only through
  page permissions, a commenter space role, admin scopes (members,
  spaces, audit, settings...), Slack and Teams notification webhooks,
  page and workspace analytics (views and readers per day, optional
  anonymous mode) and a public hostname per space.
- **Integration and identity**: outgoing webhooks with HMAC signatures,
  retries and a delivery log; SIEM export of the audit log to a webhook,
  Splunk HEC or Elasticsearch; SAML 2.0 identity providers next to OIDC;
  SCIM 2.0 provisioning at `/api/scim/v2`; Jira and Google Drive link
  connectors.
- **AI, second batch**: the chat can call tools on outside MCP servers
  (workspace ones set by admins, personal ones per member; read-only tools
  run at once, the rest wait for an Allow in the chat), skills (reusable
  instructions picked with `/` in the chat, in Ask AI, and served as MCP
  prompts), a research mode that plans sub-questions, reads the wiki as
  you and writes a long cited report you can save as a page, and meeting
  notes from an uploaded recording (summary, decisions, action items and a
  stamped transcript appended to the page) with a transcription model
  chosen under Settings > AI.
- **Desktop**: `desktop/` holds an Electron shell around your server
  (native notifications, badge, deep links, shortcuts) for Windows and
  Linux; the web app is also installable as a PWA. On a Mac use the
  native app in `mac/`.
- **Interactive HTML blocks**: `/html` in the editor holds markup, styles
  and scripts and shows them in a sandboxed iframe (scripts yes,
  same-origin no, no network), so the code never reaches the wiki.
- **Suggest mode**: anyone who can read a page proposes a new version
  ("Suggest edits"); editors see the diff, accept (the page takes that
  version) or reject with a note; authors are notified.
- **Bases, third batch**: a feed view (rows as posts), a location property
  (name, address, coordinates, map link), conditional form fields ("show
  when"), and connected properties (a link whose title, status and author
  the integrations fill in and refresh).
- **The assistant proposes, people accept**: by default the chat and the
  scheduled agents never change an existing page directly: they file a
  suggestion (to append, to prepend or a new version) that someone who can
  edit the page accepts or rejects in the same review screen as people's
  suggestions. An addition lands on the page as it is when it is accepted.
  Switch under Settings > AI; outside tools over MCP keep `update_page`
  and get `suggest_page_edit` too.
- **Scheduled agents** (`/ai/agents`): a task in words, a schedule (every
  day, some days of the week, once a month, in a time zone) and a place
  for the result: a notification, a new page each time, or a dated section
  added to a page. An agent works alone with the tools of the chat and the
  permissions of the person who made it, can be kept to one space, only
  reads unless allowed to write, counts against the daily AI limit and is
  paused after five failures in a row. Ready-made tasks: weekly summary of
  changes, pages to verify, daily digest. Two tools came with it for chat,
  agents and MCP: `list_changed_pages` and `list_pages_to_verify`.
- **A model for meetings**: Settings > AI takes a model of its own for the
  live list and the notes of meetings; empty means the writing model.
- **Calendar subscription**: "Subscribe" on a base's calendar view gives a
  private `.ics` link for Apple Calendar, Google Calendar or Outlook. It
  shows what its owner may see, follows the view's filter and date, and
  stops answering when it is turned off, replaced or its owner loses
  access.
- **Import from Notion through its API**: Import pages > "Notion
  (connect)". With the secret of a connection made in Notion, the pages
  shared with it come over with their sub-pages, and each database becomes
  a base with its columns (select and status options with colors and
  groups, dates with time and end, numbers with currency, files, relations
  between imported databases), its rows, the text of each row as a page,
  and its views (table, board, calendar, timeline, gallery, list). The
  cards of a gallery keep their picture: from a files column, or from the
  cover or the first image of each row's page, which are copied into a
  column made for them. A
  database that sits inline in its page is embedded in the imported page
  under its name; a linked view shows the base it is a view of, at its
  first tab, and its views become views of that base in the order of its
  tabs. A row of columns with a narrow side column keeps that shape.
  Notion buttons become buttons: Notion
  does not say what a button does, so each one adds a row to a base its
  page shows (in order) and can be changed with the gear next to it.
  Bookmarks come as link cards. Files Notion hosts are copied; files that
  live elsewhere (a cover from Notion's gallery) are fetched through the
  server's guard for outgoing requests. The report says what did not come over as it
  was (formulas and rollups as values, people as names, view filters,
  forms and charts). This is also how a Notion template is brought in:
  duplicate it into your Notion, share it with the connection, import.
  The list of what to import comes from Notion's search, which can lag a
  few minutes behind a page that was just shared: a page can also be added
  by pasting its link. A secret pasted for one import is used for it and not
  stored. To stop pasting it, whoever manages the workspace keeps one or
  more Notion connections in Settings > Integrations (or ticks "Keep this
  connection for next time" while importing): the secret is tried against
  Notion, stored encrypted and never shown again, and the import dialog
  offers the kept connections to pick from. Only workspace admins see and
  use them; members still paste a secret of their own. For finding out why
  something came over wrong, `POST /api/import/notion/inspect` (admins)
  returns what Notion says about a page: its blocks in outline, its
  databases, their columns and their views, with no rows or text. Written against the
  API reference (version 2026-03-11), tested with a stand-in server and
  tried with a real Notion template (a page with five linked views in
  columns).
- **Live meeting recorder**: "Record meeting" records the microphone with
  a live transcript every 45 seconds; stopping turns the recording into
  notes on the page.
- **Meetings with a live list**: while a meeting runs the language model
  keeps the list of agreements and tasks from what is said, changes an
  entry when the meeting changes its mind (the earlier wording stays
  visible) and calls off what was dropped; what you edit by hand is yours
  and the model leaves it alone. When the meeting ends the model checks the
  list against the whole transcript and writes the summary; tasks land on
  the page as check boxes. Meetings are in person (one microphone) or
  virtual (this side from the microphone, the other side from the call's
  own audio; the Mac app records those), voices are told apart, and
  "People in the meeting" in the page menu gives each voice a name that
  replaces its label everywhere in that meeting's notes, or joins two
  voices that were one person. Notes are written in your language.
- **Managed users**: admins fix a member's name or email, sign them out
  everywhere, send or set a password, or restrict the account to single
  sign-on; the members table shows the last sign-in.
- **Home widgets and shortcuts**: the home page shows the rows assigned to
  you across bases, what is due this week and your shortcuts (pages pinned
  from their menu or links); shortcuts also live in the sidebar, and
  Cmd/Ctrl + / lists the keyboard shortcuts.

For development only, `DOCMORE_PREVIEW_EE=true` makes the server report
every enterprise feature as licensed so the upstream enterprise screens
render. Their endpoints are not in this repository, so they fail on use,
and the enterprise client code is licensed for development and testing
only. Never set it on a real instance.

- **Offline**: mark a page (with everything under it) or a whole space as
  "Available offline" from its menu; the pages you opened lately stay too.
  With no server the app opens from the device: the whole page tree,
  the downloaded pages with their files and comments, bases as last listed
  and a local search. Page text edited offline merges on return (Yjs, no
  conflicts to resolve); new pages, renames, moves, trash, comments, base
  rows, favorites and uploads wait in a queue and go up in order. Whatever
  the server refuses (a page trashed meanwhile, access lost) waits under
  Settings > Offline with the choice to restore and send, keep as a new
  page, retry or discard: nothing is dropped silently. "Offline" means the
  server does not answer, not that the machine has no network, so it also
  covers a homelab behind a VPN, and there is a Work offline switch. In a
  browser a service worker keeps the app shell; signing out wipes the
  device.
- **Mac app**: `mac/` is a native Swift/SwiftUI app that hosts this same
  web client. It keeps the client on disk (downloaded from the server it
  talks to, so both always match) and opens with no server; `/api` goes
  through the app, which signs in through the system browser (OAuth with
  PKCE, the token lives in the Keychain and never reaches the page).
  Several accounts, native tabs, windows and menus, notifications and Dock
  badge, Spotlight for every page you can see (by title, and by text for
  the pages on the device), a quick note from a global
  shortcut (queued when the server is away), an optional lock with Touch
  ID, and meetings: you pick in person (the microphone) or virtual (the
  microphone for your side, the call's own audio for the other side, kept
  as two tracks), it transcribes on the Mac with WhisperKit (also offline,
  no audio leaves the machine), tells the voices apart on the Mac too, and
  a floating panel shows the transcript by speaker and side, lets you name
  a voice as you go and keeps the server's live list of agreements and
  tasks, which you can edit by hand. Build and run notes, the
  automation used by its end-to-end script, and the signing and
  notarization steps are in `mac/README.md`; the meeting engine is the
  Swift package `mac/MeetingKit`.
- **Sync API**: `/api/sync/snapshot`, `/sync/space-pages` and `/sync/pull`
  (what changed after a cursor, one entry per page, body, comment thread or
  base, filtered by the same rules as the sidebar), `/sync/docs` (Yjs in
  batches for pages that are not open), `/sync/pins`, and
  `/sync/client-bundle` (the served web client file by file). Writes accept
  an `Idempotency-Key` header, and pages, base rows, comments and uploads
  accept an id chosen by the device.

## Run with Docker Compose

```bash
cp .env.docker.example .env
# fill APP_URL, APP_SECRET (openssl rand -hex 32) and POSTGRES_PASSWORD
docker compose up -d --build
```

The app listens on port 3000 (override with `PORT` in `.env`). Attachments are
kept in the `docmore` volume, the database in `db_data`. The `gotenberg`
service only prints PDFs; leave it out and everything but PDF export works.

### Update

```bash
git pull
docker compose up -d --build
```

Since the AI search release the database service uses the
`pgvector/pgvector:pg18-trixie` image instead of `postgres:18`. It is the same
Postgres 18 with one extension added, so the existing `db_data` volume is
picked up as is; the update command above pulls it and recreates the
container.

## Development

Requires Node 26 and pnpm 12. Copy `.env.example` to `apps/server/.env`,
start Postgres and Redis, then:

```bash
pnpm install
pnpm dev
```

Upstream development docs: https://docmost.com/docs/self-hosting/development

## Tracking upstream

The git remote `upstream` points at docmost/docmost. Internal package and
import names (`@docmost/*`) are intentionally unchanged so upstream merges
stay small.

```bash
git fetch upstream
git merge upstream/main
```

## License

Docmore core is licensed under the open-source AGPL 3.0 license, same as
Docmost. Enterprise features are available under the Docmost enterprise
license (Enterprise Edition).

All files in the following directories are licensed under the Docmost
Enterprise license defined in `packages/ee/License`.
  - apps/server/src/ee
  - apps/client/src/ee
  - packages/ee

Copyright for the original work belongs to Docmost and its contributors.
