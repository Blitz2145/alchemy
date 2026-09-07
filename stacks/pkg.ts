import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Registry from "./pkg/Registry.ts";

export default Alchemy.Stack(
  "Pkg",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const registry = yield* Registry;
    return {
      url: registry.url.as<string>(),
    };
  }),
);
