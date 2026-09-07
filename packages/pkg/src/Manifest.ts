import * as Schema from "effect/Schema";

/**
 * One packed workspace package inside a `pkg pack` artifact.
 *
 * Everything here is data the CLI observed while packing. The registry never
 * derives a tag from it: every tag comes from the GitHub Actions run that
 * vouched for the manifest, and tarball bytes are re-hashed on upload.
 */
export const ManifestPackage = Schema.Struct({
  /** npm package name, scoped or unscoped. */
  name: Schema.String,
  /** Version from the package manifest at pack time. */
  version: Schema.String,
  /** Package directory relative to the workspace root, POSIX separators. */
  dir: Schema.String,
  /** Display group for the install comment, e.g. `Alchemy` or `Distilled`. */
  group: Schema.String,
  /** Tarball file name inside the artifact directory. */
  file: Schema.String,
  /** Lowercase hex SHA-256 of the tarball bytes. */
  sha256: Schema.String,
  /** Tarball size in bytes. */
  size: Schema.Number,
});
export type ManifestPackage = typeof ManifestPackage.Type;

/**
 * The `pkg-manifest.json` written next to the tarballs by `pkg pack` and read
 * back by `pkg publish`.
 */
export const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  /** Registry origin the tarball dependencies were rewritten against. */
  registry: Schema.String,
  /**
   * HEAD commit of the root repository at pack time. Dependency URLs inside
   * the tarballs point at this commit for every packed package, including
   * packages inside submodules, because the registry tags everything a run
   * publishes with that run's head commit.
   */
  head: Schema.String,
  packages: Schema.Array(ManifestPackage),
});
export type Manifest = typeof Manifest.Type;

export const ManifestJson = Schema.fromJsonString(Manifest);

export const MANIFEST_FILE = "pkg-manifest.json";
