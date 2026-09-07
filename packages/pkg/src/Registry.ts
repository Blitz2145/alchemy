import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Schema from "effect/Schema";
import type { PolicyInput } from "./Policy.ts";
import { RegistryConfig } from "./runtime/Config.ts";
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
  /**
   * Names of the deploy-time variables holding the GitHub App credentials.
   * Each is read with `Config` at deploy time and bound to the Worker under
   * the same name, the id as a plain var and the key as a secret. The Worker
   * re-reads its `env` inside the isolate, which is why the binding name and
   * the Config key have to be one and the same string.
   */
  readonly github: {
    /** Variable holding the GitHub App id. */
    readonly appId: string;
    /** Variable holding the App's private key PEM. */
    readonly privateKey: string;
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
 *   github: { appId: "GH_APP_ID", privateKey: "GH_APP_PRIVATE_KEY" },
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
      appIdEnv: props.github.appId,
      privateKeyEnv: props.github.privateKey,
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
        [props.github.appId]: Config.string(props.github.appId),
        [props.github.privateKey]: Config.redacted(props.github.privateKey),
      },
    },
    make(config),
  );
};
