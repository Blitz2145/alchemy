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
