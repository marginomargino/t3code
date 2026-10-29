import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
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
  it.live("prebuilds a newer branch head once and leaves retries to the click", () =>
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

        // Each build waits on its own gate; a failing build never writes its artifact.
        const updaterFor = (builtHash: string, options: { fail?: boolean; branch?: string } = {}) =>
          Effect.gen(function* () {
            const started = yield* Queue.unbounded<Deferred.Deferred<void>>();
            let builds = 0;
            const updater = yield* LocalRebuildUpdater.make(
              {
                t3codeCommitHash: builtHash,
                t3codeLocalRebuild: { repo, branch: options.branch ?? "fork/main" },
              },
              {
                runBuildScript: (_pending, outputDir) =>
                  Effect.gen(function* () {
                    builds += 1;
                    const gate = yield* Deferred.make<void>();
                    yield* Queue.offer(started, gate);
                    yield* Deferred.await(gate);
                    // Like the real build script, start from an empty output directory.
                    yield* fileSystem.remove(outputDir, { recursive: true, force: true });
                    yield* fileSystem.makeDirectory(outputDir, { recursive: true });
                    if (!options.fail) {
                      yield* fileSystem.writeFileString(path.join(outputDir, ".artifact"), "a.zip");
                    }
                  }),
              },
            );
            const events: Array<[string, unknown]> = [];
            for (const eventName of [
              "update-available",
              "update-not-available",
              "update-downloaded",
              "error",
            ]) {
              yield* updater.on(eventName, (info?: unknown) => events.push([eventName, info]));
            }
            const releaseNextBuild = Queue.take(started).pipe(
              Effect.flatMap((gate) => Deferred.succeed(gate, undefined)),
            );
            return { updater, events, releaseNextBuild, builds: () => builds };
          });

        const headVersion = `0.1.4-local.g${head.slice(0, 10)}`;
        const available: [string, unknown] = [
          "update-available",
          { version: headVersion, releaseNotes: "- second" },
        ];

        // A check prebuilds; a click and a re-check during that build join it.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { updater, events, releaseNextBuild, builds } = yield* updaterFor(
              built.slice(0, 12),
            );
            yield* updater.checkForUpdates;
            const click = yield* updater.downloadUpdate.pipe(Effect.forkScoped);
            yield* updater.checkForUpdates;
            yield* releaseNextBuild;
            yield* Fiber.join(click);
            assert.equal(builds(), 1);
            assert.deepEqual(events, [
              available,
              available,
              ["update-downloaded", { version: headVersion }],
            ]);
          }),
        );

        // A failed prebuild stays quiet and is not retried by checks; the click rebuilds it.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { updater, events, releaseNextBuild, builds } = yield* updaterFor(
              built.slice(0, 12),
              { fail: true },
            );
            yield* updater.checkForUpdates;
            const firstClick = yield* updater.downloadUpdate.pipe(Effect.flip, Effect.forkScoped);
            yield* releaseNextBuild;
            yield* Fiber.join(firstClick);
            yield* updater.checkForUpdates;
            assert.equal(builds(), 1);
            const secondClick = yield* updater.downloadUpdate.pipe(Effect.flip, Effect.forkScoped);
            yield* releaseNextBuild;
            yield* Fiber.join(secondClick);
            assert.equal(builds(), 2);
            assert.deepEqual(events, [available, available]);
          }),
        );

        for (const [builtHash, branch] of [
          [head.slice(0, 12), "fork/main"],
          [head.slice(0, 12), "behind"],
        ] as const) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const { updater, events, builds } = yield* updaterFor(builtHash, { branch });
              yield* updater.checkForUpdates;
              assert.equal(builds(), 0);
              assert.deepEqual(events, [["update-not-available", undefined]]);
            }),
          );
        }

        yield* Effect.scoped(
          Effect.gen(function* () {
            const { updater, events } = yield* updaterFor("unknown");
            yield* updater.checkForUpdates;
            assert.deepEqual(events[0], [
              "update-available",
              { version: headVersion, releaseNotes: "" },
            ]);
          }),
        );
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, layerElectronApp))),
  );
});
