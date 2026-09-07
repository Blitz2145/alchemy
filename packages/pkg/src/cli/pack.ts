import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  MANIFEST_FILE,
  ManifestJson,
  type Manifest,
  type ManifestPackage,
} from "../Manifest.ts";
import * as Git from "./git.ts";
import { packPackage } from "./tarball.ts";
import { discover, WorkspaceError, type Group } from "./workspace.ts";

const PullRequestEvent = Schema.fromJsonString(
  Schema.Struct({
    pull_request: Schema.optionalKey(
      Schema.Struct({ head: Schema.Struct({ sha: Schema.String }) }),
    ),
  }),
);

/**
 * The pull request head commit when running under a GitHub Actions
 * `pull_request` event, read from the event payload. `undefined` elsewhere.
 * On that event the default checkout is a synthetic merge commit, which the
 * registry would reject because it does not match the run's head.
 */
const pullRequestHead = Effect.gen(function* () {
  const event = process.env.GITHUB_EVENT_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (event !== "pull_request" || !eventPath) return undefined;
  const fs = yield* FileSystem.FileSystem;
  const payload = yield* fs
    .readFileString(eventPath)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(PullRequestEvent)));
  return payload.pull_request?.head.sha;
});

export interface PackOptions {
  readonly cwd: string;
  readonly groups: ReadonlyArray<Group>;
  readonly registry: string;
  readonly out: string;
}

/** Artifact-safe tarball file name for a package. */
const tarballFile = (name: string) =>
  `${name.replace(/^@/, "").replace(/\//g, "-")}.tgz`;

/**
 * Pack every discovered package into `out` with a manifest describing each
 * tarball. Nothing here talks to the registry.
 */
export const pack = Effect.fn("pack")(function* (options: PackOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const root = yield* Git.toplevel(options.cwd);
  const head = yield* Git.head(root);
  const prHead = yield* pullRequestHead;
  if (prHead !== undefined && prHead !== head) {
    return yield* new WorkspaceError({
      message:
        `HEAD is ${head} but the pull request head is ${prHead}. ` +
        "Check out github.event.pull_request.head.sha before packing so tarballs are addressed by a commit that exists on the pull request.",
    });
  }
  const packages = yield* discover(options.cwd, options.groups);
  if (packages.length === 0) {
    yield* Console.log("No publishable packages matched.");
    return undefined;
  }

  // The registry tags everything a run publishes with the run's head commit,
  // packages inside submodules included, so every rewritten dependency points
  // at the root repository's HEAD.
  const published = new Map(packages.map((pkg) => [pkg.name, head]));

  const outDir = path.resolve(options.cwd, options.out);
  yield* fs.remove(outDir, { recursive: true, force: true });
  yield* fs.makeDirectory(outDir, { recursive: true });

  const entries = yield* Effect.forEach(
    packages,
    Effect.fn(function* (pkg) {
      const packed = yield* packPackage({
        absDir: pkg.absDir,
        published,
        registry: options.registry,
        outDir,
        file: tarballFile(pkg.name),
      }).pipe(Effect.scoped);
      const lines = [
        `${pkg.name}@${pkg.version} ${packed.sha256.slice(0, 12)} ${packed.size} bytes`,
        ...packed.rewrites.map((r) => `  ${r.section}.${r.name} -> ${r.url}`),
      ];
      yield* Console.log(lines.join("\n"));
      return {
        name: pkg.name,
        version: pkg.version,
        dir: pkg.dir,
        group: pkg.group,
        file: packed.file,
        sha256: packed.sha256,
        size: packed.size,
      } satisfies ManifestPackage;
    }),
    { concurrency: 4 },
  );

  const manifest: Manifest = {
    version: 1,
    registry: options.registry.replace(/\/+$/, ""),
    head,
    packages: entries,
  };
  yield* fs.writeFileString(
    path.join(outDir, MANIFEST_FILE),
    `${Schema.encodeSync(ManifestJson)(manifest)}\n`,
  );
  yield* Console.log(
    `Packed ${entries.length} package(s) into ${path.relative(options.cwd, outDir) || "."}`,
  );
  return manifest;
});
