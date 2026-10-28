import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ElectronApp from "./ElectronApp.ts";
import * as LocalRebuildUpdater from "./LocalRebuildUpdater.ts";

const layerElectronApp = Layer.succeed(ElectronApp.ElectronApp, {
  quit: Effect.void,
} as unknown as ElectronApp.ElectronApp["Service"]);

const git = Effect.fn("test.git")(function* (repo: string, ...args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("git", ["-C", repo, ...args], {
          stdin: "ignore",
          stderr: "ignore",
          extendEnv: true,
          env: {
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@t",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@t",
          },
        }),
      );
      const [stdout, exitCode] = yield* Effect.all(
        [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
        { concurrency: "unbounded" },
      );
      assert.equal(exitCode, 0, `git ${args.join(" ")}`);
      return stdout.trim();
    }),
  );
});

const commitVersion = Effect.fn("test.commitVersion")(function* (
  repo: string,
  version: string,
  subject: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.writeFileString(
    path.join(repo, "apps/desktop/package.json"),
    JSON.stringify({ version }),
  );
  yield* git(repo, "add", "-A");
  yield* git(repo, "-c", "commit.gpgsign=false", "commit", "-m", subject);
  return yield* git(repo, "rev-parse", "HEAD");
});

describe("LocalRebuildUpdater", () => {
  it.live("offers the branch head as an update unless it is at or behind the built commit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repo = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-local-rebuild-" });
        yield* fileSystem.makeDirectory(path.join(repo, "apps/desktop"), { recursive: true });
        yield* git(repo, "init", "-q", "-b", "fork/main");
        const built = yield* commitVersion(repo, "0.1.3", "first");
        const head = yield* commitVersion(repo, "0.1.4-nightly.1", "second");
        yield* git(repo, "branch", "behind", built);

        const check = (builtHash: string, branch = "fork/main") =>
          Effect.scoped(
            Effect.gen(function* () {
              const updater = yield* LocalRebuildUpdater.make({
                t3codeCommitHash: builtHash,
                t3codeLocalRebuild: { repo, branch },
              });
              const events: Array<[string, unknown]> = [];
              for (const eventName of ["update-available", "update-not-available"]) {
                yield* updater.on(eventName, (info?: unknown) => events.push([eventName, info]));
              }
              yield* updater.checkForUpdates;
              return events;
            }),
          );

        const headVersion = `0.1.4-local.g${head.slice(0, 10)}`;
        assert.deepEqual(yield* check(built.slice(0, 12)), [
          ["update-available", { version: headVersion, releaseNotes: "- second" }],
        ]);
        assert.deepEqual(yield* check(head.slice(0, 12)), [["update-not-available", undefined]]);
        assert.deepEqual(yield* check(head.slice(0, 12), "behind"), [
          ["update-not-available", undefined],
        ]);
        assert.deepEqual(yield* check("unknown"), [
          ["update-available", { version: headVersion, releaseNotes: "" }],
        ]);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, layerElectronApp))),
  );
});
