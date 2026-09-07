import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

export class GitError extends Data.TaggedError("GitError")<{
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly exitCode: number;
  readonly stderr: string;
}> {
  override get message() {
    return `git ${this.args.join(" ")} in ${this.cwd} exited with ${this.exitCode}: ${this.stderr.trim()}`;
  }
}

/** Run `git` in `cwd` and return trimmed stdout. */
export const git = Effect.fn("git")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner;
  const handle = yield* spawner.spawn(
    ChildProcess.make("git", [...args], { cwd, shell: false }),
  );
  const [exitCode, stdout, stderr] = yield* Effect.all(
    [
      handle.exitCode,
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
    ],
    { concurrency: 3 },
  );
  if (exitCode !== 0) {
    return yield* new GitError({ args, cwd, exitCode, stderr });
  }
  return stdout.trim();
}, Effect.scoped);

/** Absolute path of the repository (or submodule) that owns `cwd`. */
export const toplevel = (cwd: string) =>
  git(cwd, ["rev-parse", "--show-toplevel"]);

/** Full HEAD SHA of the repository that owns `cwd`. */
export const head = (cwd: string) => git(cwd, ["rev-parse", "HEAD"]);
