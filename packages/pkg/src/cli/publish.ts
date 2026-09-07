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
  TarballResponse,
  tarballPath,
} from "../Api.ts";
import { MANIFEST_FILE, ManifestJson, type Manifest } from "../Manifest.ts";

export class PublishError extends Data.TaggedError("PublishError")<{
  readonly message: string;
}> {}

export interface PublishOptions {
  readonly cwd: string;
  readonly dir: string;
  readonly registry: string;
  readonly runId: number;
}

const IdToken = Schema.Struct({ value: Schema.String });

/**
 * Mint a GitHub Actions OIDC token for the registry. The request URL and
 * bearer token are injected by the runner when the job has `id-token: write`.
 */
const idToken = (audience: string) =>
  Effect.gen(function* () {
    const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!requestUrl || !requestToken) {
      return yield* new PublishError({
        message:
          "no OIDC token available: run inside GitHub Actions with `id-token: write`",
      });
    }
    const http = yield* HttpClient.HttpClient;
    const response = yield* http
      .execute(
        HttpClientRequest.get(requestUrl).pipe(
          HttpClientRequest.appendUrlParam("audience", audience),
          HttpClientRequest.bearerToken(requestToken),
        ),
      )
      .pipe(Effect.flatMap((r) => r.json))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(IdToken)))
      .pipe(
        Effect.mapError(
          (e) =>
            new PublishError({ message: `OIDC token request failed: ${e}` }),
        ),
      );
    return response.value;
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
 * Publish a `pkg pack` artifact. The registry verifies the build run and
 * either reports the tarballs it lacks, which are uploaded before trying
 * again, or writes the tags.
 */
export const publish = Effect.fn("publish")(function* (
  options: PublishOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const registry = options.registry.replace(/\/+$/, "");
  const dir = path.resolve(options.cwd, options.dir);

  const manifest = yield* fs
    .readFileString(path.join(dir, MANIFEST_FILE))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ManifestJson)));
  if (manifest.registry !== registry) {
    return yield* new PublishError({
      message: `artifact was packed for ${manifest.registry}, not ${registry}`,
    });
  }

  const send = (request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      const token = yield* idToken(registry);
      return yield* http
        .execute(request.pipe(HttpClientRequest.bearerToken(token)))
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
            Schema.encodeUnknownSync(PublishRequest)({
              runId: options.runId,
              manifest,
            }),
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
