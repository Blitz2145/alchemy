import * as Github from "@distilled.cloud/github";
import * as Actions from "@distilled.cloud/github/actions";
import * as Apps from "@distilled.cloud/github/apps";
import * as Checks from "@distilled.cloud/github/checks";
import * as Issues from "@distilled.cloud/github/issues";
import * as Pulls from "@distilled.cloud/github/pulls";
import * as Repos from "@distilled.cloud/github/repos";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { signJwt } from "./Crypto.ts";

export interface GitHubOptions {
  readonly http: HttpClient.HttpClient;
  readonly apiUrl: string;
  readonly appId: string;
  readonly key: CryptoKey;
}

export class AppNotInstalled extends Data.TaggedError("AppNotInstalled")<{
  readonly repo: string;
}> {
  override get message() {
    return `The GitHub App is not installed on ${this.repo}`;
  }
}

const USER_AGENT = "alchemy-pkg";

/** Render any GitHub operation failure for logs and error responses. */
export const describe = (error: {
  readonly _tag: string;
  readonly message?: string | undefined;
}) => (error.message ? `${error._tag}: ${error.message}` : error._tag);

const split = (repo: string) => {
  const [owner, name] = repo.split("/");
  return { owner: owner ?? "", repo: name ?? "" };
};

/** Run a distilled GitHub operation as the given bearer token. */
const as = <A, E, R>(
  options: GitHubOptions,
  token: string,
  operation: Effect.Effect<A, E, R>,
) =>
  operation.pipe(
    Effect.provideService(
      Github.Credentials,
      Effect.succeed({
        token: Redacted.make(token),
        apiBaseUrl: options.apiUrl,
        userAgent: USER_AGENT,
      }),
    ),
    Effect.provideService(HttpClient.HttpClient, options.http),
  );

const appJwt = (options: GitHubOptions) => {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    { iat: now - 60, exp: now + 540, iss: options.appId },
    options.key,
  );
};

// Installation tokens are cached per repository for the isolate's lifetime.
const tokens = new Map<string, { token: string; expiresAt: number }>();

/** Mint (or reuse) an installation token for the App on `repo`. */
export const installationToken = (options: GitHubOptions, repo: string) =>
  Effect.gen(function* () {
    const cached = tokens.get(repo);
    if (cached !== undefined && cached.expiresAt > Date.now() + 60_000) {
      return cached.token;
    }
    const jwt = yield* appJwt(options);
    const installation = yield* as(
      options,
      jwt,
      Apps.getRepoInstallation(split(repo)),
    ).pipe(Effect.catchTag("NotFound", () => new AppNotInstalled({ repo })));
    const access = yield* as(
      options,
      jwt,
      Apps.createInstallationAccessToken({ installation_id: installation.id }),
    );
    tokens.set(repo, {
      token: access.token,
      expiresAt: Date.parse(access.expires_at),
    });
    return access.token;
  });

/** A GitHub operation run as the App's installation on `repo`. */
const asInstallation = <A, E, R>(
  options: GitHubOptions,
  repo: string,
  operation: Effect.Effect<A, E, R>,
) =>
  Effect.flatMap(installationToken(options, repo), (token) =>
    as(options, token, operation),
  );

export const getRun = (options: GitHubOptions, repo: string, runId: number) =>
  asInstallation(
    options,
    repo,
    Actions.getWorkflowRun({ ...split(repo), run_id: runId }),
  );

/** Pull requests in `repo` whose head is `sha`. */
export const pullRequestsForCommit = (
  options: GitHubOptions,
  repo: string,
  sha: string,
) =>
  asInstallation(
    options,
    repo,
    Repos.listPullRequestsAssociatedWithCommit({
      ...split(repo),
      commit_sha: sha,
      per_page: 100,
    }),
  ).pipe(
    Effect.map((pulls) =>
      pulls.filter(
        (pr) => pr.head.sha === sha && pr.base.repo.full_name === repo,
      ),
    ),
  );

export const getPullRequest = (
  options: GitHubOptions,
  repo: string,
  number: number,
) =>
  asInstallation(
    options,
    repo,
    Pulls.get({ ...split(repo), pull_number: number }),
  );

/**
 * Publish a completed check run on `headSha`. GitHub shows the newest run
 * per name and App, so re-publishing the same commit simply supersedes it.
 */
export const createCheckRun = (
  options: GitHubOptions,
  repo: string,
  input: {
    readonly headSha: string;
    readonly name: string;
    readonly title: string;
    readonly summary: string;
    readonly detailsUrl: string;
  },
) =>
  asInstallation(
    options,
    repo,
    Checks.create({
      ...split(repo),
      name: input.name,
      head_sha: input.headSha,
      status: "completed",
      conclusion: "success",
      completed_at: new Date().toISOString(),
      details_url: input.detailsUrl,
      output: { title: input.title, summary: input.summary },
    }),
  );

/** Create or update the comment on `issue` whose body starts with `marker`. */
export const upsertComment = (
  options: GitHubOptions,
  repo: string,
  issue: number,
  marker: string,
  body: string,
) =>
  Effect.gen(function* () {
    let existing: number | undefined;
    for (let page = 1; page <= 5 && existing === undefined; page++) {
      const comments = yield* asInstallation(
        options,
        repo,
        Issues.listComments({
          ...split(repo),
          issue_number: issue,
          per_page: 100,
          page,
        }),
      );
      existing = comments.find((c) => c.body?.startsWith(marker))?.id;
      if (comments.length < 100) break;
    }
    if (existing === undefined) {
      yield* asInstallation(
        options,
        repo,
        Issues.createComment({ ...split(repo), issue_number: issue, body }),
      );
    } else {
      yield* asInstallation(
        options,
        repo,
        Issues.updateComment({ ...split(repo), comment_id: existing, body }),
      );
    }
  });
