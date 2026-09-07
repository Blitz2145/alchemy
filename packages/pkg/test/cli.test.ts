import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Duration from "effect/Duration";
import { manifestArtifactName, parseRunHeader, runHeader } from "../src/Api.ts";
import { Policy } from "../src/Policy.ts";
import { rewriteDependencies, tarballUrl } from "../src/cli/tarball.ts";
import {
  dependencyLevels,
  expandBraces,
  parseGroup,
} from "../src/cli/workspace.ts";

describe("Policy", () => {
  const policy = Schema.decodeUnknownSync(Policy)({
    repos: ["alchemy-run/alchemy", "alchemy-run/distilled"],
    ttl: Duration.weeks(1),
  });

  test("ttl decodes to a Duration", () => {
    expect(Duration.toMillis(policy.ttl!)).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("workspace", () => {
  test("expandBraces", () => {
    expect(expandBraces("./packages/*")).toEqual(["./packages/*"]);
    expect(expandBraces("./packages/{alchemy, pkg}")).toEqual([
      "./packages/alchemy",
      "./packages/pkg",
    ]);
    expect(expandBraces("./{a,b}/packages/{x,y}")).toEqual([
      "./a/packages/x",
      "./a/packages/y",
      "./b/packages/x",
      "./b/packages/y",
    ]);
  });

  test("parseGroup", () => {
    expect(parseGroup("Alchemy=./packages/*")).toEqual({
      name: "Alchemy",
      pattern: "./packages/*",
    });
    expect(parseGroup("=x")).toBeUndefined();
    expect(parseGroup("Alchemy=")).toBeUndefined();
    expect(parseGroup("Alchemy")).toBeUndefined();
  });
});

describe("tarball", () => {
  test("tarballUrl strips trailing slashes and keeps scopes", () => {
    expect(tarballUrl("https://pkg.ing/", "@alchemy.run/pkg", "abc")).toBe(
      "https://pkg.ing/@alchemy.run/pkg/-/abc.tgz",
    );
  });

  test("dependencyLevels orders dependencies first and rejects cycles", async () => {
    const levels = await Effect.runPromise(
      dependencyLevels(
        new Map([
          ["alchemy", new Set(["core", "runtime", "outside"])],
          ["runtime", new Set(["utils"])],
          ["core", new Set()],
          ["utils", new Set()],
          ["better-auth", new Set(["alchemy"])],
        ]),
      ),
    );
    expect(levels).toEqual([
      ["core", "utils"],
      ["runtime"],
      ["alchemy"],
      ["better-auth"],
    ]);
    const cycle = await Effect.runPromise(
      Effect.result(
        dependencyLevels(
          new Map([
            ["a", new Set(["b"])],
            ["b", new Set(["a"])],
          ]),
        ),
      ),
    );
    expect(cycle._tag).toBe("Failure");
  });

  test("rewriteDependencies only touches published packages", async () => {
    const manifest = JSON.stringify({
      name: "alchemy",
      dependencies: {
        "@distilled.cloud/core": "1.0.0-rc.8",
        effect: "^4.0.0",
      },
      peerDependencies: { "@alchemy.run/frontend-frameworks": "2.0.0" },
      exports: { ".": "./src/index.ts" },
    });
    const links = new Map([
      [
        "@distilled.cloud/core",
        "https://pkg.ing/@distilled.cloud/core/-/aa.tgz",
      ],
      [
        "@alchemy.run/frontend-frameworks",
        "https://pkg.ing/@alchemy.run/frontend-frameworks/-/bb.tgz",
      ],
    ]);
    const result = await Effect.runPromise(
      rewriteDependencies(manifest, links),
    );
    const rewritten = JSON.parse(result.text);
    expect(rewritten.dependencies).toEqual({
      "@distilled.cloud/core": "https://pkg.ing/@distilled.cloud/core/-/aa.tgz",
      effect: "^4.0.0",
    });
    expect(rewritten.peerDependencies).toEqual({
      "@alchemy.run/frontend-frameworks":
        "https://pkg.ing/@alchemy.run/frontend-frameworks/-/bb.tgz",
    });
    expect(rewritten.exports).toEqual({ ".": "./src/index.ts" });
    expect(result.rewrites.map((r) => r.name).sort()).toEqual([
      "@alchemy.run/frontend-frameworks",
      "@distilled.cloud/core",
    ]);
  });
});

describe("Api", () => {
  test("run header round trip", () => {
    const value = runHeader("alchemy-run/alchemy", 34124813301, 2);
    expect(value).toBe("alchemy-run/alchemy#34124813301:2");
    expect(parseRunHeader(value)).toEqual({
      repo: "alchemy-run/alchemy",
      runId: 34124813301,
      attempt: 2,
    });
    expect(parseRunHeader("nope")).toBeUndefined();
    expect(parseRunHeader("alchemy-run/alchemy#x:1")).toBeUndefined();
  });

  test("manifest artifact name carries the manifest hash", () => {
    expect(manifestArtifactName("ab".repeat(32))).toBe(
      `pkg-manifest-${"ab".repeat(32)}`,
    );
  });
});
