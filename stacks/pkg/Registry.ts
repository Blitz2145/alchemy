import { Registry } from "@alchemy.run/pkg";
import * as Duration from "effect/Duration";

/**
 * The preview package registry, currently on the staging host while the new
 * flow is proven out. Moving to pkg.ing plus the pkg.alchemy.run and
 * pkg.distilled.cloud aliases is a `domain` change here and a `--registry`
 * change in the two workflows.
 *
 * This file is the Worker's bundle entry, so it must stay free of the stack
 * definition: importing `alchemy` here would pull the CLI into the Worker.
 */
export default Registry("Registry", {
  main: import.meta.url,
  domain: "staging.pkg.ing",
  // Deploy-time variables, bound to the Worker under the same names.
  github: { appId: "GH_APP_ID", privateKey: "GH_APP_PRIVATE_KEY" },
  policy: {
    repos: ["alchemy-run/alchemy", "alchemy-run/distilled"],
    ttl: Duration.weeks(1),
    maxPackageSize: 100 * 1024 * 1024,
  },
});
