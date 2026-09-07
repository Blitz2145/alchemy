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
  /** Upper bound on a single tarball, in bytes. Absent means unlimited. */
  maxPackageSize: Schema.optionalKey(Schema.Number),
  /**
   * File name of the publishing workflow. OIDC tokens must come from this
   * workflow file in the repository, on any ref.
   * @default "pkg.yml"
   */
  workflow: Schema.optionalKey(Schema.String),
});
export type Policy = typeof Policy.Type;
export type PolicyInput = typeof Policy.Encoded;

export const DEFAULT_WORKFLOW = "pkg.yml";

/** Prefix a `job_workflow_ref` claim must have to publish for `repo`. */
export const publishWorkflowRef = (policy: Policy, repo: string) =>
  `${repo}/.github/workflows/${policy.workflow ?? DEFAULT_WORKFLOW}@`;
