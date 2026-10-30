// @effect-diagnostics nodeBuiltinImport:off -- the installer must outlive this process, so it is a detached Node child.
import * as NodeChildProcess from "node:child_process";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "./ElectronApp.ts";
import * as ElectronUpdater from "./ElectronUpdater.ts";

const LocalRebuildPackageMetadata = Schema.Struct({
  t3codeCommitHash: Schema.String,
  t3codeLocalRebuild: Schema.Struct({
    repo: Schema.String,
    branch: Schema.String,
    releaseDir: Schema.optional(Schema.String),
  }),
});
type LocalRebuildPackageMetadata = typeof LocalRebuildPackageMetadata.Type;
const decodeLocalRebuildPackageMetadata = Schema.decodeEffect(
  Schema.fromJsonString(LocalRebuildPackageMetadata),
);

const DesktopPackageVersion = Schema.Struct({ version: Schema.String });
const decodeDesktopPackageVersion = Schema.decodeEffect(
  Schema.fromJsonString(DesktopPackageVersion),
);

class LocalRebuildCommandError extends Schema.TaggedError<LocalRebuildCommandError>()(
  "LocalRebuildCommandError",
  {
    command: Schema.String,
    exitCode: Schema.Number,
    output: Schema.String,
  },
) {
  override get message(): string {
    return `${this.command} exited with ${this.exitCode}: ${this.output.trim().slice(-2000)}`;
  }
}

function localRebuildVersion(baseVersion: string, commit: string): string {
  return `${baseVersion.replace(/[-+].*$/, "")}-local.g${commit.slice(0, 10)}`;
}

// Runs from an interactive login shell, as DesktopShellEnvironment does, so a Finder-launched app
// still finds vp, node and git on the user's PATH.
const BUILD_SCRIPT = `set -euo pipefail
repo="$1" commit="$2" branch="$3" version="$4" arch="$5" out="$6" log="$7" release_dir="$8"
mkdir -p "$(dirname "$log")"
exec >"$log" 2>&1
checkout="$repo/.t3/local-rebuild"
if [ ! -e "$checkout/.git" ]; then
  git -C "$repo" worktree add --detach "$checkout" "$commit"
fi
cd "$checkout"
git checkout --detach --force "$commit"
vp i
rm -rf "$out"
T3CODE_LOCAL_REBUILD_REPO="$repo" T3CODE_LOCAL_REBUILD_BRANCH="$branch" T3CODE_DESKTOP_VERSION="$version" \\
  T3CODE_LOCAL_REBUILD_RELEASE_DIR="$release_dir" \\
  node scripts/build-desktop-artifact.ts --platform mac --target zip --arch "$arch" --output-dir "$out"
# SSH environments install this version from the mirror; a failure must not block the Mac update.
if [ -n "$release_dir" ]; then
  bash scripts/local-rebuild/build-linux-cli-archive.sh "$repo" "$commit" "$version" "$release_dir" ||
    echo "Linux CLI archive build failed; SSH environments cannot install $version."
fi
ls "$out"/*.zip | head -n 1 >"$out/.artifact"
`;

const INSTALL_SCRIPT = `pid="$1" zip="$2" bundle="$3"
while kill -0 "$pid" 2>/dev/null; do sleep 0.5; done
staging="$(mktemp -d "$(dirname "$bundle")/.local-rebuild.XXXXXX")"
if ditto -x -k "$zip" "$staging"; then
  app="$(find "$staging" -maxdepth 1 -name '*.app' | head -n 1)"
  if [ -n "$app" ]; then
    rm -rf "$bundle.previous"
    if mv "$bundle" "$bundle.previous"; then
      if mv "$app" "$bundle"; then rm -rf "$bundle.previous"; else mv "$bundle.previous" "$bundle"; fi
    fi
  fi
fi
rm -rf "$staging"
xattr -dr com.apple.quarantine "$bundle" 2>/dev/null
open "$bundle"
`;

class LocalRebuildStateError extends Schema.TaggedError<LocalRebuildStateError>()(
  "LocalRebuildStateError",
  { step: Schema.Literals(["download", "install"]) },
) {
  override get message(): string {
    return this.step === "download"
      ? "No newer commit is pending; check for updates first."
      : "No local rebuild has finished building yet.";
  }
}

// electron-updater feed and channel settings do not apply to a local rebuild.
const ignoreSetting = Effect.fn("LocalRebuildUpdater.ignoreSetting")(function (_value: unknown) {
  return Effect.void;
});

type LocalRebuildBuildError = LocalRebuildCommandError | PlatformError.PlatformError;

interface PendingBuild {
  readonly commit: string;
  readonly version: string;
}

