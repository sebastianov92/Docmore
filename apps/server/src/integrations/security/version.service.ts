import { Inject, Injectable } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import {
  CacheKey,
  LATEST_VERSION_CACHE_TTL_MS,
} from '../../common/helpers/cache-keys';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const packageJson = require('./../../../package.json');

// Docmore releases live in the fork, not upstream Docmost.
const RELEASE_REPO = 'sebastianov92/Docmore';
const RELEASES_URL = `https://github.com/${RELEASE_REPO}/releases`;

@Injectable()
export class VersionService {
  constructor(@Inject(CACHE_MANAGER) private readonly cacheManager: Cache) {}

  async getVersion() {
    const url = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;

    let latestVersion: string | number = 0;
    try {
      const cached = await this.cacheManager.get<string>(
        CacheKey.LATEST_VERSION,
      );
      if (cached) {
        latestVersion = cached;
      } else {
        const response = await fetch(url);
        // A refusal (rate limit) or a repo without releases yet is not
        // cached, so the next request asks again; the running version is
        // still reported.
        if (response.ok) {
          const data = await response.json();
          latestVersion = data?.tag_name?.replace('v', '') ?? 0;
          await this.cacheManager.set(
            CacheKey.LATEST_VERSION,
            latestVersion,
            LATEST_VERSION_CACHE_TTL_MS,
          );
        }
      }
    } catch (err) {
      /* empty */
    }

    return {
      currentVersion: packageJson?.version,
      latestVersion: latestVersion,
      releaseUrl: RELEASES_URL,
    };
  }
}
