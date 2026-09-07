import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export class CryptoError extends Data.TaggedError("CryptoError")<{
  readonly message: string;
}> {}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const decoded = (
  result: Result.Result<Uint8Array, unknown>,
  message: string,
): Effect.Effect<Uint8Array, CryptoError> =>
  Result.isSuccess(result)
    ? Effect.succeed(result.success)
    : Effect.fail(new CryptoError({ message }));

const decodeBase64Url = (text: string) =>
  decoded(Encoding.decodeBase64Url(text), "malformed base64url");

/** DER length prefix. */
const derLength = (length: number): number[] => {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
};

/**
 * Wrap a PKCS#1 `RSAPrivateKey` in a PKCS#8 `PrivateKeyInfo` so WebCrypto
 * can import it. GitHub issues App keys in PKCS#1.
 */
const pkcs1ToPkcs8 = (pkcs1: Uint8Array): Uint8Array<ArrayBuffer> => {
  // SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING { pkcs1 } }
  const algorithm = [
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x01, 0x05, 0x00,
  ];
  const octetString = [0x04, ...derLength(pkcs1.length)];
  const version = [0x02, 0x01, 0x00];
  const bodyLength =
    version.length + algorithm.length + octetString.length + pkcs1.length;
  return Uint8Array.from([
    0x30,
    ...derLength(bodyLength),
    ...version,
    ...algorithm,
    ...octetString,
    ...pkcs1,
  ]);
};

/** Import an RSA private key PEM (PKCS#1 or PKCS#8) for RS256 signing. */
export const importPrivateKey = (pem: string) =>
  Effect.gen(function* () {
    const match = pem.match(
      /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/,
    );
    if (!match) {
      return yield* new CryptoError({ message: "not an RSA private key PEM" });
    }
    const der = yield* decoded(
      Encoding.decodeBase64(match[2]!.replace(/\s+/g, "")),
      "private key is not base64",
    );
    const pkcs8 = match[1] ? pkcs1ToPkcs8(der) : Uint8Array.from(der);
    return yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey(
          "pkcs8",
          pkcs8,
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["sign"],
        ),
      catch: (cause) =>
        new CryptoError({ message: `invalid private key: ${cause}` }),
    });
  });

/** Sign a compact RS256 JWT. */
export const signJwt = (
  claims: Record<string, unknown>,
  key: CryptoKey,
  kid?: string,
) =>
  Effect.tryPromise({
    try: async () => {
      const header = Encoding.encodeBase64Url(
        JSON.stringify({ alg: "RS256", typ: "JWT", ...(kid ? { kid } : {}) }),
      );
      const payload = Encoding.encodeBase64Url(JSON.stringify(claims));
      const input = `${header}.${payload}`;
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        key,
        encoder.encode(input),
      );
      return `${input}.${Encoding.encodeBase64Url(new Uint8Array(signature))}`;
    },
    catch: (cause) => new CryptoError({ message: `signing failed: ${cause}` }),
  });

export const Jwk = Schema.Struct({
  kid: Schema.optionalKey(Schema.String),
  kty: Schema.String,
  alg: Schema.optionalKey(Schema.String),
  n: Schema.optionalKey(Schema.String),
  e: Schema.optionalKey(Schema.String),
  use: Schema.optionalKey(Schema.String),
});
export type Jwk = typeof Jwk.Type;

export const Jwks = Schema.Struct({ keys: Schema.Array(Jwk) });

const JwtHeader = Schema.fromJsonString(
  Schema.Struct({
    alg: Schema.String,
    kid: Schema.optionalKey(Schema.String),
  }),
);

/**
 * Verify a compact RS256 JWT against a JWKS and return its raw payload. The
 * caller decodes the payload with the claims schema it expects.
 */
export const verifyJwt = (token: string, keys: ReadonlyArray<Jwk>) =>
  Effect.gen(function* () {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return yield* new CryptoError({ message: "malformed token" });
    }
    const [rawHeader, rawPayload, rawSignature] = parts as [
      string,
      string,
      string,
    ];
    const header = yield* Schema.decodeUnknownEffect(JwtHeader)(
      decoder.decode(yield* decodeBase64Url(rawHeader)),
    ).pipe(
      Effect.mapError(
        () => new CryptoError({ message: "malformed token header" }),
      ),
    );
    if (header.alg !== "RS256") {
      return yield* new CryptoError({
        message: `unsupported algorithm ${header.alg}`,
      });
    }
    const jwk = keys.find((k) => k.kid === header.kid && k.kty === "RSA");
    if (jwk === undefined) {
      return yield* new CryptoError({ message: "unknown signing key" });
    }
    const signature = yield* decodeBase64Url(rawSignature);
    const valid = yield* Effect.tryPromise({
      try: async () => {
        const key = await crypto.subtle.importKey(
          "jwk",
          { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        );
        return await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          key,
          Uint8Array.from(signature),
          encoder.encode(`${rawHeader}.${rawPayload}`),
        );
      },
      catch: (cause) =>
        new CryptoError({ message: `verification failed: ${cause}` }),
    });
    if (!valid) {
      return yield* new CryptoError({ message: "invalid signature" });
    }
    return decoder.decode(yield* decodeBase64Url(rawPayload));
  });
