import { BadRequestException } from '@nestjs/common';

// URLs the server may call on a user's behalf: http(s) to the outside world
// only (no loopback, link-local or private ranges, by hostname).
export function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestException('Invalid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new BadRequestException('URL must be http(s)');
  const host = url.hostname.toLowerCase().replace(/[\[\]]/g, '');
  const blocked =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '::' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^(fc|fd)[0-9a-f]{2}:/i.test(host) ||
    /^fe80:/i.test(host) ||
    /^::ffff:/i.test(host);
  if (blocked) throw new BadRequestException('URL points inside the network');
  return url;
}

export type FetchedPage = { url: string; contentType: string; body: string; status: number };

// GET with a time and size cap, following a few redirects while re-checking
// each hop against the guard above.
export async function fetchPublicHtml(
  raw: string,
  opts: { timeoutMs?: number; maxBytes?: number; maxRedirects?: number; userAgent?: string } = {},
): Promise<FetchedPage> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const maxBytes = opts.maxBytes ?? 1_500_000;
  let current = assertPublicUrl(raw).toString();
  for (let hop = 0; hop <= (opts.maxRedirects ?? 3); hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': opts.userAgent ?? 'Mozilla/5.0 (compatible; Docmore/1.0; +https://docmore)',
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
          'accept-language': 'en, es;q=0.8',
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new BadRequestException('Redirect without a location');
        current = assertPublicUrl(new URL(location, current).toString()).toString();
        continue;
      }
      const contentType = res.headers.get('content-type') ?? '';
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            total += value.byteLength;
            if (total > maxBytes) {
              await reader.cancel().catch(() => undefined);
              break;
            }
            chunks.push(value);
          }
        }
      }
      const body = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
      return { url: current, contentType, body, status: res.status };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new BadRequestException('Too many redirects');
}

// og:* / twitter:* / title / description / icon out of an HTML document.
export function extractPageMeta(html: string, baseUrl: string) {
  const head = html.slice(0, 300_000);
  const meta = (names: string[]): string | undefined => {
    for (const name of names) {
      const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name.replace(/[:.]/g, '\\$&')}["'][^>]*>`, 'i');
      const tag = re.exec(head)?.[0];
      const content = tag ? /content=["']([^"']*)["']/i.exec(tag)?.[1] : undefined;
      if (content) return decodeEntities(content.trim());
    }
    return undefined;
  };
  const titleTag = /<title[^>]*>([^<]*)<\/title>/i.exec(head)?.[1];
  const iconTag = /<link[^>]+rel=["'](?:shortcut )?icon["'][^>]*>/i.exec(head)?.[0];
  const iconHref = iconTag ? /href=["']([^"']+)["']/i.exec(iconTag)?.[1] : undefined;
  const abs = (u?: string) => {
    if (!u) return undefined;
    try {
      return new URL(u, baseUrl).toString();
    } catch {
      return undefined;
    }
  };
  const hostname = (() => {
    try {
      return new URL(baseUrl).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  })();
  return {
    title: meta(['og:title', 'twitter:title']) ?? (titleTag ? decodeEntities(titleTag.trim()) : undefined) ?? hostname,
    description: meta(['og:description', 'twitter:description', 'description']),
    image: abs(meta(['og:image', 'og:image:url', 'twitter:image'])),
    siteName: meta(['og:site_name']) ?? hostname,
    favicon: abs(iconHref) ?? abs('/favicon.ico'),
    hostname,
  };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}
