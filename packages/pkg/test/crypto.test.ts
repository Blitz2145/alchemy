import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { generateKeyPairSync } from "node:crypto";
import * as Encoding from "effect/Encoding";
import { importPrivateKey, signJwt, verifyJwt } from "../src/runtime/Crypto.ts";

const keyPair = (type: "pkcs1" | "pkcs8") =>
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type, format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

const publicJwk = async (publicKeyPem: string, kid: string) => {
  const der = Uint8Array.from(
    atob(publicKeyPem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "")),
    (c) => c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "spki",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    true,
    ["verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", key);
  return { kid, kty: jwk.kty!, n: jwk.n, e: jwk.e, alg: "RS256" };
};

describe("Crypto", () => {
  for (const type of ["pkcs1", "pkcs8"] as const) {
    test(`signs with a ${type} PEM and verifies against the JWK`, async () => {
      const { privateKey, publicKey } = keyPair(type);
      const key = await Effect.runPromise(importPrivateKey(privateKey));
      const token = await Effect.runPromise(
        signJwt({ iss: "12345", exp: 4102444800 }, key, "k1"),
      );
      const jwk = await publicJwk(publicKey, "k1");
      const payload = await Effect.runPromise(verifyJwt(token, [jwk]));
      expect(JSON.parse(payload)).toEqual({ iss: "12345", exp: 4102444800 });
    });
  }

  test("rejects a token signed by another key", async () => {
    const a = keyPair("pkcs8");
    const b = keyPair("pkcs8");
    const key = await Effect.runPromise(importPrivateKey(a.privateKey));
    const token = await Effect.runPromise(signJwt({ sub: "x" }, key, "k1"));
    const jwk = await publicJwk(b.publicKey, "k1");
    const result = await Effect.runPromise(
      Effect.result(verifyJwt(token, [jwk])),
    );
    expect(result._tag).toBe("Failure");
  });

  test("rejects an unknown kid and a tampered payload", async () => {
    const { privateKey, publicKey } = keyPair("pkcs8");
    const key = await Effect.runPromise(importPrivateKey(privateKey));
    const token = await Effect.runPromise(signJwt({ sub: "x" }, key, "k1"));
    const other = await publicJwk(publicKey, "k2");
    expect(
      (await Effect.runPromise(Effect.result(verifyJwt(token, [other]))))._tag,
    ).toBe("Failure");

    const [header, , signature] = token.split(".");
    const tampered = `${header}.${Encoding.encodeBase64Url(JSON.stringify({ sub: "y" }))}.${signature}`;
    const jwk = await publicJwk(publicKey, "k1");
    expect(
      (await Effect.runPromise(Effect.result(verifyJwt(tampered, [jwk]))))._tag,
    ).toBe("Failure");
  });
});
