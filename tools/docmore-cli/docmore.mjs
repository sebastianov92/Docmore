#!/usr/bin/env node
// Docmore CLI: a thin wrapper over the HTTP API. No dependencies, Node 20+.
//
//   docmore login --url https://wiki.example.com --token <api key>
//   docmore me
//   docmore spaces
//   docmore pages <spaceId>
//   docmore get <pageId>                 # Markdown to stdout
//   docmore create --space <id> --title "T" [--parent <id>] [--file page.md]
//   docmore update <pageId> [--file page.md] [--append|--prepend] [--title "T"]
//   docmore search "<query>" [--space <id>]
//   docmore export <pageId> [--format markdown|html] [--children] > out.zip
//
// Config: ~/.config/docmore/config.json {url, token}, or DOCMORE_URL and
// DOCMORE_TOKEN in the environment (environment wins).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "docmore");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

function readConfig() {
  let file = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      file = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    } catch {
      file = {};
    }
  }
  return {
    url: process.env.DOCMORE_URL || file.url,
    token: process.env.DOCMORE_TOKEN || file.token,
  };
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

function die(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function api(path, body, { raw = false } = {}) {
  const { url, token } = readConfig();
  if (!url || !token) die("Not logged in. Run: docmore login --url <url> --token <api key>");
  const res = await fetch(`${url.replace(/\/$/, "")}/api${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: raw ? "*/*" : "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      detail = j?.message ? `: ${Array.isArray(j.message) ? j.message.join("; ") : j.message}` : "";
    } catch {
      // not json
    }
    die(`HTTP ${res.status} on ${path}${detail}`);
  }
  if (raw) return res;
  const json = await res.json();
  return json && typeof json === "object" && "data" in json ? json.data : json;
}

function readInput(flags) {
  if (flags.file) return readFileSync(String(flags.file), "utf8");
  if (!process.stdin.isTTY) return readFileSync(0, "utf8");
  return "";
}

function table(rows, columns) {
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (vals) => vals.map((v, i) => String(v ?? "").padEnd(widths[i])).join("  ");
  process.stdout.write(line(columns) + "\n");
  for (const r of rows) process.stdout.write(line(columns.map((c) => r[c])) + "\n");
}

const commands = {
  async login({ flags }) {
    if (!flags.url || !flags.token) die("Usage: docmore login --url <url> --token <api key>");
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify({ url: String(flags.url), token: String(flags.token) }, null, 2), { mode: 0o600 });
    const me = await api("/users/me");
    process.stdout.write(`Logged in as ${me.user.name} <${me.user.email}> on ${me.workspace.name}\n`);
  },
  async me() {
    const me = await api("/users/me");
    process.stdout.write(JSON.stringify({ user: { id: me.user.id, name: me.user.name, email: me.user.email, role: me.user.role }, workspace: { id: me.workspace.id, name: me.workspace.name } }, null, 2) + "\n");
  },
  async spaces({ flags }) {
    const result = await api("/spaces", { limit: Number(flags.limit || 100), query: flags.query });
    if (flags.json) return process.stdout.write(JSON.stringify(result.items, null, 2) + "\n");
    table(result.items.map((s) => ({ id: s.id, slug: s.slug, name: s.name, role: s.membership?.role ?? "" })), ["id", "slug", "name", "role"]);
  },
  async pages({ positional, flags }) {
    const spaceId = positional[0] || flags.space;
    if (!spaceId) die("Usage: docmore pages <spaceId> [--parent <pageId>]");
    const result = await api("/pages/sidebar-pages", { spaceId, pageId: flags.parent, limit: Number(flags.limit || 250) });
    const items = result.items ?? result;
    if (flags.json) return process.stdout.write(JSON.stringify(items, null, 2) + "\n");
    table(items.map((p) => ({ id: p.id, slugId: p.slugId, title: p.title || "(untitled)", children: p.hasChildren ? "yes" : "" })), ["id", "slugId", "title", "children"]);
  },
  async get({ positional, flags }) {
    const pageId = positional[0];
    if (!pageId) die("Usage: docmore get <pageId> [--json]");
    const page = await api("/pages/markdown", { pageId });
    if (flags.json) return process.stdout.write(JSON.stringify(page, null, 2) + "\n");
    process.stdout.write(page.markdown.endsWith("\n") ? page.markdown : page.markdown + "\n");
  },
  async create({ flags }) {
    if (!flags.space || !flags.title) die("Usage: docmore create --space <spaceId> --title <title> [--parent <pageId>] [--file page.md]");
    const markdown = readInput(flags);
    const page = await api("/pages/create", {
      spaceId: String(flags.space),
      title: String(flags.title),
      parentPageId: flags.parent ? String(flags.parent) : undefined,
      ...(markdown ? { content: markdown, format: "markdown" } : {}),
    });
    process.stdout.write(`${page.id}\t${page.slugId}\t${page.title}\n`);
  },
  async update({ positional, flags }) {
    const pageId = positional[0];
    if (!pageId) die("Usage: docmore update <pageId> [--file page.md] [--append|--prepend] [--title <title>]");
    const markdown = readInput(flags);
    const body = { pageId };
    if (flags.title) body.title = String(flags.title);
    if (markdown) {
      body.content = markdown;
      body.format = "markdown";
      body.operation = flags.append ? "append" : flags.prepend ? "prepend" : "replace";
    }
    if (!flags.title && !markdown) die("Nothing to update: pass --title or Markdown via --file or stdin");
    const page = await api("/pages/update", body);
    process.stdout.write(`${page.id}\t${page.slugId}\t${page.title}\n`);
  },
  async search({ positional, flags }) {
    const query = positional.join(" ");
    if (!query) die('Usage: docmore search "<query>" [--space <spaceId>] [--all]');
    const result = await api("/search", { query, spaceId: flags.space ? String(flags.space) : undefined, allSpaces: Boolean(flags.all), limit: Number(flags.limit || 20) });
    const items = result.items ?? result;
    if (flags.json) return process.stdout.write(JSON.stringify(items, null, 2) + "\n");
    table(items.map((p) => ({ id: p.id, title: p.title || "(untitled)", space: p.space?.slug ?? "", type: p.isBaseRow ? "row" : "page" })), ["id", "title", "space", "type"]);
  },
  async export({ positional, flags }) {
    const pageId = positional[0];
    if (!pageId) die("Usage: docmore export <pageId> [--format markdown|html] [--children] > out");
    const res = await api("/pages/export", { pageId, format: String(flags.format || "markdown"), includeChildren: Boolean(flags.children) }, { raw: true });
    const buf = Buffer.from(await res.arrayBuffer());
    process.stdout.write(buf);
  },
};

const { positional, flags } = parseArgs(process.argv.slice(2));
const name = positional.shift();
if (!name || flags.help || !commands[name]) {
  process.stdout.write(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 15).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n");
  process.exit(name && !commands[name] ? 1 : 0);
}
commands[name]({ positional, flags }).catch((err) => die(err?.message ?? String(err)));
