import * as Schema from "effect/Schema";
import { Policy } from "../Policy.ts";

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

/** Worker env var holding the GitHub App id. */
export const APP_ID_ENV = "PKG_GITHUB_APP_ID";

/** Worker secret env var holding the GitHub App private key PEM. */
export const PRIVATE_KEY_ENV = "PKG_GITHUB_APP_PRIVATE_KEY";

export const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const OIDC_JWKS_URL = `${OIDC_ISSUER}/.well-known/jwks`;

/** Marker that identifies the sticky install comment. */
export const COMMENT_MARKER = "<!-- pkg-preview-comment -->";

/** Uploaded tarballs no tag points at are deleted once older than this. */
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

/** Tags tied to pull requests are re-checked when due within this window. */
export const SWEEP_LOOKAHEAD_MS = 2 * 60 * 60 * 1000;
