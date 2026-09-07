import * as Cloudflare from "alchemy/Cloudflare";
import type * as Config from "effect/Config";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { PolicyInput } from "./Policy.ts";
import {
  APP_ID_ENV,
  PRIVATE_KEY_ENV,
  RegistryConfig,
} from "./runtime/Config.ts";
import { make } from "./runtime/Handler.ts";

export interface RegistryProps {
  /**
   * `import.meta.url` of the file that default-exports this Registry. The
   * Worker bundle starts there, so the props re-execute inside the isolate
   * with the same literal values; keep everything in them plain data.
   */
  readonly main: string;
  /** Worker script name. */
  readonly name?: string;
  readonly domain?: Cloudflare.WorkerProps["domain"];
  readonly policy: PolicyInput;
  /**
   * Hostname to package scope. Requests on an aliased host resolve an
   * unscoped name under that scope, so `pkg.distilled.cloud/core@<sha>`
   * serves `@distilled.cloud/core`.
   */
  readonly aliases?: Record<string, string>;
  readonly github: {
    /** The GitHub App id. Bound to the Worker as an env var. */
    readonly appId: Config.Config<string>;
    /** The App's private key PEM. Bound to the Worker as a secret. */
    readonly privateKey: Config.Config<Redacted.Redacted<string>>;
    /** @default "https://api.github.com" */
    readonly apiUrl?: string;
  };
  /**
   * Cron expression for the expiry sweep.
   * @default "0 * * * *"
   */
  readonly cron?: string;
}

/**
 * A preview package registry Worker.
 *
 * ### Deploying a registry
 * **Example:** Registry entry file
 * ```typescript
 * // stacks/pkg/Registry.ts
 * import { Registry } from "@alchemy.run/pkg";
 *
 * export default Registry("Registry", {
 *   main: import.meta.url,
 *   domain: { name: "pkg.ing", aliases: ["pkg.distilled.cloud"] },
 *   aliases: { "pkg.distilled.cloud": "@distilled.cloud" },
 *   github: {
 *     appId: Config.string("PKG_GITHUB_APP_ID"),
 *     privateKey: Config.redacted("PKG_GITHUB_APP_PRIVATE_KEY"),
 *   },
 *   policy: {
 *     repos: ["alchemy-run/alchemy", "alchemy-run/distilled"],
 *     ttl: Duration.weeks(1),
 *     maxPackageSize: 100 * 1024 * 1024,
 *   },
 * });
 * ```
 *
 * **Example:** Stack
 * ```typescript
 * // stacks/pkg.ts
 * import * as Alchemy from "alchemy";
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import Registry from "./pkg/Registry.ts";
 *
 * export default Alchemy.Stack(
 *   "Pkg",
 *   { providers: Cloudflare.providers(), state: Cloudflare.state() },
 *   Effect.gen(function* () {
 *     const registry = yield* Registry;
 *     return { url: registry.url.as<string>() };
 *   }),
 * );
 * ```
 *
 * @resource
 * @product Workers
 * @category Workers & Compute
 */
export const Registry = <const Id extends string>(
  id: Id,
  props: RegistryProps,
) => {
  const config = Schema.decodeUnknownSync(RegistryConfig)({
    policy: props.policy,
    aliases: props.aliases ?? {},
    github: {
      apiUrl: props.github.apiUrl ?? "https://api.github.com",
    },
    cron: props.cron ?? "0 * * * *",
  });
  return Cloudflare.Worker(
    id,
    {
      main: props.main,
      name: props.name,
      domain: props.domain,
      env: {
        [APP_ID_ENV]: props.github.appId,
        [PRIVATE_KEY_ENV]: props.github.privateKey,
      },
    },
    make(config),
  );
};
