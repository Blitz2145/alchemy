import type * as SQL from "alchemy/SQL/D1";
import * as Effect from "effect/Effect";

export type Sql = Effect.Success<ReturnType<typeof SQL.D1>>;

export interface TagRow {
  readonly package: string;
  readonly tag: string;
  readonly sha256: string;
  readonly expires_at: number;
  /** JSON array of `owner/repo#N`. */
  readonly linked_prs: string;
}

export const linkedPrs = (row: TagRow): string[] =>
  JSON.parse(row.linked_prs) as string[];

export const getTag = (sql: Sql, pkg: string, tag: string) =>
  Effect.map(
    sql<TagRow>`SELECT * FROM tags WHERE package = ${pkg} AND tag = ${tag}`,
    (rows) => rows[0],
  );

/**
 * Point `tag` at `sha256`, keeping the row alive for at least `expiresAt`
 * and remembering every pull request that produced it.
 */
export const upsertTag = (
  sql: Sql,
  input: {
    readonly package: string;
    readonly tag: string;
    readonly sha256: string;
    readonly expiresAt: number;
    readonly prs: ReadonlyArray<string>;
  },
) =>
  Effect.gen(function* () {
    const existing = yield* getTag(sql, input.package, input.tag);
    const sha256 = input.sha256;
    const expiresAt = Math.max(existing?.expires_at ?? 0, input.expiresAt);
    const prs = JSON.stringify([
      ...new Set([...(existing ? linkedPrs(existing) : []), ...input.prs]),
    ]);
    yield* sql`
      INSERT INTO tags (package, tag, sha256, expires_at, linked_prs)
      VALUES (${input.package}, ${input.tag}, ${sha256}, ${expiresAt}, ${prs})
      ON CONFLICT (package, tag) DO UPDATE SET
        sha256 = excluded.sha256,
        expires_at = excluded.expires_at,
        linked_prs = excluded.linked_prs
    `;
    return sha256;
  });

export const resolveTag = (sql: Sql, pkg: string, tag: string) =>
  Effect.map(getTag(sql, pkg, tag), (row) => row?.sha256);

/** Rows tied to pull requests whose expiry falls before `before`. */
export const dueLinkedTags = (sql: Sql, before: number) =>
  sql<TagRow>`
    SELECT * FROM tags WHERE linked_prs != '[]' AND expires_at < ${before}
  `;

export const setExpiry = (
  sql: Sql,
  pkg: string,
  tag: string,
  expiresAt: number,
) =>
  sql`
    UPDATE tags SET expires_at = ${expiresAt} WHERE package = ${pkg} AND tag = ${tag}
  `;

export const deleteExpired = (sql: Sql, now: number) =>
  sql<{ package: string; sha256: string }>`
    DELETE FROM tags WHERE expires_at < ${now} RETURNING package, sha256
  `;

/** Every tarball some tag still points at, as `<package>/<sha256>`. */
export const referencedTarballs = (sql: Sql) =>
  Effect.map(
    sql<{ package: string; sha256: string }>`
      SELECT DISTINCT package, sha256 FROM tags
    `,
    (rows) => new Set(rows.map((row) => `${row.package}/${row.sha256}`)),
  );
