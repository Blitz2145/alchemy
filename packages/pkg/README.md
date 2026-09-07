# @alchemy.run/pkg

Preview packages for pull requests. A Cloudflare Worker registry authenticated by GitHub Actions OIDC, plus the `pkg` CLI that packs workspace packages and publishes them from CI.

Install URLs look like `https://pkg.ing/<name>@<tag>` where `<tag>` is a commit SHA, a short SHA, `branch:<name>`, or `pr:<number>`.

## How a publication flows

Every publication is a GitHub Actions **run**. The registry never trusts what a client says about commits, branches, or pull requests; it resolves the run through the GitHub API and derives every tag from that.

1. **Build** runs on `push` and `pull_request` with no permissions. It builds the workspace, runs `pkg pack`, and uploads the output directory as an artifact. Fork pull requests run here too, since a fork's PR workflow runs inside the upstream repository's Actions.
2. **Publish** is a `workflow_run` workflow on the default branch with `id-token: write`. It downloads the artifact from the triggering run and runs `pkg publish` with an OIDC token. It never checks out code, so nothing from a fork executes with a credential.
3. The **Worker** verifies the OIDC token against the pinned publish workflow, resolves the triggering run to its head commit, branch, and pull request, and checks the manifest against policy. One idempotent `POST /api/publish` either answers 409 with the tarballs it lacks, which the CLI uploads before publishing again, or points the tags, posts a "Preview packages" check run on the commit, and for pull requests updates the comment. The App needs `checks: write`, `pull_requests: write`, and `actions: read`.

## `pkg pack`

```sh
pkg pack \
  --group 'Alchemy=./packages/*' \
  --group 'Distilled=./submodules/distilled/packages/*' \
  --registry https://pkg.ing \
  --out .pkg
```

For each non-private package under a group's glob, `pack`:

- resolves the git repository that owns the directory, so a package inside a submodule is addressed by the submodule's HEAD, not the root repository's;
- runs `pnpm pack`, then rewrites every dependency on another packed package to `https://<registry>/<name>@<owning commit>`;
- repacks with fixed timestamps and no ownership so identical inputs hash identically, letting the registry skip uploads it already has;
- writes `pkg-manifest.json` describing each tarball's name, group, owning commit, SHA-256, and size.

Globs support `*` as a whole path segment and `{a,b}` alternatives, so `./submodules/distilled/packages/{core,aws}` lists exactly those two. Repeat `--group` with the same name to add more directories to one group.

## Policy

The Worker is configured with plain data, validated by the `Policy` schema exported from `@alchemy.run/pkg/Policy`:

```ts
{
  repos: ["alchemy-run/alchemy", "alchemy-run/distilled"],
  ttl: Duration.weeks(1),
  maxPackageSize: 100 * 1024 * 1024,
}
```

`repos` lists the repositories allowed to publish. A publication may contain any package; every package gets the commit, short commit, `branch:<name>`, and `pr:<number>` tags of the run that produced it. A package packed from a submodule is tagged by the submodule's commit, which is what the rewritten dependency URLs in the other tarballs point at.

Only OIDC tokens from `.github/workflows/pkg-publish.yml` on each repository's `main` branch may publish; `workflow` overrides the file name.

## Cleanup

The registry keeps one table: `tags(package, tag, sha256, expires_at, linked_prs)`. A tarball lives in R2 for as long as any row points at it.

Every publication of a tag refreshes `expires_at` to now plus `ttl`. Rows produced by pull request runs also record the pull request in `linked_prs`; a commit tag shared by several pull requests records all of them. An hourly sweep re-checks rows that are about to expire: while any linked pull request is open the row is extended by `ttl`, and once they are all closed or merged the expiry is pinned to the latest close time plus `ttl`. Branch publications simply expire `ttl` after the push. The sweep then deletes expired rows, tarballs no row points at, and uploads that never got tagged.
