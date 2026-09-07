import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";
import { COMMENT_MARKER } from "../Api.ts";
import * as Github from "@distilled.cloud/github";
import * as Actions from "@distilled.cloud/github/actions";
import * as Apps from "@distilled.cloud/github/apps";
import * as Checks from "@distilled.cloud/github/checks";
import * as Issues from "@distilled.cloud/github/issues";
import * as Pulls from "@distilled.cloud/github/pulls";
import * as Repos from "@distilled.cloud/github/repos";
import * as Clock from "effect/Clock";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";

export class CryptoError extends Data.TaggedError("CryptoError")<{
  readonly message: string;
}> {}

const encoder = new TextEncoder();

/** Lowercase hex SHA-256 of a string. */
export const sha256Hex = (text: string) =>
  Effect.promise(async () =>
    Encoding.encodeHex(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", encoder.encode(text)),
      ),
    ),
  );

/** DER length prefix. */
const derLength = (length: number): number[] => {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
};

/**
 * Wrap a PKCS#1 `RSAPrivateKey` in a PKCS#8 `PrivateKeyInfo` so WebCrypto
 * can import it. GitHub issues App keys in PKCS#1.
 */
const pkcs1ToPkcs8 = (pkcs1: Uint8Array): Uint8Array<ArrayBuffer> => {
  // SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING { pkcs1 } }
  const algorithm = [
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x01, 0x05, 0x00,
  ];
  const octetString = [0x04, ...derLength(pkcs1.length)];
  const version = [0x02, 0x01, 0x00];
  const bodyLength =
    version.length + algorithm.length + octetString.length + pkcs1.length;
  return Uint8Array.from([
    0x30,
    ...derLength(bodyLength),
    ...version,
    ...algorithm,
    ...octetString,
    ...pkcs1,
  ]);
};

/** Import an RSA private key PEM (PKCS#1 or PKCS#8) for RS256 signing. */
export const importPrivateKey = (pem: string) =>
  Effect.gen(function* () {
    const match = pem.match(
      /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/,
    );
    if (!match) {
      return yield* new CryptoError({ message: "not an RSA private key PEM" });
    }
    const decoded = Encoding.decodeBase64(match[2]!.replace(/\s+/g, ""));
    if (Result.isFailure(decoded)) {
      return yield* new CryptoError({ message: "private key is not base64" });
    }
    const der = decoded.success;
    const pkcs8 = match[1] ? pkcs1ToPkcs8(der) : Uint8Array.from(der);
    return yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey(
          "pkcs8",
          pkcs8,
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["sign"],
        ),
      catch: (cause) =>
        new CryptoError({ message: `invalid private key: ${cause}` }),
    });
  });

/** Sign a compact RS256 JWT, used to authenticate as the GitHub App. */
export const signJwt = (claims: Record<string, unknown>, key: CryptoKey) =>
  Effect.tryPromise({
    try: async () => {
      const header = Encoding.encodeBase64Url(
        JSON.stringify({ alg: "RS256", typ: "JWT" }),
      );
      const payload = Encoding.encodeBase64Url(JSON.stringify(claims));
      const input = `${header}.${payload}`;
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        key,
        encoder.encode(input),
      );
      return `${input}.${Encoding.encodeBase64Url(new Uint8Array(signature))}`;
    },
    catch: (cause) => new CryptoError({ message: `signing failed: ${cause}` }),
  });

const SHORT = 7;

/** Install commands per package, grouped, pinned to the run's short commit. */
export const renderInstalls = (
  origin: string,
  run: { readonly headSha: string },
  packages: ReadonlyArray<{ name: string; group: string }>,
) => {
  const groups = new Map<string, string[]>();
  for (const pkg of packages) {
    groups.set(pkg.group, [...(groups.get(pkg.group) ?? []), pkg.name]);
  }
  const short = run.headSha.slice(0, SHORT);
  // Packages appear in the order the manifest lists them, which is the
  // order they were given to `pkg pack`.
  return [...groups]
    .flatMap(([group, names]) => [
      `### ${group}`,
      "",
      ...names.flatMap((name) => [
        `**${name}**`,
        "```sh",
        `pnpm install ${origin}/${name}/${short}`,
        "```",
        "",
      ]),
    ])
    .join("\n");
};

/**
 * GitHub's `<relative-time>` element, rendered as a live relative time in
 * comments, with a plain UTC fallback like `Sep 7, 2026 2:42pm UTC`.
 */
const relativeTime = (millis: number) => {
  const date = new Date(millis);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const hours = date.getUTCHours();
  const clock = `${hours % 12 || 12}:${String(date.getUTCMinutes()).padStart(2, "0")}${hours < 12 ? "am" : "pm"}`;
  const label = `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()} ${clock} UTC`;
  return `<relative-time datetime="${date.toISOString()}">${label}</relative-time>`;
};

export const renderComment = (
  origin: string,
  run: { readonly headSha: string },
  packages: ReadonlyArray<{ name: string; group: string }>,
  times: { readonly publishedAt: number; readonly expiresAt: number },
) =>
  [
    COMMENT_MARKER,
    "",
    "Install the packages built from this commit:",
    "",
    renderInstalls(origin, run, packages),
    `Published ${relativeTime(times.publishedAt)}. Expires ${relativeTime(times.expiresAt)}, extended while this pull request is open.`,
  ].join("\n");

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

const appJwt = Effect.fn("GitHub.appJwt")(function* (options: GitHubOptions) {
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  return yield* signJwt(
    { iat: now - 60, exp: now + 540, iss: options.appId },
    options.key,
  );
});

// Installation tokens are cached per repository for the isolate's lifetime.
const tokens = new Map<string, { token: string; expiresAt: number }>();

/** Mint (or reuse) an installation token for the App on `repo`. */
export const installationToken = (options: GitHubOptions, repo: string) =>
  Effect.gen(function* () {
    const cached = tokens.get(repo);
    if (
      cached !== undefined &&
      cached.expiresAt > (yield* Clock.currentTimeMillis) + 60_000
    ) {
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

/** Artifacts uploaded to a run so far, including by jobs still in progress. */
export const listRunArtifacts = (
  options: GitHubOptions,
  repo: string,
  runId: number,
) =>
  asInstallation(
    options,
    repo,
    Actions.listWorkflowRunArtifacts({
      ...split(repo),
      run_id: runId,
      per_page: 100,
    }),
  ).pipe(Effect.map((page) => page.artifacts));

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
export const createCheckRun = Effect.fn("GitHub.createCheckRun")(function* (
  options: GitHubOptions,
  repo: string,
  input: {
    readonly headSha: string;
    readonly name: string;
    readonly title: string;
    readonly summary: string;
    readonly detailsUrl: string;
  },
) {
  return yield* asInstallation(
    options,
    repo,
    Checks.create({
      ...split(repo),
      name: input.name,
      head_sha: input.headSha,
      status: "completed",
      conclusion: "success",
      completed_at: new Date(yield* Clock.currentTimeMillis).toISOString(),
      details_url: input.detailsUrl,
      output: { title: input.title, summary: input.summary },
    }),
  );
});

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
