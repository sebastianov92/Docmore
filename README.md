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

For development only, `DOCMORE_PREVIEW_EE=true` makes the server report
every enterprise feature as licensed so the upstream enterprise screens
render. Their endpoints are not in this repository, so they fail on use,
and the enterprise client code is licensed for development and testing
only. Never set it on a real instance.

## Run with Docker Compose

```bash
cp .env.docker.example .env
# fill APP_URL, APP_SECRET (openssl rand -hex 32) and POSTGRES_PASSWORD
docker compose up -d --build
```

The app listens on port 3000 (override with `PORT` in `.env`). Attachments are
kept in the `docmore` volume, the database in `db_data`.

### Update

```bash
git pull
docker compose up -d --build
```

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
