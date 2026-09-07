import * as Schema from "effect/Schema";

/**
 * Registry policy. Plain data: it is validated when the Registry is defined
 * and captured in the Worker bundle, so it must not contain functions.
 */
export const Policy = Schema.Struct({
  /**
   * Repositories allowed to publish, as `owner/name`. A publication may
   * contain any package; every package gets the commit, short commit,
   * `branch:` and `pr:` tags of the run that produced it.
   */
  repos: Schema.Array(Schema.String),
  /**
   * How long a publication lives: from the push for branch publications,
   * from close or merge for pull request publications. Publishing the same
   * content again refreshes the clock.
   * @default Duration.weeks(1)
   */
  ttl: Schema.optionalKey(Schema.Duration),
  /**
   * Upper bound on a single tarball as a `FileSystem.SizeInput`, e.g.
   * `FileSystem.MiB(100)`. Absent means unlimited.
   */
  maxPackageSize: Schema.optionalKey(
    Schema.Union([Schema.Number, Schema.BigInt]),
  ),
});
export type Policy = typeof Policy.Type;
export type PolicyInput = typeof Policy.Encoded;
