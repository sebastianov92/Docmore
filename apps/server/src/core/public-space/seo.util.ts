import { KyselyDB } from '@docmost/db/types/kysely.types';

// First lines of the page text for the description metas.
export async function pageExcerpt(db: KyselyDB, pageId: string): Promise<string> {
  if (!pageId) return '';
  const row = await db
    .selectFrom('pages')
    .select('textContent')
    .where('id', '=', pageId)
    .executeTakeFirst();
  const text = (row?.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

export function seoMetaTags(opts: {
  title: string;
  description: string;
  canonical: string;
  searchIndexing: boolean;
}): string {
  const { title, description, canonical, searchIndexing } = opts;
  return [
    `<meta property="og:title" content="${title}" />`,
    `<meta property="twitter:title" content="${title}" />`,
    description ? `<meta name="description" content="${description}" />` : '',
    description ? `<meta property="og:description" content="${description}" />` : '',
    `<meta property="og:type" content="article" />`,
    `<meta property="og:url" content="${canonical}" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<link rel="canonical" href="${canonical}" />`,
    !searchIndexing ? `<meta name="robots" content="noindex" />` : '',
  ]
    .filter(Boolean)
    .join('\n    ');
}
