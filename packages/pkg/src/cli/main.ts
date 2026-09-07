import * as Effect from "effect/Effect";
import { CliError, Command, Flag } from "effect/unstable/cli";
import { pack } from "./pack.ts";
import { publish } from "./publish.ts";
import { parseGroup, WorkspaceError, type Group } from "./workspace.ts";

const groupFlag = Flag.string("group").pipe(
  Flag.withDescription(
    "Display group and directory glob, as NAME=GLOB (repeatable), e.g. --group Alchemy=./packages/*",
  ),
  Flag.atLeast(1),
);

const registryFlag = Flag.string("registry").pipe(
  Flag.withDescription("Registry origin used for install URLs"),
  Flag.withDefault("https://pkg.ing"),
);

const outFlag = Flag.string("out").pipe(
  Flag.withDescription("Directory to write tarballs and the manifest into"),
  Flag.withDefault(".pkg"),
);

const parseGroups = (specs: ReadonlyArray<string>) =>
  Effect.forEach(specs, (spec) => {
    const group = parseGroup(spec);
    return group === undefined
      ? Effect.fail(
          new WorkspaceError({
            message: `Invalid --group ${JSON.stringify(spec)}: expected NAME=GLOB`,
          }),
        )
      : Effect.succeed(group satisfies Group);
  });

export const packCommand = Command.make(
  "pack",
  { group: groupFlag, registry: registryFlag, out: outFlag },
  ({ group, registry, out }) =>
    Effect.gen(function* () {
      const groups = yield* parseGroups(group);
      const cwd = yield* Effect.sync(() => process.cwd());
      yield* pack({ cwd, groups, registry, out });
    }),
).pipe(
  Command.withDescription(
    "Pack workspace packages into reproducible tarballs with dependencies rewritten to registry URLs",
  ),
  Command.withExamples([
    {
      command:
        "pkg pack --group Alchemy=./packages/* --group Distilled=./submodules/distilled/packages/*",
    },
  ]),
);

const runFlag = Flag.integer("run").pipe(
  Flag.withDescription(
    "Id of the build workflow run whose artifact is being published (github.event.workflow_run.id)",
  ),
);

const dirFlag = Flag.string("dir").pipe(
  Flag.withDescription("Directory holding the pkg pack artifact"),
  Flag.withDefault(".pkg"),
);

export const publishCommand = Command.make(
  "publish",
  { run: runFlag, registry: registryFlag, dir: dirFlag },
  ({ run, registry, dir }) =>
    Effect.gen(function* () {
      const cwd = yield* Effect.sync(() => process.cwd());
      yield* publish({ cwd, dir, registry, runId: run });
    }),
).pipe(
  Command.withDescription(
    "Publish a packed artifact to the registry using the job's GitHub Actions OIDC token",
  ),
  Command.withExamples([
    { command: "pkg publish --run ${{ github.event.workflow_run.id }}" },
  ]),
);

export const root = Command.make("pkg", {}, () =>
  Effect.fail(new CliError.ShowHelp({ commandPath: ["pkg"], errors: [] })),
).pipe(
  Command.withDescription(
    "Pack and publish preview packages for pull requests.",
  ),
  Command.withSubcommands([packCommand, publishCommand]),
);
