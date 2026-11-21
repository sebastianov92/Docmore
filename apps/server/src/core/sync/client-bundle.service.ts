import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join, relative, sep } from 'node:path';

export type ClientBundleFile = { path: string; size: number; hash: string };
export type ClientBundleManifest = {
  // changes whenever any file of the web client changes
  hash: string;
  version: string;
  files: ClientBundleFile[];
};

// The web client this server serves, described file by file. The desktop app
// downloads it once (each file from its usual URL) and then opens with no
// server, always on the same client version as the server it talks to.
@Injectable()
export class ClientBundleService {
  private readonly logger = new Logger(ClientBundleService.name);
  private manifest: ClientBundleManifest | null = null;
  private building: Promise<ClientBundleManifest> | null = null;

  private clientDistPath(): string {
    // dist/core/sync -> apps/client/dist
    return join(__dirname, '..', '..', '..', '..', 'client', 'dist');
  }

  serverVersion(): string {
    try {
      const pkg = JSON.parse(fs.readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
      return String(pkg.version ?? '0.0.0');
    } catch {
      return '0.0.0';
    }
  }

  async getManifest(): Promise<ClientBundleManifest> {
    if (this.manifest) return this.manifest;
    if (!this.building) {
      this.building = this.build()
        .then((manifest) => {
          this.manifest = manifest;
          return manifest;
        })
        .finally(() => {
          this.building = null;
        });
    }
    return this.building;
  }

  private async build(): Promise<ClientBundleManifest> {
    const root = this.clientDistPath();
    const files: ClientBundleFile[] = [];
    if (fs.existsSync(root)) {
      for (const absolute of walk(root)) {
        const path = relative(root, absolute).split(sep).join('/');
        // the untouched copy of index.html, only the server needs it
        if (path === 'index-template.html') continue;
        const data = await fs.promises.readFile(absolute);
        files.push({ path, size: data.length, hash: createHash('sha256').update(data).digest('hex').slice(0, 32) });
      }
    } else {
      this.logger.warn(`client build not found at ${root}`);
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    const hash = createHash('sha256')
      .update(files.map((f) => `${f.path}:${f.hash}`).join('\n'))
      .digest('hex')
      .slice(0, 32);
    return { hash, version: this.serverVersion(), files };
  }
}

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}