export const make = Effect.fn("LocalRebuildUpdater.make")(function* (
  metadata: LocalRebuildPackageMetadata,
  options: {
    readonly runBuildScript?: (
      pending: PendingBuild,
      outputDir: string,
    ) => Effect.Effect<unknown, LocalRebuildBuildError>;
  } = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const electronApp = yield* ElectronApp.ElectronApp;
  const arch = yield* HostProcess.Architecture;
  const scope = yield* Scope.Scope;
  const { repo, branch, releaseDir } = metadata.t3codeLocalRebuild;
  const outputDir = path.join(repo, ".t3", "local-rebuild-out");
  const logPath = path.join(repo, ".t3", "local-rebuild.log");

  const listeners = new Map<string, Set<(...args: Array<unknown>) => void>>();
  const emit = (eventName: string, ...args: Array<unknown>) => {
    for (const listener of listeners.get(eventName) ?? []) listener(...args);
  };
  const pendingRef = yield* Ref.make(Option.none<PendingBuild>());
  const artifactRef = yield* Ref.make(Option.none<{ zip: string; version: string }>());
  const buildRef = yield* Ref.make(
    Option.none<{ version: string; fiber: Fiber.Fiber<void, LocalRebuildBuildError> }>(),
  );
  const buildLock = yield* Semaphore.make(1);

  const run = (label: string, command: string, args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(command, args, {
            stdin: "ignore",
            stderr: "pipe",
            extendEnv: true,
            // An interrupted build must be gone before the next one reuses its checkout.
            forceKillAfter: "5 seconds",
          }),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
            handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        if (exitCode !== 0) {
          return yield* new LocalRebuildCommandError({
            command: label,
            exitCode,
            output: stderr || stdout,
          });
        }
        return stdout.trim();
      }),
    );
  const git = (...args: ReadonlyArray<string>) =>
    run(`git ${args[0]}`, "git", ["-C", repo, ...args]);
  const isAncestor = (ancestor: string, descendant: string) =>
    git("merge-base", "--is-ancestor", ancestor, descendant).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  // A build whose commit could not be resolved bakes "unknown".
  const builtCommit = /^[0-9a-f]{7,40}$/i.test(metadata.t3codeCommitHash)
    ? Option.some(metadata.t3codeCommitHash)
    : Option.none<string>();

  const check = Effect.gen(function* () {
    const branchCommit = yield* git("rev-parse", branch);
    // A branch at or behind the built commit has nothing newer; a rewritten branch still updates.
    if (
      Option.isSome(builtCommit) &&
      (branchCommit.startsWith(builtCommit.value) ||
        (yield* isAncestor(branchCommit, builtCommit.value)))
    ) {
      yield* Ref.set(pendingRef, Option.none());
      yield* stopBuild;
      emit("update-not-available");
      return;
    }
    const desktopPackage = yield* git("show", `${branchCommit}:apps/desktop/package.json`).pipe(
      Effect.flatMap(decodeDesktopPackageVersion),
    );
    const version = localRebuildVersion(desktopPackage.version, branchCommit);
    // Oldest first, as the release-notes normalizer keeps the last lines.
    const subjects = Option.isSome(builtCommit)
      ? yield* git(
          "log",
          "--reverse",
          "--format=- %s",
          `${builtCommit.value}..${branchCommit}`,
        ).pipe(Effect.orElseSucceed(() => ""))
      : "";
    const pending = { commit: branchCommit, version };
    yield* Ref.set(pendingRef, Option.some(pending));
    emit("update-available", { version, releaseNotes: subjects });
    const artifact = yield* Ref.get(artifactRef);
    if (Option.isSome(artifact) && artifact.value.version === version) {
      emit("update-downloaded", { version });
      return;
    }
    // Build ahead of the click, so the button only has to restart into the new app. A failed
    // prebuild stays quiet and is not retried here; the click rebuilds it and reports failures.
    yield* startBuild(pending, { retryFailed: false });
  });

  const runBuildScript =
    options.runBuildScript ??
    (({ commit, version }: PendingBuild) =>
      run(`build (log: ${logPath})`, "/bin/zsh", [
        "-ilc",
        BUILD_SCRIPT,
        "local-rebuild",
        repo,
        commit,
        branch,
        version,
        arch,
        outputDir,
        logPath,
        releaseDir ?? "",
      ]));

  const buildCommit = Effect.fn("LocalRebuildUpdater.buildCommit")(function* (
    pending: PendingBuild,
  ) {
    yield* runBuildScript(pending, outputDir);
    const zip = (yield* fileSystem.readFileString(path.join(outputDir, ".artifact"))).trim();
    yield* Ref.set(artifactRef, Option.some({ zip, version: pending.version }));
    emit("update-downloaded", { version: pending.version });
  });

  const stopBuild = buildLock.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.get(buildRef);
      if (Option.isSome(current)) yield* Fiber.interrupt(current.value.fiber);
      yield* Ref.set(buildRef, Option.none());
    }),
  );

  // One build per version: a check starts it, a click joins it, a newer commit replaces it.
  const startBuild = (pending: PendingBuild, { retryFailed }: { retryFailed: boolean }) =>
    buildLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(buildRef);
        if (Option.isSome(current)) {
          const { fiber, version } = current.value;
          const exit = yield* Effect.sync(() => fiber.pollUnsafe());
          const failed = exit !== undefined && Exit.isFailure(exit);
          if (version === pending.version && (!failed || !retryFailed)) return fiber;
          yield* Fiber.interrupt(fiber);
        }
        yield* Ref.set(artifactRef, Option.none());
        const fiber = yield* buildCommit(pending).pipe(
          Effect.forkIn(scope, { startImmediately: true }),
        );
        yield* Ref.set(buildRef, Option.some({ version: pending.version, fiber }));
        return fiber;
      }),
    );

  const build = Effect.gen(function* () {
    const pending = yield* Ref.get(pendingRef);
    if (Option.isNone(pending)) return yield* new LocalRebuildStateError({ step: "download" });
    yield* Fiber.join(yield* startBuild(pending.value, { retryFailed: true }));
  });

  const install = Effect.gen(function* () {
    const artifact = yield* Ref.get(artifactRef);
    if (Option.isNone(artifact)) return yield* new LocalRebuildStateError({ step: "install" });
    // process.execPath is <bundle>.app/Contents/MacOS/<name>.
    const bundle = path.resolve(process.execPath, "..", "..", "..");
    yield* Effect.sync(() => {
      NodeChildProcess.spawn(
        "/bin/sh",
        [
          "-c",
          INSTALL_SCRIPT,
          "local-rebuild-install",
          String(process.pid),
          artifact.value.zip,
          bundle,
        ],
        { detached: true, stdio: "ignore" },
      ).unref();
    });
    yield* electronApp.quit;
  });

  return ElectronUpdater.ElectronUpdater.of({
    providesOwnFeed: true,
    setFeedURL: ignoreSetting,
    setAutoDownload: ignoreSetting,
    setAutoInstallOnAppQuit: ignoreSetting,
    setChannel: ignoreSetting,
    setAllowPrerelease: ignoreSetting,
    allowDowngrade: Effect.succeed(false),
    setAllowDowngrade: ignoreSetting,
    setFullChangelog: ignoreSetting,
    setDisableDifferentialDownload: ignoreSetting,
    checkForUpdates: check.pipe(
      Effect.mapError(
        (cause) =>
          new ElectronUpdater.ElectronUpdaterCheckForUpdatesError({ channel: branch, cause }),
      ),
      Effect.withSpan("LocalRebuildUpdater.checkForUpdates"),
    ),
    downloadUpdate: build.pipe(
      Effect.mapError(
        (cause) =>
          new ElectronUpdater.ElectronUpdaterDownloadUpdateError({ channel: branch, cause }),
      ),
      Effect.withSpan("LocalRebuildUpdater.downloadUpdate"),
    ),
    quitAndInstall: Effect.fn("LocalRebuildUpdater.quitAndInstall")(function ({
      isSilent,
      isForceRunAfter,
    }) {
      return install.pipe(
        Effect.mapError(
          (cause) =>
            new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
              channel: branch,
              isSilent,
              isForceRunAfter,
              cause,
            }),
        ),
      );
    }),
    on: Effect.fn("LocalRebuildUpdater.on")(function (eventName, listener) {
      const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
      return Effect.acquireRelease(
        Effect.sync(() => {
          const eventListeners = listeners.get(eventName) ?? new Set();
          eventListeners.add(untypedListener);
          listeners.set(eventName, eventListeners);
        }),
        () =>
          Effect.sync(() => {
            listeners.get(eventName)?.delete(untypedListener);
          }),
      ).pipe(Effect.asVoid);
    }),
  });
});

export const readMetadata = Effect.fn("LocalRebuildUpdater.readMetadata")(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  if (!environment.isPackaged || environment.platform !== "darwin") {
    return Option.none<LocalRebuildPackageMetadata>();
  }
  return yield* fileSystem
    .readFileString(environment.path.join(environment.appRoot, "package.json"))
    .pipe(Effect.flatMap(decodeLocalRebuildPackageMetadata), Effect.option);
});

// A packaged macOS build that carries t3codeLocalRebuild metadata rebuilds itself from that checkout.
export const layer = Layer.effect(
  ElectronUpdater.ElectronUpdater,
  Effect.gen(function* () {
    const metadata = yield* readMetadata();
    return Option.isSome(metadata) ? yield* make(metadata.value) : ElectronUpdater.make;
  }),
);
