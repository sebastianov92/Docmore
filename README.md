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
