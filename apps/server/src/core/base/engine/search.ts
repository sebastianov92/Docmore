import { Expression, ExpressionBuilder, sql, SqlBool } from 'kysely';
import { DB } from '@docmost/db/types/db';
import { SearchSpec } from './schema.zod';

type Eb = ExpressionBuilder<DB, 'baseRows'>;

/*
 * `search_text` and `search_tsv` are maintained by the base_rows search
 * trigger installed in the bases-hardening migration. Both columns are
 * indexed — pg_trgm GIN for ILIKE and standard GIN for tsvector.
 */

export function buildSearch(eb: Eb, spec: SearchSpec): Expression<SqlBool> {
  const q = spec.query.trim();
  if (!q) return sql<SqlBool>`TRUE`;
  // Rows carry no search column: a plain substring match over the cell
  // JSON is enough at homelab scale (both modes behave the same).
  const escaped = q.replace(/[%_\\]/g, '\\$&');
  const exclude = spec.excludeKeys ?? [];
  if (exclude.length > 0) {
    // cells the reader may not see take no part in the match
    return sql<SqlBool>`(
      select coalesce(string_agg(kv.value::text, ' '), '')
      from jsonb_each(cells) as kv(key, value)
      where kv.key <> all(${sql.val(exclude)}::text[])
    ) ILIKE ${'%' + escaped + '%'}`;
  }
  return sql<SqlBool>`cells::text ILIKE ${'%' + escaped + '%'}`;
}
