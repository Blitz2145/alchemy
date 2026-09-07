import * as Schema from "effect/Schema";
import { Manifest } from "./Manifest.ts";

/**
 * `POST /api/publish`. Idempotent: the registry verifies the run, checks
 * every tarball is present, and either answers 409 with the missing ones or
 * writes the tags and answers 200.
 */
export const PublishRequest = Schema.Struct({
  /** The build run whose artifact is being published. */
  runId: Schema.Number,
  manifest: Manifest,
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
