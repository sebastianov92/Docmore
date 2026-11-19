# docmore CLI

A single-file command line client for the Docmore HTTP API. Needs Node 20
or newer and nothing else.

```bash
# install: copy or symlink the script somewhere on your PATH
ln -s "$(pwd)/docmore.mjs" /usr/local/bin/docmore

# log in with an API key (Settings > API keys); stored in ~/.config/docmore/config.json
docmore login --url https://wiki.example.com --token <api key>

docmore me
docmore spaces
docmore pages <spaceId>
docmore get <pageId> > page.md
docmore create --space <spaceId> --title "Release notes" --file notes.md
docmore update <pageId> --file notes.md --append
docmore search "deploy checklist" --all
docmore export <pageId> --format markdown --children > page.zip
```

`DOCMORE_URL` and `DOCMORE_TOKEN` in the environment override the config
file, which suits scripts and CI. A read-only key can run everything except
`create` and `update`.
