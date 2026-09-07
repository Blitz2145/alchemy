import * as Schema from "effect/Schema";

/**
 * Header naming the GitHub Actions run a request comes from, as
 * `owner/repo#<run id>:<attempt>`. It is a lookup hint, not a credential:
 * the registry resolves the run through the GitHub API and trusts only what
 * GitHub says about it.
 */
export const RUN_HEADER = "x-github-run";

export const runHeader = (repo: string, runId: number, attempt: number) =>
  `${repo}#${runId}:${attempt}`;

export const parseRunHeader = (value: string) => {
  const match = value.match(/^([^#\s]+\/[^#\s]+)#(\d+):(\d+)$/);
  return match
    ? { repo: match[1]!, runId: Number(match[2]), attempt: Number(match[3]) }
    : undefined;
};

/**
 * Name of the artifact a job uploads to its own run to vouch for a manifest.
 * Only the job holds the runtime token that can add artifacts to the run, so
 * an artifact carrying the manifest's hash is GitHub's record that this run
 * approved exactly these package hashes.
 */
export const manifestArtifactName = (sha256: string) =>
  `pkg-manifest-${sha256}`;

/**
 * `POST /api/publish`. `manifest` is the exact `pkg-manifest.json` text the
 * job vouched for; its SHA-256 must match an artifact on the run. Idempotent:
 * the registry either answers 409 with the tarballs it lacks or writes the
 * tags and answers 200.
 */
export const PublishRequest = Schema.Struct({
  manifest: Schema.String,
});
export type PublishRequest = typeof PublishRequest.Type;

export const TarballRef = Schema.Struct({
  name: Schema.String,
  sha256: Schema.String,
});

/** 409 body: upload these, then publish again. */
export const MissingResponse = Schema.Struct({
  missing: Schema.Array(TarballRef),
});
export type MissingResponse = typeof MissingResponse.Type;

export const PublishResponse = Schema.Struct({
  packages: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      group: Schema.String,
      /** Install URL pinned to the commit. */
      url: Schema.String,
      tags: Schema.Array(Schema.String),
    }),
  ),
});
export type PublishResponse = typeof PublishResponse.Type;

/** `PUT /api/tarballs/:name/:sha256` */
export const TarballResponse = Schema.Struct({
  name: Schema.String,
  sha256: Schema.String,
  size: Schema.Number,
  uploaded: Schema.Boolean,
});
export type TarballResponse = typeof TarballResponse.Type;

export const ErrorResponse = Schema.Struct({ error: Schema.String });

export const tarballPath = (name: string, sha256: string) =>
  `/api/tarballs/${encodeURIComponent(name)}/${sha256}`;

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

/**
 * Everything the Worker runtime needs, as plain data. Built by the
 * {@link Registry} factory from its props and captured in the bundle, so it
 * is available at deploy time and inside the isolate without any env read.
 */
export const RegistryConfig = Schema.Struct({
  policy: Policy,
  /**
   * Hostname to package scope. Requests on an aliased host resolve an
   * unscoped name under that scope, so `pkg.distilled.cloud/core@<sha>`
   * serves `@distilled.cloud/core`.
   */
  aliases: Schema.Record(Schema.String, Schema.String),
  github: Schema.Struct({
    apiUrl: Schema.String,
  }),
  /** Cron expression for the expiry sweep. */
  cron: Schema.String,
});
export type RegistryConfig = typeof RegistryConfig.Type;

/** Worker env var the GitHub App id is bound under. */
export const APP_ID_ENV = "PKG_GITHUB_APP_ID";

/** Worker secret env var the GitHub App private key PEM is bound under. */
export const PRIVATE_KEY_ENV = "PKG_GITHUB_APP_PRIVATE_KEY";

/** Marker that identifies the sticky install comment. */
export const COMMENT_MARKER = "<!-- pkg-preview-comment -->";

/** Uploaded tarballs no tag points at are deleted once older than this. */
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

/** Tags tied to pull requests are re-checked when due within this window. */
export const SWEEP_LOOKAHEAD_MS = 2 * 60 * 60 * 1000;
