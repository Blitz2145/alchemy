import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Duration from "effect/Duration";
import { manifestArtifactName, parseRunHeader, runHeader } from "../src/Api.ts";
import { Policy } from "../src/Api.ts";
import { rewriteDependencies, tarballUrl } from "../src/cli/pack.ts";
import { dependencyLevels, expandBraces, parseGroup } from "../src/cli/pack.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { publish } from "../src/cli/publish.ts";
import type { Manifest } from "../src/Api.ts";

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
    expect(Object.keys(rewritten)).toEqual(Object.keys(JSON.parse(manifest)));
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

const env = {
  GITHUB_REPOSITORY: "alchemy-run/alchemy",
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "2",
};
const previous = Object.fromEntries(
  Object.keys(env).map((key) => [key, process.env[key]]),
);
beforeAll(() => Object.assign(process.env, env));
afterAll(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const manifest: Manifest = {
  version: 1,
  registry: "https://pkg.ing",
  head: "abcdef0123456789",
  packages: ["alchemy", "@alchemy.run/pkg"].map((name, index) => ({
    name,
    version: "1.0.0",
    group: "Alchemy",
    dir: `packages/${index}`,
    file: `${index}.tgz`,
    sha256: String(index).repeat(64),
    size: 3,
  })),
};
const missing = { missing: [manifest.packages[1]!] };
const published = {
  packages: manifest.packages.map(({ name, group }) => ({
    name,
    group,
    url: `https://pkg.ing/${name}/abcdef0`,
    tags: ["abcdef0"],
  })),
};

for (const scenario of [
  "already present",
  "upload",
  "still missing",
  "rejected",
] as const) {
  test(`publish: ${scenario}`, async () => {
    const requests: string[] = [];
    const reads: string[] = [];
    let attempts = 0;
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(`${request.method} ${request.url}`);
        expect(request.headers["x-github-run"]).toBe(
          "alchemy-run/alchemy#123:2",
        );
        if (request.method === "PUT") {
          expect(request.headers["content-length"]).toBe("3");
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              ...manifest.packages[1],
              uploaded: true,
            }),
          );
        }
        attempts++;
        const response =
          scenario === "rejected"
            ? Response.json(
                { error: "run is not in progress" },
                { status: 409 },
              )
            : scenario === "still missing" ||
                (scenario === "upload" && attempts === 1)
              ? Response.json(missing, { status: 409 })
              : Response.json(published);
        return HttpClientResponse.fromWeb(request, response);
      }),
    );
    const result = await Effect.runPromise(
      publish({
        cwd: "/workspace",
        dir: ".pkg",
        registry: "https://pkg.ing/",
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provide(
          FileSystem.layerNoop({
            readFileString: () => Effect.succeed(JSON.stringify(manifest)),
            readFile: (path) =>
              Effect.sync(() => {
                reads.push(path);
                return new Uint8Array([1, 2, 3]);
              }),
          }),
        ),
        Effect.provide(Path.layer),
        Effect.result,
      ),
    );
    const uploads = scenario === "upload" || scenario === "still missing";
    expect(attempts).toBe(uploads ? 2 : 1);
    expect(reads).toEqual(uploads ? ["/workspace/.pkg/1.tgz"] : []);
    expect(requests).toEqual(
      uploads
        ? [
            "POST https://pkg.ing/api/publish",
            `PUT https://pkg.ing/api/tarballs/%40alchemy.run%2Fpkg/${"1".repeat(64)}`,
            "POST https://pkg.ing/api/publish",
          ]
        : ["POST https://pkg.ing/api/publish"],
    );
    if (scenario === "still missing" || scenario === "rejected") {
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("PublishError");
        expect(String(result.failure)).toContain(
          scenario === "rejected"
            ? "run is not in progress"
            : "registry still reports missing tarballs after upload",
        );
      }
    } else {
      expect(Result.getOrThrow(result)).toEqual(published);
    }
  });
}
