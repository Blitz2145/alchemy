import { PlatformServices, runMain } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { CliConfig, Command, GlobalFlag } from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { root } from "./main.ts";

const PackageVersion = Schema.fromJsonString(
  Schema.Struct({ version: Schema.String }),
);

// Two levels below the package root in both `src/cli/` and `lib/cli/`.
const packageJsonUrl = new URL("../../package.json", import.meta.url);

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { version } = yield* Schema.decodeUnknownEffect(PackageVersion)(
    yield* fs.readFileString(packageJsonUrl.pathname),
  );
  yield* Command.run(root, { version });
}).pipe(
  Effect.provide(
    Layer.mergeAll(
      PlatformServices,
      FetchHttpClient.layer,
      CliConfig.layer({
        builtIns: [GlobalFlag.Help, GlobalFlag.Version, GlobalFlag.Completions],
      }),
    ),
  ),
);

runMain(program);
