import * as Cloudflare from "alchemy/Cloudflare";
import * as SQL from "alchemy/SQL/D1";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  manifestArtifactName,
  MissingResponse,
  parseRunHeader,
  PublishRequest,
  PublishResponse,
  RUN_HEADER,
  TarballResponse,
} from "../Api.ts";
import { ManifestJson, type ManifestPackage } from "../Api.ts";
import type { Policy } from "../Api.ts";
import {
  APP_ID_ENV,
  COMMENT_MARKER,
  ORPHAN_GRACE_MS,
  PRIVATE_KEY_ENV,
  SWEEP_LOOKAHEAD_MS,
  type RegistryConfig,
} from "../Api.ts";
import { importPrivateKey, sha256Hex } from "./GitHub.ts";
import * as Db from "./Db.ts";
import * as GitHub from "./GitHub.ts";

/** Content-addressed tarballs, keyed `<encoded name>/<sha256>.tgz`. */
export const Tarballs = Cloudflare.R2.Bucket("PkgTarballs");

// The migrations ship inside this package. `import.meta.url` is a file URL
// during plan/deploy and absent or opaque inside the isolate, where the
// resource declaration is only evaluated for its binding.
const migrationsDir =
  typeof import.meta.url === "string" && import.meta.url.startsWith("file:")
    ? decodeURIComponent(new URL("../../migrations", import.meta.url).pathname)
    : undefined;

/** Publications, tags, and tarball bookkeeping. */
export const Index = Cloudflare.D1.Database("PkgIndex", {
  migrations: migrationsDir,
});

export const tarballKey = (name: string, sha256: string) =>
  `${encodeURIComponent(name)}/${sha256}.tgz`;

/** A failure that maps directly to an HTTP response. */
export class HttpError extends Data.TaggedError("HttpError")<{
  readonly status: number;
  readonly message: string;
}> {}

/** The run a request says it comes from. A hint until GitHub confirms it. */
interface RunRef {
  readonly repo: string;
  readonly runId: number;
  readonly attempt: number;
}

