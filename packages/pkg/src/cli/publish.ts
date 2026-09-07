import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {
  ErrorResponse,
  MissingResponse,
  PublishRequest,
  PublishResponse,
  RUN_HEADER,
  runHeader,
  TarballResponse,
  tarballPath,
} from "../Api.ts";
import type { Manifest } from "../Manifest.ts";
import { pack, type PackOptions } from "./pack.ts";

export class PublishError extends Data.TaggedError("PublishError")<{
  readonly message: string;
}> {}

export type PublishOptions = PackOptions;

const IdToken = Schema.Struct({ value: Schema.String });

/**
 * The GitHub Actions run this job belongs to, from the runner's environment.
 */
const currentRun = Effect.gen(function* () {
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = Number(process.env.GITHUB_RUN_ID);
  const attempt = Number(process.env.GITHUB_RUN_ATTEMPT ?? "1");
  if (!repo || !Number.isSafeInteger(runId)) {
    return yield* new PublishError({
      message: "pkg publish must run inside a GitHub Actions job",
    });
  }
  return { repo, runId, attempt };
});

/**
 * Mint a GitHub Actions OIDC token for the registry, or `undefined` when the
 * runner offers none. GitHub grants no token to pull requests from forks;
 * those jobs are verified by the registry through the GitHub API instead.
 */
const idToken = (audience: string) =>
  Effect.gen(function* () {
    const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!requestUrl || !requestToken) return undefined;
    const http = yield* HttpClient.HttpClient;
    return yield* http
      .execute(
        HttpClientRequest.get(requestUrl).pipe(
          HttpClientRequest.appendUrlParam("audience", audience),
          HttpClientRequest.bearerToken(requestToken),
        ),
      )
      .pipe(
        Effect.flatMap((r) => r.json),
        Effect.flatMap(Schema.decodeUnknownEffect(IdToken)),
        Effect.map((r): string | undefined => r.value),
        Effect.catch((e) =>
          Console.warn(
            `OIDC token unavailable, falling back to run verification: ${e}`,
          ).pipe(Effect.as(undefined)),
        ),
      );
  });

const bodyJson = (
  what: string,
  response: HttpClientResponse.HttpClientResponse,
) =>
  Effect.gen(function* () {
    const text = yield* response.text.pipe(
      Effect.mapError((e) => new PublishError({ message: `${what}: ${e}` })),
    );
    return yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () =>
        new PublishError({
          message: `${what}: ${response.status} ${text.slice(0, 500)}`,
        }),
    });
  });

const decodeResponse = <S extends Schema.Top>(
  what: string,
  response: HttpClientResponse.HttpClientResponse,
  schema: S,
): Effect.Effect<S["Type"], PublishError, S["DecodingServices"]> =>
  Effect.gen(function* () {
    const json = yield* bodyJson(what, response);
    if (response.status >= 400) {
      const error = Schema.decodeUnknownOption(ErrorResponse)(json);
      return yield* new PublishError({
        message: `${what}: ${response.status} ${error._tag === "Some" ? error.value.error : JSON.stringify(json).slice(0, 500)}`,
      });
    }
    return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
      Effect.mapError(
        (e) =>
          new PublishError({ message: `${what}: unexpected response: ${e}` }),
      ),
    );
  });

/**
 * Pack the workspace and publish it from the current GitHub Actions job.
 * Every request names the run; same-repo jobs also carry an OIDC token. The
 * registry verifies the run and either reports the tarballs it lacks, which
 * are uploaded before trying again, or writes the tags.
 */
export const publish = Effect.fn("publish")(function* (
  options: PublishOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const registry = options.registry.replace(/\/+$/, "");
  const run = yield* currentRun;

  const manifest = yield* pack(options);
  if (manifest === undefined) return undefined;
  const dir = path.resolve(options.cwd, options.out);

  const send = (request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      const token = yield* idToken(registry);
      const named = request.pipe(
        HttpClientRequest.setHeader(
          RUN_HEADER,
          runHeader(run.repo, run.runId, run.attempt),
        ),
      );
      return yield* http
        .execute(
          token === undefined
            ? named
            : named.pipe(HttpClientRequest.bearerToken(token)),
        )
        .pipe(
          Effect.mapError(
            (e) => new PublishError({ message: `request failed: ${e}` }),
          ),
        );
    });

  type Outcome =
    | { readonly missing: MissingResponse["missing"] }
    | { readonly published: PublishResponse };

  const attempt: Effect.Effect<Outcome, PublishError, HttpClient.HttpClient> =
    Effect.gen(function* () {
      const response = yield* send(
        HttpClientRequest.post(`${registry}/api/publish`).pipe(
          HttpClientRequest.bodyJsonUnsafe(
            Schema.encodeUnknownSync(PublishRequest)({ manifest }),
          ),
        ),
      );
      if (response.status === 409) {
        const json = yield* bodyJson("publish", response);
        const missing = Schema.decodeUnknownOption(MissingResponse)(json);
        if (missing._tag === "Some") {
          return { missing: missing.value.missing } satisfies Outcome;
        }
      }
      return {
        published: yield* decodeResponse("publish", response, PublishResponse),
      } satisfies Outcome;
    });

  const upload = (pkg: Manifest["packages"][number]) =>
    Effect.gen(function* () {
      const bytes = yield* fs.readFile(path.join(dir, pkg.file));
      const result = yield* send(
        HttpClientRequest.put(
          `${registry}${tarballPath(pkg.name, pkg.sha256)}`,
        ).pipe(
          HttpClientRequest.setHeader(
            "content-length",
            String(bytes.byteLength),
          ),
          HttpClientRequest.bodyUint8Array(bytes, "application/gzip"),
        ),
      ).pipe(
        Effect.flatMap((r) =>
          decodeResponse(`upload ${pkg.name}`, r, TarballResponse),
        ),
      );
      yield* Console.log(
        `${result.uploaded ? "Uploaded" : "Reused"} ${pkg.name} (${pkg.sha256.slice(0, 12)}, ${pkg.size} bytes)`,
      );
    });

  let outcome = yield* attempt;
  if ("missing" in outcome) {
    yield* Console.log(
      `${outcome.missing.length} of ${manifest.packages.length} tarball(s) to upload`,
    );
    const wanted = new Set(
      outcome.missing.map((ref) => `${ref.name}@${ref.sha256}`),
    );
    yield* Effect.forEach(
      manifest.packages.filter((pkg) =>
        wanted.has(`${pkg.name}@${pkg.sha256}`),
      ),
      upload,
      { concurrency: 4 },
    );
    outcome = yield* attempt;
    if ("missing" in outcome) {
      return yield* new PublishError({
        message: `registry still reports missing tarballs after upload: ${outcome.missing.map((r) => r.name).join(", ")}`,
      });
    }
  }

  for (const pkg of outcome.published.packages) {
    yield* Console.log(`${pkg.name}: ${pkg.url}  [${pkg.tags.join(", ")}]`);
  }
  return outcome.published;
});
