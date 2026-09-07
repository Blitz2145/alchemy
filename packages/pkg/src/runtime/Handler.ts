import * as Cloudflare from "alchemy/Cloudflare";
import * as SQL from "alchemy/SQL/D1";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  MissingResponse,
  parseRunHeader,
  PublishRequest,
  PublishResponse,
  RUN_HEADER,
  TarballResponse,
} from "../Api.ts";
import type { ManifestPackage } from "../Manifest.ts";
import { publishWorkflowRef, type Policy } from "../Policy.ts";
import {
  COMMENT_MARKER,
  OIDC_ISSUER,
  OIDC_JWKS_URL,
  ORPHAN_GRACE_MS,
  SWEEP_LOOKAHEAD_MS,
  type RegistryConfig,
} from "./Config.ts";
import { importPrivateKey, Jwks, verifyJwt, type Jwk } from "./Crypto.ts";
import * as Db from "./Db.ts";
import * as GitHub from "./GitHub.ts";
import { Index, Tarballs, tarballKey } from "./Resources.ts";

/** A failure that maps directly to an HTTP response. */
export class HttpError extends Data.TaggedError("HttpError")<{
  readonly status: number;
  readonly message: string;
}> {}

const OidcClaims = Schema.fromJsonString(
  Schema.Struct({
    iss: Schema.String,
    aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
    exp: Schema.Number,
    nbf: Schema.optionalKey(Schema.Number),
    repository: Schema.String,
    job_workflow_ref: Schema.String,
    run_id: Schema.String,
  }),
);

/**
 * Who is publishing. `oidc` means the job presented a verified OIDC token
 * for this run. `run` means it only named the run, which the registry then
 * verifies through the GitHub API and accepts solely for fork pull requests,
 * since GitHub issues those jobs no token.
 */
interface Identity {
  readonly repo: string;
  readonly runId: number;
  readonly attempt: number;
  readonly proof: "oidc" | "run";
}

/** What the registry learned about a build run from GitHub. */
interface Run {
  readonly repo: string;
  readonly headSha: string;
  readonly headBranch: string | null;
  readonly headRepo: string;
  readonly pr: number | null;
}

const bindings = Layer.mergeAll(
  Cloudflare.R2.ReadWriteBucketBinding,
  Cloudflare.D1.QueryDatabaseBinding,
  Cloudflare.Workers.CronEventSourceLive,
  FetchHttpClient.layer,
);

const SHORT = 7;

const ttlMillis = (policy: Policy) =>
  Duration.toMillis(policy.ttl ?? Duration.weeks(1));

/**
 * Parse `/<name>@<tag>` and `/<name>/-/<sha256>.tgz`. Scoped names contain
 * one `/`; the tag may contain anything, including `/` and `:`.
 */
const parseInstallPath = (
  pathname: string,
  scope: string | undefined,
):
  | { kind: "tag"; name: string; tag: string }
  | { kind: "tarball"; name: string; sha256: string }
  | undefined => {
  const path = decodeURIComponent(pathname.replace(/^\/+/, ""));
  const tarball = path.match(
    /^(@[^/]+\/[^/@]+|[^/@]+)\/-\/([a-f0-9]{64})\.tgz$/,
  );
  if (tarball) {
    return {
      kind: "tarball",
      name: qualify(tarball[1]!, scope),
      sha256: tarball[2]!,
    };
  }
  const at = path.startsWith("@") ? path.indexOf("@", 1) : path.indexOf("@");
  if (at <= 0 || at === path.length - 1) return undefined;
  return {
    kind: "tag",
    name: qualify(path.slice(0, at), scope),
    tag: path.slice(at + 1),
  };
};

const qualify = (name: string, scope: string | undefined) =>
  scope !== undefined && !name.startsWith("@") ? `${scope}/${name}` : name;

const encodeName = (name: string) =>
  name.split("/").map(encodeURIComponent).join("/");

/**
 * Tags a package receives: its commit, the short commit, `pr:N` for pull
 * requests, and `branch:<name>` for pushes and same-repo pull requests.
 */
const tagsFor = (pkg: ManifestPackage, run: Run): string[] => {
  const tags = [pkg.commit, pkg.commit.slice(0, SHORT)];
  if (run.pr !== null) {
    tags.push(`pr:${run.pr}`);
    if (run.headRepo === run.repo && run.headBranch) {
      tags.push(`branch:${run.headBranch}`);
    }
  } else if (run.headBranch) {
    tags.push(`branch:${run.headBranch}`);
  }
  return tags;
};

