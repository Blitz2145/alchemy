import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";
import { generateKeyPairSync } from "node:crypto";
import { importPrivateKey, sha256Hex, signJwt } from "../src/runtime/Crypto.ts";

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
