import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";
import { generateKeyPairSync } from "node:crypto";
import { importPrivateKey, sha256Hex, signJwt } from "../src/runtime/GitHub.ts";
import { renderComment, renderInstalls } from "../src/runtime/GitHub.ts";

const keyPair = (type: "pkcs1" | "pkcs8") =>
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type, format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

const verify = async (publicKeyPem: string, token: string) => {
  const der = Result.getOrThrow(
    Encoding.decodeBase64(
      publicKeyPem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""),
    ),
  );
  const key = await crypto.subtle.importKey(
    "spki",
    Uint8Array.from(der),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const [header, payload, signature] = token.split(".") as [
    string,
    string,
    string,
  ];
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    Uint8Array.from(Result.getOrThrow(Encoding.decodeBase64Url(signature))),
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return {
    valid,
    payload: JSON.parse(
      new TextDecoder().decode(
        Result.getOrThrow(Encoding.decodeBase64Url(payload)),
      ),
    ) as Record<string, unknown>,
  };
};

describe("Crypto", () => {
  for (const type of ["pkcs1", "pkcs8"] as const) {
    test(`signs an App JWT with a ${type} PEM`, async () => {
      const { privateKey, publicKey } = keyPair(type);
      const key = await Effect.runPromise(importPrivateKey(privateKey));
      const token = await Effect.runPromise(
        signJwt({ iss: "12345", exp: 4102444800 }, key),
      );
      const result = await verify(publicKey, token);
      expect(result.valid).toBe(true);
      expect(result.payload).toEqual({ iss: "12345", exp: 4102444800 });
    });
  }

  test("a signature does not verify against another key", async () => {
    const a = keyPair("pkcs8");
    const b = keyPair("pkcs8");
    const key = await Effect.runPromise(importPrivateKey(a.privateKey));
    const token = await Effect.runPromise(signJwt({ sub: "x" }, key));
    expect((await verify(b.publicKey, token)).valid).toBe(false);
  });

  test("rejects something that is not a PEM", async () => {
    const result = await Effect.runPromise(
      Effect.result(importPrivateKey("nope")),
    );
    expect(result._tag).toBe("Failure");
  });

  test("sha256Hex matches node", async () => {
    const { createHash } = await import("node:crypto");
    const text = '{"version":1}';
    expect(await Effect.runPromise(sha256Hex(text))).toBe(
      createHash("sha256").update(text).digest("hex"),
    );
  });
});

const packages = [
  { name: "alchemy", group: "Alchemy" },
  { name: "@distilled.cloud/core", group: "Distilled" },
  { name: "@alchemy.run/pkg", group: "Alchemy" },
];
const run = { headSha: "abcdef0123456789" };

test("install commands preserve group and package order, scopes, and short commit", () => {
  expect(renderInstalls("https://pkg.ing", run, packages)).toBe(
    [
      "### Alchemy",
      "",
      "**alchemy**",
      "```sh",
      "pnpm install https://pkg.ing/alchemy/abcdef0",
      "```",
      "",
      "**@alchemy.run/pkg**",
      "```sh",
      "pnpm install https://pkg.ing/@alchemy.run/pkg/abcdef0",
      "```",
      "",
      "### Distilled",
      "",
      "**@distilled.cloud/core**",
      "```sh",
      "pnpm install https://pkg.ing/@distilled.cloud/core/abcdef0",
      "```",
      "",
    ].join("\n"),
  );
});

test("comment retains live relative timestamps and UTC fallback at midnight and noon", () => {
  const comment = renderComment("https://pkg.ing", run, packages, {
    publishedAt: Date.parse("2026-09-07T00:05:00Z"),
    expiresAt: Date.parse("2026-09-14T12:05:00Z"),
  });
  expect(comment).toContain(renderInstalls("https://pkg.ing", run, packages));
  expect(comment).toContain(
    'Published <relative-time datetime="2026-09-07T00:05:00.000Z">Sep 7, 2026 12:05am UTC</relative-time>.',
  );
  expect(comment).toContain(
    'Expires <relative-time datetime="2026-09-14T12:05:00.000Z">Sep 14, 2026 12:05pm UTC</relative-time>, extended while this pull request is open.',
  );
});