/** Grouped `bun add` lines pinned to each package's short commit. */
const renderInstalls = (
  origin: string,
  packages: ReadonlyArray<{ name: string; group: string; commit: string }>,
) => {
  const groups = new Map<string, Array<{ name: string; commit: string }>>();
  for (const pkg of packages) {
    groups.set(pkg.group, [...(groups.get(pkg.group) ?? []), pkg]);
  }
  return [...groups]
    .flatMap(([group, pkgs]) => [
      `### ${group}`,
      "```sh",
      ...pkgs.map(
        (pkg) =>
          `bun add ${origin}/${encodeName(pkg.name)}@${pkg.commit.slice(0, SHORT)}`,
      ),
      "```",
      "",
    ])
    .join("\n");
};

const renderComment = (
  origin: string,
  run: Run,
  packages: ReadonlyArray<{ name: string; group: string; commit: string }>,
) =>
  [
    COMMENT_MARKER,
    `Preview packages for ${run.headSha.slice(0, SHORT)}:`,
    "",
    renderInstalls(origin, packages),
  ].join("\n");

const CHECK_NAME = "Preview packages";

export const make = (config: RegistryConfig) =>
  Effect.gen(function* () {
    const r2 = yield* Cloudflare.R2.ReadWriteBucket(Tarballs);
    const d1 = yield* Cloudflare.D1.QueryDatabase(Index);
    const sql = yield* SQL.D1(d1);
    const http = yield* HttpClient.HttpClient;
    const policy = config.policy;
    const maxSize = policy.maxPackageSize;

    // Isolate-scoped caches of plain values: the imported App key and the
    // OIDC signing keys. Neither is I/O-backed, so both survive requests.
    let appKey: CryptoKey | undefined;
    let jwks: { keys: ReadonlyArray<Jwk>; fetchedAt: number } | undefined;

    const github = Effect.gen(function* () {
      if (appKey === undefined) {
        const pem = yield* Config.redacted(config.github.privateKeyEnv);
        appKey = yield* importPrivateKey(Redacted.value(pem));
      }
      return {
        http,
        apiUrl: config.github.apiUrl,
        appId: yield* Config.string(config.github.appIdEnv),
        key: appKey,
      } satisfies GitHub.GitHubOptions;
    });

    const upstream = (e: {
      readonly _tag: string;
      readonly message?: string;
    }) => new HttpError({ status: 502, message: GitHub.describe(e) });

    const signingKeys = (kid: string | undefined) =>
      Effect.gen(function* () {
        const stale =
          jwks === undefined ||
          Date.now() - jwks.fetchedAt > 60 * 60 * 1000 ||
          (kid !== undefined && !jwks.keys.some((k) => k.kid === kid));
        if (stale) {
          const response = yield* http.get(OIDC_JWKS_URL);
          const body = yield* response.json;
          const decoded = yield* Schema.decodeUnknownEffect(Jwks)(body);
          jwks = { keys: decoded.keys, fetchedAt: Date.now() };
        }
        return jwks!.keys;
      });

    const authenticate = (request: HttpServerRequest, origin: string) =>
      Effect.gen(function* () {
        const run = parseRunHeader(request.headers[RUN_HEADER] ?? "");
        if (run === undefined) {
          return yield* new HttpError({
            status: 401,
            message: `${RUN_HEADER} header is required`,
          });
        }
        if (!policy.repos.includes(run.repo)) {
          return yield* new HttpError({
            status: 403,
            message: `${run.repo} may not publish`,
          });
        }
        const header = request.headers.authorization;
        if (!header?.startsWith("Bearer ")) {
          return { ...run, proof: "run" } satisfies Identity;
        }
        const token = header.slice("Bearer ".length);
        const keys = yield* signingKeys(readKid(token.split(".")[0] ?? ""));
        const payload = yield* verifyJwt(token, keys).pipe(
          Effect.mapError(
            (e) => new HttpError({ status: 401, message: e.message }),
          ),
        );
        const claims = yield* Schema.decodeUnknownEffect(OidcClaims)(
          payload,
        ).pipe(
          Effect.mapError(
            () => new HttpError({ status: 401, message: "unexpected claims" }),
          ),
        );
        const now = Math.floor(Date.now() / 1000);
        const audiences =
          typeof claims.aud === "string" ? [claims.aud] : claims.aud;
        if (claims.iss !== OIDC_ISSUER) {
          return yield* new HttpError({
            status: 401,
            message: "unexpected issuer",
          });
        }
        if (!audiences.includes(origin)) {
          return yield* new HttpError({
            status: 401,
            message: `audience must be ${origin}`,
          });
        }
        if (
          claims.exp <= now ||
          (claims.nbf !== undefined && claims.nbf > now)
        ) {
          return yield* new HttpError({
            status: 401,
            message: "token expired",
          });
        }
        if (
          claims.repository !== run.repo ||
          Number(claims.run_id) !== run.runId
        ) {
          return yield* new HttpError({
            status: 401,
            message: "token does not belong to the named run",
          });
        }
        if (
          !claims.job_workflow_ref.startsWith(
            publishWorkflowRef(policy, claims.repository),
          )
        ) {
          return yield* new HttpError({
            status: 403,
            message: `${claims.job_workflow_ref} may not publish`,
          });
        }
        return { ...run, proof: "oidc" } satisfies Identity;
      });

    /**
     * Resolve the publishing run through GitHub; nothing about it is trusted
     * from the client. The run must be in progress, since the request comes
     * from inside it. A run-only proof is accepted for fork pull requests
     * alone: everything else has an OIDC token and must present it.
     */
    const resolveRun = (identity: Identity) =>
      Effect.gen(function* () {
        const gh = yield* github;
        const run = yield* GitHub.getRun(
          gh,
          identity.repo,
          identity.runId,
        ).pipe(Effect.mapError(upstream));
        if (
          run.status !== "in_progress" ||
          (run.run_attempt !== undefined &&
            run.run_attempt !== identity.attempt)
        ) {
          return yield* new HttpError({
            status: 409,
            message: "run is not in progress",
          });
        }
        if (run.event !== "push" && run.event !== "pull_request") {
          return yield* new HttpError({
            status: 400,
            message: `unsupported event ${run.event}`,
          });
        }
        const headRepo =
          run.head_repository?.full_name ?? run.repository.full_name;
        if (
          identity.proof === "run" &&
          (run.event !== "pull_request" || headRepo === identity.repo)
        ) {
          return yield* new HttpError({
            status: 401,
            message:
              "an OIDC token is required unless the run is a pull request from a fork",
          });
        }
        let pr: number | null = null;
        if (run.event === "pull_request") {
          const pulls = yield* GitHub.pullRequestsForCommit(
            gh,
            identity.repo,
            run.head_sha,
          ).pipe(Effect.mapError(upstream));
          const first = pulls[0];
          if (first === undefined) {
            return yield* new HttpError({
              status: 404,
              message: `no pull request has head ${run.head_sha}`,
            });
          }
          pr = first.number;
        }
        return {
          repo: identity.repo,
          headSha: run.head_sha,
          headBranch: run.head_branch,
          headRepo,
          pr,
        } satisfies Run;
      });

    const validatePackage = (pkg: ManifestPackage) =>
      maxSize !== undefined && pkg.size > maxSize
        ? Effect.fail(
            new HttpError({
              status: 413,
              message: `${pkg.name} exceeds ${maxSize} bytes`,
            }),
          )
        : Effect.void;

    const publish = (
      identity: Identity,
      body: PublishRequest,
      origin: string,
    ) =>
      Effect.gen(function* () {
        const run = yield* resolveRun(identity);
        const packages = body.manifest.packages;
        yield* Effect.forEach(packages, validatePackage);

        const present = yield* Effect.forEach(
          packages,
          (pkg) => r2.head(tarballKey(pkg.name, pkg.sha256)),
          { concurrency: 8 },
        );
        const missing = packages
          .filter((_, index) => present[index] === null)
          .map((pkg) => ({ name: pkg.name, sha256: pkg.sha256 }));
        if (missing.length > 0) {
          return yield* HttpServerResponse.json(
            { missing } satisfies MissingResponse,
            { status: 409 },
          );
        }

        const now = Date.now();
        const expiresAt = now + ttlMillis(policy);
        const prs = run.pr !== null ? [`${run.repo}#${run.pr}`] : [];
        const published: PublishResponse["packages"][number][] = [];
        for (const pkg of packages) {
          const tags = tagsFor(pkg, run);
          for (const tag of tags) {
            yield* Db.upsertTag(sql, {
              package: pkg.name,
              tag,
              sha256: pkg.sha256,
              expiresAt,
              prs,
            });
          }
          published.push({
            name: pkg.name,
            group: pkg.group,
            url: `${origin}/${encodeName(pkg.name)}@${pkg.commit.slice(0, SHORT)}`,
            tags,
          });
        }

        const gh = yield* github;
        // A check on the commit itself, so the install lines are visible on
        // pushes and on fork pull requests alike.
        yield* GitHub.createCheckRun(gh, run.repo, {
          headSha: run.headSha,
          name: CHECK_NAME,
          title: `${packages.length} package(s) published`,
          summary: renderInstalls(origin, packages),
          detailsUrl: origin,
        }).pipe(
          Effect.catch((e) =>
            Effect.logWarning(
              `check run on ${run.repo}@${run.headSha} failed: ${GitHub.describe(e)}`,
            ),
          ),
        );
        if (run.pr !== null) {
          const body = renderComment(origin, run, packages);
          yield* GitHub.upsertComment(
            gh,
            run.repo,
            run.pr,
            COMMENT_MARKER,
            body,
          ).pipe(
            Effect.catch((e) =>
              Effect.logWarning(
                `comment on ${run.repo}#${run.pr} failed: ${GitHub.describe(e)}`,
              ),
            ),
          );
        }
        return yield* HttpServerResponse.json({
          packages: published,
        } satisfies PublishResponse);
      });

    /**
     * Content-addressed upload. Any allowed repository may upload; bytes only
     * become reachable once a verified publication tags them, and untagged
     * objects are swept after a day.
     */
    const uploadTarball = (
      request: HttpServerRequest,
      name: string,
      sha256: string,
    ) =>
      Effect.gen(function* () {
        const contentLength = Number(request.headers["content-length"] ?? 0);
        if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
          return yield* new HttpError({
            status: 400,
            message: "Content-Length is required",
          });
        }
        if (maxSize !== undefined && contentLength > maxSize) {
          return yield* new HttpError({
            status: 413,
            message: `tarball exceeds ${maxSize} bytes`,
          });
        }
        const key = tarballKey(name, sha256);
        const existing = yield* r2.head(key);
        if (existing !== null) {
          return {
            name,
            sha256,
            size: existing.size,
            uploaded: false,
          } satisfies TarballResponse;
        }
        yield* r2
          .put(key, request.stream, {
            contentLength,
            // The route regex already constrained this to 64 hex chars.
            sha256: Result.getOrThrow(Encoding.decodeHex(sha256)),
          })
          .pipe(
            Effect.mapError(
              (e) =>
                new HttpError({
                  status: 400,
                  message: `upload rejected: ${String(e)}`,
                }),
            ),
          );
        return {
          name,
          sha256,
          size: contentLength,
          uploaded: true,
        } satisfies TarballResponse;
      });

    /**
     * Expiry sweep. Tags tied to pull requests are extended while any of
     * those pull requests is open and pinned to the latest close time plus
     * TTL once they all close. Expired tags go away, and tarballs nothing
     * points at are deleted from R2.
     */
    const sweep = Effect.gen(function* () {
      const now = Date.now();
      const ttl = ttlMillis(policy);
      const due = yield* Db.dueLinkedTags(sql, now + SWEEP_LOOKAHEAD_MS);
      if (due.length > 0) {
        const gh = yield* github;
        // One lookup per pull request across every due row.
        const closedAt = new Map<string, number | undefined>();
        for (const ref of new Set(due.flatMap(Db.linkedPrs))) {
          const [repo, number] = ref.split("#");
          const pr = yield* GitHub.getPullRequest(
            gh,
            repo!,
            Number(number),
          ).pipe(
            Effect.catch((e) =>
              Effect.logWarning(
                `pull request ${ref} lookup failed: ${GitHub.describe(e)}`,
              ).pipe(Effect.as(undefined)),
            ),
          );
          if (pr === undefined) continue;
          closedAt.set(
            ref,
            pr.state === "open"
              ? undefined
              : Date.parse(
                  pr.merged_at ?? pr.closed_at ?? new Date(now).toISOString(),
                ),
          );
        }
        for (const row of due) {
          const refs = Db.linkedPrs(row).filter((ref) => closedAt.has(ref));
          if (refs.length === 0) continue;
          // Open pull requests dominate; otherwise the latest close wins.
          const anchor = refs.some((ref) => closedAt.get(ref) === undefined)
            ? now
            : Math.max(...refs.map((ref) => closedAt.get(ref)!));
          const expiresAt = anchor + ttl;
          if (expiresAt !== row.expires_at) {
            yield* Db.setExpiry(sql, row.package, row.tag, expiresAt);
          }
        }
      }

      const removed = yield* Db.deleteExpired(sql, now);
      const referenced = yield* Db.referencedTarballs(sql);
      let deleted = 0;
      for (const { package: pkg, sha256 } of removed) {
        if (!referenced.has(`${pkg}/${sha256}`)) {
          yield* r2.delete(tarballKey(pkg, sha256));
          deleted++;
        }
      }
      // Uploads that never got tagged.
      let cursor: string | undefined;
      do {
        const page = yield* r2.list({ cursor, limit: 500 });
        for (const object of page.objects) {
          const match = object.key.match(/^(.+)\/([a-f0-9]{64})\.tgz$/);
          if (!match) continue;
          const id = `${decodeURIComponent(match[1]!)}/${match[2]}`;
          if (
            !referenced.has(id) &&
            object.uploaded.getTime() < now - ORPHAN_GRACE_MS
          ) {
            yield* r2.delete(object.key);
            deleted++;
          }
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor !== undefined);
      yield* Effect.logInfo(
        `sweep: ${due.length} due, ${removed.length} tags expired, ${deleted} tarballs deleted`,
      );
    });

    yield* Cloudflare.Workers.cron(config.cron, () => sweep);

    const route = Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const host = request.headers.host ?? "localhost";
      const origin = `https://${host}`;
      const url = new URL(request.url, origin);
      const scope = config.aliases[host];
      const method = request.method;

      if (url.pathname.startsWith("/api/")) {
        if (method === "POST" && url.pathname === "/api/publish") {
          const identity = yield* authenticate(request, origin);
          const body = yield* request.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(PublishRequest)),
            Effect.mapError(
              (e) =>
                new HttpError({
                  status: 400,
                  message: `invalid body: ${String(e)}`,
                }),
            ),
          );
          return yield* publish(identity, body, origin);
        }
        const upload = url.pathname.match(
          /^\/api\/tarballs\/(.+)\/([a-f0-9]{64})$/,
        );
        if (method === "PUT" && upload) {
          yield* authenticate(request, origin);
          const name = decodeURIComponent(upload[1]!);
          return yield* HttpServerResponse.json(
            yield* uploadTarball(request, name, upload[2]!),
          );
        }
        if (method === "GET" && url.pathname === "/api/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }
        return yield* new HttpError({ status: 404, message: "not found" });
      }

      if (method !== "GET" && method !== "HEAD") {
        return yield* new HttpError({
          status: 405,
          message: "method not allowed",
        });
      }
      if (url.pathname === "/") {
        return HttpServerResponse.text(
          "Preview package registry. Install with: bun add " +
            `${origin}/<package>@<commit|branch:name|pr:N>\n`,
        );
      }
      const target = parseInstallPath(url.pathname, scope);
      if (target === undefined) {
        return yield* new HttpError({ status: 404, message: "not found" });
      }
      if (target.kind === "tag") {
        const sha256 = yield* Db.resolveTag(sql, target.name, target.tag);
        if (sha256 === undefined) {
          return yield* new HttpError({
            status: 404,
            message: `${target.name}@${target.tag} not found`,
          });
        }
        return HttpServerResponse.redirect(
          `/${encodeName(target.name)}/-/${sha256}.tgz`,
          { status: 302, headers: { "cache-control": "no-store" } },
        );
      }
      const object = yield* r2.get(tarballKey(target.name, target.sha256));
      if (object === null) {
        return yield* new HttpError({
          status: 404,
          message: "tarball not found",
        });
      }
      const headers = {
        "content-type": "application/gzip",
        "content-length": String(object.size),
        "cache-control": "public, max-age=31536000, immutable",
      };
      return method === "HEAD"
        ? HttpServerResponse.empty({ status: 200, headers })
        : HttpServerResponse.stream(object.body, { status: 200, headers });
    });

    return {
      fetch: route.pipe(
        Effect.catchTag("HttpError", (e) =>
          HttpServerResponse.json({ error: e.message }, { status: e.status }),
        ),
        Effect.catchCause((cause) =>
          Effect.logError(cause).pipe(
            Effect.andThen(
              HttpServerResponse.json(
                { error: "internal error" },
                { status: 500 },
              ),
            ),
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(bindings));

/** `kid` from a compact JWT's base64url header, without verifying anything. */
const readKid = (rawHeader: string): string | undefined => {
  const bytes = Encoding.decodeBase64Url(rawHeader);
  if (Result.isFailure(bytes)) return undefined;
  try {
    const header = JSON.parse(new TextDecoder().decode(bytes.success)) as {
      kid?: unknown;
    };
    return typeof header.kid === "string" ? header.kid : undefined;
  } catch {
    return undefined;
  }
};
