import * as Cloudflare from "alchemy/Cloudflare";

/** Content-addressed tarballs, keyed `<encoded name>/<sha256>.tgz`. */
export const Tarballs = Cloudflare.R2.Bucket("PkgTarballs");

// The migrations ship inside this package. `import.meta.url` is a file URL
// during plan/deploy and absent or opaque inside the isolate, where the
// resource declaration is only evaluated for its binding.
const migrationsDir =
  typeof import.meta.url === "string" && import.meta.url.startsWith("file:")
    ? decodeURIComponent(new URL("../../migrations", import.meta.url).pathname)
    : undefined;

/** Publications, tags, and tarball bookkeeping. */
export const Index = Cloudflare.D1.Database("PkgIndex", {
  migrations: migrationsDir,
});

export const tarballKey = (name: string, sha256: string) =>
  `${encodeURIComponent(name)}/${sha256}.tgz`;
