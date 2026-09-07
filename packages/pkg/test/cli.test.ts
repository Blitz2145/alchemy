import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Duration from "effect/Duration";
import { parseRunHeader, runHeader } from "../src/Api.ts";
import { Policy, publishWorkflowRef } from "../src/Policy.ts";
import { installUrl, rewriteDependencies } from "../src/cli/tarball.ts";
import { expandBraces, parseGroup } from "../src/cli/workspace.ts";

describe("Policy", () => {
  const policy = Schema.decodeUnknownSync(Policy)({
    repos: ["alchemy-run/alchemy", "alchemy-run/distilled"],
    ttl: Duration.weeks(1),
  });

  test("ttl decodes to a Duration and workflow ref defaults", () => {
    expect(Duration.toMillis(policy.ttl!)).toBe(7 * 24 * 60 * 60 * 1000);
    expect(publishWorkflowRef(policy, "alchemy-run/alchemy")).toBe(
      "alchemy-run/alchemy/.github/workflows/pkg.yml@",
    );
    expect(
      publishWorkflowRef({ ...policy, workflow: "publish.yml" }, "a/b"),
    ).toBe("a/b/.github/workflows/publish.yml@");
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
  test("installUrl strips trailing slashes and keeps scopes", () => {
    expect(installUrl("https://pkg.ing/", "@alchemy.run/pkg", "abc")).toBe(
      "https://pkg.ing/@alchemy.run/pkg@abc",
    );
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
    const published = new Map([
      ["@distilled.cloud/core", "d15t1ll3d"],
      ["@alchemy.run/frontend-frameworks", "a1ch3my"],
    ]);
    const result = await Effect.runPromise(
      rewriteDependencies(manifest, published, "https://pkg.ing"),
    );
    const rewritten = JSON.parse(result.text);
    expect(rewritten.dependencies).toEqual({
      "@distilled.cloud/core":
        "https://pkg.ing/@distilled.cloud/core@d15t1ll3d",
      effect: "^4.0.0",
    });
    expect(rewritten.peerDependencies).toEqual({
      "@alchemy.run/frontend-frameworks":
        "https://pkg.ing/@alchemy.run/frontend-frameworks@a1ch3my",
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
});