/** What GitHub says about a run. */
interface Run extends RunRef {
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

/** How long a resolved run is reused for uploads before asking GitHub again. */
const RUN_CACHE_MS = 60_000;

const ttlMillis = (policy: Policy) =>
  Duration.toMillis(policy.ttl ?? Duration.weeks(1));

/**
 * Parse `/<name>/<tag>` and `/<name>/-/<sha256>.tgz`. Scoped names take
 * two segments; the tag is everything after the name and may itself contain
 * `/` and `:`.
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
  const segments = path.split("/");
  const nameLength = path.startsWith("@") ? 2 : 1;
  const name = segments.slice(0, nameLength).join("/");
  const tag = segments.slice(nameLength).join("/");
  if (segments.length <= nameLength || name === "" || tag === "") {
    return undefined;
  }
  return { kind: "tag", name: qualify(name, scope), tag };
};

const qualify = (name: string, scope: string | undefined) =>
  scope !== undefined && !name.startsWith("@") ? `${scope}/${name}` : name;

/**
 * Tags every package in a publication receives, all derived from the run:
 * its head commit, the short commit, `pr:N` for pull requests, and
 * `branch:<name>` for pushes and same-repo pull requests.
 */
const tagsFor = (run: Run): string[] => {
  const tags = [run.headSha, run.headSha.slice(0, SHORT)];
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

const CHECK_NAME = "Preview packages";

export const make = (config: RegistryConfig) =>
  Effect.gen(function* () {
    const r2 = yield* Cloudflare.R2.ReadWriteBucket(Tarballs);
    const d1 = yield* Cloudflare.D1.QueryDatabase(Index);
    const sql = yield* SQL.D1(d1);
    const http = yield* HttpClient.HttpClient;
    const policy = config.policy;
    const maxSize =
      policy.maxPackageSize === undefined
        ? undefined
        : FileSystem.Size(policy.maxPackageSize);

    // Isolate-scoped caches of plain values: the imported App key and the
    // runs recently confirmed in progress. Neither is I/O-backed.
    let appKey: CryptoKey | undefined;
    const runs = new Map<string, { run: Run; at: number }>();

    const github = Effect.gen(function* () {
      if (appKey === undefined) {
        const pem = yield* Config.redacted(PRIVATE_KEY_ENV);
        appKey = yield* importPrivateKey(Redacted.value(pem));
      }
      return {
        http,
        apiUrl: config.github.apiUrl,
        appId: yield* Config.string(APP_ID_ENV),
        key: appKey,
      } satisfies GitHub.GitHubOptions;
    });

    const upstream = (e: {
      readonly _tag: string;
      readonly message?: string;
    }) => new HttpError({ status: 502, message: GitHub.describe(e) });

    /** The run a request names. Only allowed repositories are looked up at all. */
    const runRef = (request: HttpServerRequest) =>
      Effect.gen(function* () {
        const ref = parseRunHeader(request.headers[RUN_HEADER] ?? "");
        if (ref === undefined) {
          return yield* new HttpError({
            status: 400,
            message: `${RUN_HEADER} header is required`,
          });
        }
        if (!policy.repos.includes(ref.repo)) {
          return yield* new HttpError({
            status: 403,
            message: `${ref.repo} may not publish`,
          });
        }
        return ref;
      });

    /**
     * Resolve a run through GitHub; nothing about it is trusted from the
     * client. The run must be in progress, since requests come from inside
     * it. Recently resolved runs are reused so uploads do not repeat the
     * lookup.
     */
    const resolveRun = (ref: RunRef) =>
      Effect.gen(function* () {
        const key = `${ref.repo}#${ref.runId}:${ref.attempt}`;
        const cached = runs.get(key);
        if (
          cached !== undefined &&
          (yield* Clock.currentTimeMillis) - cached.at < RUN_CACHE_MS
        ) {
          return cached.run;
        }
        const gh = yield* github;
        const data = yield* GitHub.getRun(gh, ref.repo, ref.runId).pipe(
          Effect.mapError(upstream),
        );
        if (
          data.status !== "in_progress" ||
          (data.run_attempt !== undefined && data.run_attempt !== ref.attempt)
        ) {
          return yield* new HttpError({
            status: 409,
            message: "run is not in progress",
          });
        }
        if (data.event !== "push" && data.event !== "pull_request") {
          return yield* new HttpError({
            status: 400,
            message: `unsupported event ${data.event}`,
          });
        }
        let pr: number | null = null;
        if (data.event === "pull_request") {
          const pulls = yield* GitHub.pullRequestsForCommit(
            gh,
            ref.repo,
            data.head_sha,
          ).pipe(Effect.mapError(upstream));
          const first = pulls[0];
          if (first === undefined) {
            return yield* new HttpError({
              status: 404,
              message: `no pull request has head ${data.head_sha}`,
            });
          }
          pr = first.number;
        }
        const run: Run = {
          ...ref,
          headSha: data.head_sha,
          headBranch: data.head_branch,
          headRepo:
            data.head_repository?.full_name ?? data.repository.full_name,
          pr,
        };
        runs.set(key, { run, at: yield* Clock.currentTimeMillis });
        return run;
      });

    /**
     * The proof. The job uploaded the manifest as an artifact of its run,
     * named by the manifest's hash. Only the job can add artifacts to the
     * run, and GitHub reports the run's artifacts to the App, so a matching
     * name means this run vouched for exactly this manifest text.
     */
    const requireVouched = (run: Run, manifestText: string) =>
      Effect.gen(function* () {
        const expected = manifestArtifactName(yield* sha256Hex(manifestText));
        const gh = yield* github;
        const artifacts = yield* GitHub.listRunArtifacts(
          gh,
          run.repo,
          run.runId,
        ).pipe(Effect.mapError(upstream));
        if (!artifacts.some((a) => a.name === expected && !a.expired)) {
          return yield* new HttpError({
            status: 403,
            message: `run ${run.runId} has not vouched for this manifest (no artifact ${expected})`,
          });
        }
      });

    const validatePackage = (pkg: ManifestPackage) =>
      maxSize !== undefined && BigInt(pkg.size) > maxSize
        ? Effect.fail(
            new HttpError({
              status: 413,
              message: `${pkg.name} exceeds ${maxSize} bytes`,
            }),
          )
        : Effect.void;

    const publish = (ref: RunRef, body: PublishRequest, origin: string) =>
      Effect.gen(function* () {
        const run = yield* resolveRun(ref);
        yield* requireVouched(run, body.manifest);
        const manifest = yield* Schema.decodeUnknownEffect(ManifestJson)(
          body.manifest,
        ).pipe(
          Effect.mapError(
            (e) =>
              new HttpError({
                status: 400,
                message: `invalid manifest: ${String(e)}`,
              }),
          ),
        );
        const packages = manifest.packages;
        yield* Effect.forEach(packages, validatePackage, { discard: true });

        const missing = yield* Effect.filter(
          packages,
          (pkg) =>
            r2
              .head(tarballKey(pkg.name, pkg.sha256))
              .pipe(Effect.map((object) => object === null)),
          { concurrency: 8 },
        ).pipe(
          Effect.map((packages) =>
            packages.map(({ name, sha256 }) => ({ name, sha256 })),
          ),
        );
        if (missing.length > 0) {
          return yield* HttpServerResponse.json(
            { missing } satisfies MissingResponse,
            { status: 409 },
          );
        }

        const now = yield* Clock.currentTimeMillis;
        const expiresAt = now + ttlMillis(policy);
        const prs = run.pr !== null ? [`${run.repo}#${run.pr}`] : [];
        const tags = tagsFor(run);
        const published = yield* Effect.forEach(
          packages,
          Effect.fn(function* (pkg) {
            yield* Effect.forEach(
              tags,
              (tag) =>
                Db.upsertTag(sql, {
                  package: pkg.name,
                  tag,
                  sha256: pkg.sha256,
                  expiresAt,
                  prs,
                }),
              { discard: true },
            );
            return {
              name: pkg.name,
              group: pkg.group,
              url: `${origin}/${pkg.name}/${run.headSha.slice(0, SHORT)}`,
              tags,
            };
          }),
        );

        const gh = yield* github;
        // A check on the commit itself, so the install lines are visible on
        // pushes and on fork pull requests alike.
        yield* GitHub.createCheckRun(gh, run.repo, {
          headSha: run.headSha,
          name: CHECK_NAME,
          title: `${packages.length} package(s) published`,
          summary: GitHub.renderInstalls(origin, run, packages),
          detailsUrl: origin,
        }).pipe(
          Effect.catch((e) =>
            Effect.logWarning(
              `check run on ${run.repo}@${run.headSha} failed: ${GitHub.describe(e)}`,
            ),
          ),
        );
        if (run.pr !== null) {
          const body = GitHub.renderComment(origin, run, packages, {
            publishedAt: now,
            expiresAt,
          });
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
     * Content-addressed upload. Any in-progress run of an allowed repository
     * may upload; bytes only become reachable once a vouched manifest tags
     * them, and untagged objects are swept after a day.
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
        if (maxSize !== undefined && BigInt(contentLength) > maxSize) {
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
      const now = yield* Clock.currentTimeMillis;
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
          const ref = yield* runRef(request);
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
          return yield* publish(ref, body, origin);
        }
        const upload = url.pathname.match(
          /^\/api\/tarballs\/(.+)\/([a-f0-9]{64})$/,
        );
        if (method === "PUT" && upload) {
          yield* resolveRun(yield* runRef(request));
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
            `${origin}/<package>/<commit|branch:name|pr:N>\n`,
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
        return HttpServerResponse.redirect(`/${target.name}/-/${sha256}.tgz`, {
          status: 302,
          headers: { "cache-control": "no-store" },
        });
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
