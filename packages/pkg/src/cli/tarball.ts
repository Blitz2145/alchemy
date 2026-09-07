import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { packTar, unpackTar, type TarHeader } from "modern-tar";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { DEPENDENCY_SECTIONS, DependencySections } from "./workspace.ts";

export class PackError extends Data.TaggedError("PackError")<{
  readonly dir: string;
  readonly message: string;
}> {}

const PnpmPackOutput = Schema.fromJsonString(
  Schema.Struct({ filename: Schema.String }),
);

/**
 * Immutable tarball URL on the registry. Dependencies between packed
 * packages link to these, so a tarball's bytes depend only on its own
 * source and its dependencies' bytes, never on a commit, and identical
 * builds deduplicate across commits, pull requests, and repositories.
 */
export const tarballUrl = (registry: string, name: string, sha256: string) =>
  `${registry.replace(/\/+$/, "")}/${name}/-/${sha256}.tgz`;

/**
 * Rewrite every dependency on a package in `links` to that package's
 * tarball URL. Returns the rewritten manifest text and the rewrites made.
 */
export const rewriteDependencies = (
  manifestText: string,
  links: ReadonlyMap<string, string>,
) =>
  Effect.gen(function* () {
    const raw = yield* Effect.try({
      try: () => JSON.parse(manifestText) as Record<string, unknown>,
      catch: (cause) =>
        new PackError({
          dir: "",
          message: `package.json is not JSON: ${cause}`,
        }),
    });
    const sections = yield* Schema.decodeUnknownEffect(DependencySections)(raw);
    const rewrites: Array<{ section: string; name: string; url: string }> = [];
    for (const section of DEPENDENCY_SECTIONS) {
      const deps = sections[section];
      if (deps === undefined) continue;
      const next: Record<string, string> = { ...deps };
      for (const name of Object.keys(deps)) {
        const url = links.get(name);
        if (url === undefined) continue;
        next[name] = url;
        rewrites.push({ section, name, url });
      }
      raw[section] = next;
    }
    return { text: `${JSON.stringify(raw, null, 2)}\n`, rewrites };
  });

const EPOCH = new Date(0);

/**
 * Normalize tar headers so identical inputs produce identical bytes:
 * fixed mtime, no ownership, entries sorted by path.
 */
const normalize = (header: TarHeader, size: number): TarHeader => ({
  name: header.name,
  size,
  mode: header.mode,
  type: header.type ?? "file",
  mtime: EPOCH,
  uid: 0,
  gid: 0,
  uname: "",
  gname: "",
  ...(header.linkname !== undefined ? { linkname: header.linkname } : {}),
});

export interface PackedTarball {
  readonly file: string;
  readonly sha256: string;
  readonly size: number;
  readonly rewrites: ReadonlyArray<{
    section: string;
    name: string;
    url: string;
  }>;
}

/**
 * Pack one package with pnpm, rewrite its dependencies on already-packed
 * packages to their tarball URLs, and repack reproducibly into `outDir/file`.
 */
export const packPackage = Effect.fn("packPackage")(function* (options: {
  readonly absDir: string;
  /** Tarball URL of every already-packed dependency, by package name. */
  readonly links: ReadonlyMap<string, string>;
  readonly outDir: string;
  readonly file: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner;
  const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "pkg-pack-" });

  const handle = yield* spawner.spawn(
    ChildProcess.make("pnpm", ["pack", "--json", "--pack-destination", tmp], {
      cwd: options.absDir,
      shell: false,
    }),
  );
  const [exitCode, stdout, stderr] = yield* Effect.all(
    [
      handle.exitCode,
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
    ],
    { concurrency: 3 },
  );
  if (exitCode !== 0) {
    return yield* new PackError({
      dir: options.absDir,
      message: `pnpm pack exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`,
    });
  }
  // pnpm may print progress lines before the JSON document.
  const json = stdout.slice(stdout.indexOf("{"));
  const { filename } = yield* Schema.decodeUnknownEffect(PnpmPackOutput)(json);

  const packed = yield* fs.readFile(path.join(tmp, path.basename(filename)));
  const inflated = yield* Effect.sync(() => gunzipSync(packed));
  const entries = yield* Effect.promise(() => unpackTar(inflated));

  let rewrites: PackedTarball["rewrites"] = [];
  const normalized: Array<{ header: TarHeader; data: Uint8Array }> = [];
  for (const entry of entries.sort((a, b) =>
    a.header.name.localeCompare(b.header.name),
  )) {
    let data = entry.data ?? new Uint8Array();
    if (entry.header.name === "package/package.json") {
      const result = yield* rewriteDependencies(
        new TextDecoder().decode(data),
        options.links,
      ).pipe(
        Effect.mapError(
          (e) => new PackError({ dir: options.absDir, message: String(e) }),
        ),
      );
      rewrites = result.rewrites;
      data = new TextEncoder().encode(result.text);
    }
    normalized.push({ header: normalize(entry.header, data.byteLength), data });
  }

  const tar = yield* Effect.promise(() => packTar(normalized));
  const bytes = yield* Effect.sync(() => gzipSync(tar, { level: 9 }));
  const sha256 = yield* Effect.sync(() =>
    createHash("sha256").update(bytes).digest("hex"),
  );
  yield* fs.writeFile(path.join(options.outDir, options.file), bytes);
  return {
    file: options.file,
    sha256,
    size: bytes.byteLength,
    rewrites,
  } satisfies PackedTarball;
});
