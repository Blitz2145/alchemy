import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class WorkspaceError extends Data.TaggedError("WorkspaceError")<{
  readonly message: string;
}> {}

/** A `NAME=GLOB` group flag, e.g. `Alchemy=./packages/*`. */
export interface Group {
  readonly name: string;
  readonly pattern: string;
}

export const parseGroup = (spec: string): Group | undefined => {
  const index = spec.indexOf("=");
  if (index <= 0 || index === spec.length - 1) return undefined;
  return {
    name: spec.slice(0, index).trim(),
    pattern: spec.slice(index + 1).trim(),
  };
};

/** The subset of `package.json` the CLI reads. Extra keys are preserved on the raw object. */
export const PackageJson = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
  private: Schema.optionalKey(Schema.Boolean),
});

export const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

const DependencyMap = Schema.optionalKey(
  Schema.Record(Schema.String, Schema.String),
);

export const DependencySections = Schema.Struct({
  dependencies: DependencyMap,
  devDependencies: DependencyMap,
  peerDependencies: DependencyMap,
  optionalDependencies: DependencyMap,
});

/**
 * Order packages so every package comes after the packed packages it
 * depends on, grouped into levels that can be packed concurrently. Fails on
 * a cycle, since a tarball cannot link to a dependency that links back.
 */
export const dependencyLevels = (
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
): Effect.Effect<string[][], WorkspaceError> => {
  const remaining = new Map(
    [...dependencies].map(([name, deps]) => [
      name,
      new Set([...deps].filter((dep) => dependencies.has(dep))),
    ]),
  );
  const levels: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter(([, deps]) => deps.size === 0)
      .map(([name]) => name)
      .sort();
    if (ready.length === 0) {
      return Effect.fail(
        new WorkspaceError({
          message: `Dependency cycle among packed packages: ${[...remaining.keys()].sort().join(", ")}`,
        }),
      );
    }
    for (const name of ready) remaining.delete(name);
    for (const deps of remaining.values()) {
      for (const name of ready) deps.delete(name);
    }
    levels.push(ready);
  }
  return Effect.succeed(levels);
};

export interface WorkspacePackage {
  readonly name: string;
  readonly version: string;
  /** Relative to the workspace root, POSIX separators. */
  readonly dir: string;
  readonly absDir: string;
  readonly group: string;
}

/**
 * Expand one level of `{a,b,c}` alternatives into plain patterns, so
 * `./packages/{alchemy,pkg}` lists exactly those two directories.
 */
export const expandBraces = (pattern: string): string[] => {
  const match = pattern.match(/^(.*?)\{([^{}]*)\}(.*)$/);
  if (!match) return [pattern];
  return match[2]!
    .split(",")
    .map((alternative) => alternative.trim())
    .filter((alternative) => alternative.length > 0)
    .flatMap((alternative) =>
      expandBraces(`${match[1]}${alternative}${match[3]}`),
    );
};

/**
 * Expand a directory glob. `*` is supported as a whole path segment and
 * `{a,b}` as a list of alternatives, which covers `./packages/*` and
 * `./submodules/x/packages/{core,aws}`. Matches are directories only.
 */
const expand = Effect.fn("expandGlob")(function* (cwd: string, glob: string) {
  const results: string[] = [];
  for (const pattern of expandBraces(glob)) {
    results.push(...(yield* expandPattern(cwd, pattern)));
  }
  return [...new Set(results)];
});

const expandPattern = Effect.fn("expandPattern")(function* (
  cwd: string,
  pattern: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (pattern.includes("**")) {
    return yield* new WorkspaceError({
      message: `Unsupported pattern ${JSON.stringify(pattern)}: only a single "*" segment is supported`,
    });
  }
  const segments = pattern.split("/").filter((s) => s !== "" && s !== ".");
  let current: string[] = [cwd];
  for (const segment of segments) {
    const next: string[] = [];
    for (const base of current) {
      if (segment === "*") {
        const entries = yield* fs.readDirectory(base);
        for (const entry of entries.sort()) {
          const candidate = path.join(base, entry);
          const stat = yield* fs.stat(candidate);
          if (stat.type === "Directory") next.push(candidate);
        }
      } else if (segment.includes("*")) {
        return yield* new WorkspaceError({
          message: `Unsupported pattern ${JSON.stringify(pattern)}: "*" must be a whole path segment`,
        });
      } else {
        const candidate = path.join(base, segment);
        if (yield* fs.exists(candidate)) next.push(candidate);
      }
    }
    current = next;
  }
  return current;
});

/**
 * Discover publishable packages under each group's pattern. Private packages
 * and directories without a named `package.json` are skipped. A package
 * name appearing under two groups is an error.
 */
export const discover = Effect.fn("discoverPackages")(function* (
  cwd: string,
  groups: ReadonlyArray<Group>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(PackageJson));
  const found = new Map<string, WorkspacePackage>();
  for (const group of groups) {
    for (const absDir of yield* expand(cwd, group.pattern)) {
      const manifestPath = path.join(absDir, "package.json");
      if (!(yield* fs.exists(manifestPath))) continue;
      const manifest = yield* decode(yield* fs.readFileString(manifestPath));
      if (manifest.private || manifest.name === undefined) continue;
      const existing = found.get(manifest.name);
      if (existing !== undefined) {
        return yield* new WorkspaceError({
          message: `Package ${manifest.name} found in both ${existing.dir} and ${path.relative(cwd, absDir)}`,
        });
      }
      found.set(manifest.name, {
        name: manifest.name,
        version: manifest.version ?? "0.0.0",
        dir: path.relative(cwd, absDir).split(path.sep).join("/"),
        absDir,
        group: group.name,
      });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
});
