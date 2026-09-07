import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";

export class CryptoError extends Data.TaggedError("CryptoError")<{
  readonly message: string;
}> {}

const encoder = new TextEncoder();

/** Lowercase hex SHA-256 of a string. */
export const sha256Hex = (text: string) =>
  Effect.promise(async () =>
    Encoding.encodeHex(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", encoder.encode(text)),
      ),
    ),
  );

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
    const decoded = Encoding.decodeBase64(match[2]!.replace(/\s+/g, ""));
    if (Result.isFailure(decoded)) {
      return yield* new CryptoError({ message: "private key is not base64" });
    }
    const der = decoded.success;
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

/** Sign a compact RS256 JWT, used to authenticate as the GitHub App. */
export const signJwt = (claims: Record<string, unknown>, key: CryptoKey) =>
  Effect.tryPromise({
    try: async () => {
      const header = Encoding.encodeBase64Url(
        JSON.stringify({ alg: "RS256", typ: "JWT" }),
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
