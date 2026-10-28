import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SecretRequestError,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ProviderInstanceConfig,
  ProviderInstanceMutation,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ClientSettingsRegistry from "../../../clientSettings/ClientSettingsRegistry.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as Keybindings from "../../../keybindings.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as EnvironmentHandlers from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:preferences");
const threadId = ThreadId.make("thread:preferences");

it.effect("refuses a preferences update when the caller's turn ends while it waits", () =>
  Effect.gen(function* () {
    const caller = yield* Ref.make<OrchestrationV2ThreadShell>(liveThreadShell(threadId));
    const updates = yield* Ref.make(0);
    const checked = yield* Deferred.make<void>();
    const layerDependencies = Layer.mergeAll(
      ThreadCommandExecutor.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "provider:preferences",
        thread: {
          threadId,
          providerSessionId: "provider:preferences",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Ref.get(caller).pipe(Effect.tap(() => Deferred.succeed(checked, undefined))),
      }),
      Layer.mock(Environment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId,
          label: "Test",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0",
          capabilities: { repositoryIdentity: false },
        }),
      }),
      Layer.mock(Settings.ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        updateSettings: () =>
          Ref.update(updates, (count) => count + 1).pipe(Effect.as(DEFAULT_SERVER_SETTINGS)),
      }),
    );
    yield* Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* executor
        .withLock(
          threadId,
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const update = yield* toolkit
        .handle("t3_environment_preferences_update", { newWorktreesStartFromOrigin: true })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.forkChild);
      yield* Deferred.await(checked);
      yield* Ref.update(caller, (shell) => ({ ...shell, activeRunId: null }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      const result = yield* Fiber.join(update);
      expect(result.at(-1)?.result).toMatchObject({ code: "parent_not_active" });
      expect(yield* Ref.get(updates)).toBe(0);
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
          Layer.provideMerge(layerDependencies),
        ),
      ),
    );
  }),
);

const antigravity = ProviderInstanceId.make("antigravity");
const antigravityDriver = ProviderDriverKind.make("antigravity");

const settingsHarness = Effect.fn(function* (initial: ServerSettings) {
  const mutations = yield* Ref.make<ReadonlyArray<ProviderInstanceMutation>>([]);
  const patches = yield* Ref.make<ReadonlyArray<unknown>>([]);
  const secrets = yield* Ref.make<ReadonlyMap<string, string>>(
    new Map([["ref-1", "sk-from-user"]]),
  );
  const consumedBy = yield* Ref.make<ReadonlyArray<ProjectId>>([]);
  const upserts = yield* Ref.make<ReadonlyArray<string>>([]);
  const clientPatches = yield* Ref.make<ReadonlyArray<unknown>>([]);
  const layer = McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ThreadCommandExecutor.layer,
        Layer.mock(ClientSettingsRegistry.ClientSettingsRegistry)({
          update: (clientId, patch) =>
            clientId === "tab-1"
              ? Ref.update(clientPatches, (all) => [...all, patch]).pipe(
                  Effect.as({ ...DEFAULT_CLIENT_SETTINGS, ...patch }),
                )
              : Effect.fail(
                  new ClientSettingsRegistry.ClientSettingsUpdateError({
                    reason: "unavailable",
                    message: `Client ${clientId} is not connected; read the live clients again.`,
                  }),
                ),
        }),
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId,
          requestNamespace: "provider:settings",
          thread: {
            threadId,
            providerSessionId: "provider:settings",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
        }),
        Layer.mock(Environment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId,
            label: "Test",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0",
            capabilities: { repositoryIdentity: false },
          }),
        }),
        Layer.mock(Settings.ServerSettingsService)({
          getSettings: Effect.succeed(initial),
          updateSettings: (patch) =>
            Ref.update(patches, (all) => [...all, patch]).pipe(Effect.as(initial)),
          updateProviderInstance: (mutation) =>
            Ref.update(mutations, (all) => [...all, mutation]).pipe(
              Effect.as(Settings.applyProviderInstanceMutation(initial, mutation)),
            ),
        }),
        Layer.mock(Keybindings.Keybindings)({
          getSnapshot: Effect.succeed({ keybindings: [], issues: [] }),
          upsertKeybindingRule: (rule) =>
            Ref.update(upserts, (all) => [...all, rule.command]).pipe(Effect.as([])),
        }),
        Layer.mock(SecretRequests.SecretRequests)({
          consume: ({ ref, projectId }) =>
            Effect.gen(function* () {
              const value = (yield* Ref.get(secrets)).get(ref);
              if (value === undefined)
                return yield* new SecretRequestError({ reason: "ref_unavailable" });
              yield* Ref.update(secrets, (stored) => {
                const next = new Map(stored);
                next.delete(ref);
                return next;
              });
              yield* Ref.update(consumedBy, (all) => [...all, projectId]);
              return value;
            }),
        }),
        NodeServices.layer,
      ),
    ),
  );
  const read = Effect.gen(function* () {
    const toolkit = yield* EnvironmentToolkit;
    const results = yield* toolkit
      .handle("t3_settings_read", {})
      .pipe(Stream.unwrap, Stream.runCollect);
    return results.at(-1)?.encodedResult;
  }).pipe(Effect.provide(layer));
  const update = (params: {
    readonly patch?: Readonly<Record<string, unknown>>;
    readonly providerInstanceMutation?: typeof ProviderInstanceMutation.Encoded;
  }) =>
    Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      const results = yield* toolkit
        .handle("t3_settings_update", params)
        .pipe(Stream.unwrap, Stream.runCollect);
      return results.at(-1)?.encodedResult;
    }).pipe(Effect.provide(layer));
  const upsertKeybinding = (params: { readonly key: string; readonly command: string }) =>
    Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      const results = yield* toolkit
        .handle("t3_keybinding_upsert", params)
        .pipe(Stream.unwrap, Stream.runCollect);
      return results.at(-1)?.encodedResult;
    }).pipe(Effect.provide(layer));
  const updateClient = (params: {
    readonly clientId: string;
    readonly patch: Readonly<Record<string, unknown>>;
  }) =>
    Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      const results = yield* toolkit
        .handle("t3_client_settings_update", params)
        .pipe(Stream.unwrap, Stream.runCollect);
      return results.at(-1)?.encodedResult;
    }).pipe(Effect.provide(layer));
  return {
    read,
    update,
    upsertKeybinding,
    updateClient,
    mutations,
    patches,
    consumedBy,
    upserts,
    clientPatches,
  };
});

it.effect("passes an app settings patch to the client and returns what it saved", () =>
  Effect.gen(function* () {
    const harness = yield* settingsHarness(DEFAULT_SERVER_SETTINGS);
    const result = yield* harness.updateClient({
      clientId: "tab-1",
      patch: { sidebarWorkingShelfEnabled: false },
    });
    expect(result).toMatchObject({ sidebarWorkingShelfEnabled: false });
    expect(yield* Ref.get(harness.clientPatches)).toEqual([{ sidebarWorkingShelfEnabled: false }]);
  }),
);

it.effect.each([
  { onboardingCompletedAt: null },
  { browserCustomSearchUrl: "https://attacker.example/?q=%s" },
  { confirmThreadDelete: false },
])("refuses an app settings patch agents may not make: %o", (patch) =>
  Effect.gen(function* () {
    const harness = yield* settingsHarness(DEFAULT_SERVER_SETTINGS);
    const result = yield* harness.updateClient({ clientId: "tab-1", patch });
    expect(result).toMatchObject({ code: "invalid_request" });
    expect(yield* Ref.get(harness.clientPatches)).toEqual([]);
  }),
);

it.effect("tells the agent when the client is no longer connected", () =>
  Effect.gen(function* () {
    const harness = yield* settingsHarness(DEFAULT_SERVER_SETTINGS);
    const result = yield* harness.updateClient({
      clientId: "tab-gone",
      patch: { sidebarWorkingShelfEnabled: false },
    });
    expect(result).toMatchObject({
      code: "orchestration_error",
      message: expect.stringContaining("not connected"),
    });
  }),
);

const upsertAntigravity = (instance: ProviderInstanceConfig): ProviderInstanceMutation => ({
  operation: "upsert",
  instanceId: antigravity,
  instance,
});

it.effect("returns every setting with provider secrets masked", () =>
  Effect.gen(function* () {
    const harness = yield* settingsHarness({
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [antigravity]: { driver: antigravityDriver, config: { apiKey: "sk-stored" } },
      },
    });
    const result = yield* harness.read;
    expect(JSON.stringify(result)).not.toContain("sk-stored");
    expect(result).toMatchObject({
      settings: { providerInstances: { [antigravity]: { driver: antigravityDriver } } },
    });
  }),
);

it.effect.each<{
  readonly name: string;
  readonly instance: ProviderInstanceConfig;
  readonly written: boolean;
}>([
  {
    name: "a raw secret config field",
    instance: { driver: antigravityDriver, config: { apiKey: "sk-raw" } },
    written: false,
  },
  {
    name: "a raw sensitive environment variable",
    instance: {
      driver: antigravityDriver,
      environment: [{ name: "API_TOKEN", value: "tok-raw", sensitive: true }],
    },
    written: false,
  },
  {
    name: "a plain environment variable",
    instance: {
      driver: antigravityDriver,
      environment: [{ name: "REGION", value: "eu", sensitive: false }],
    },
    written: true,
  },
  {
    name: "a masked secret it read earlier",
    instance: { driver: antigravityDriver, config: { apiKey: "••••••" } },
    written: true,
  },
  {
    name: "a cleared secret",
    instance: { driver: antigravityDriver, config: { apiKey: "" } },
    written: true,
  },
])("writes $name only when it is not a raw secret", ({ instance, written }) =>
  Effect.gen(function* () {
    const harness = yield* settingsHarness(DEFAULT_SERVER_SETTINGS);
    const result = yield* harness.update({ providerInstanceMutation: upsertAntigravity(instance) });
    expect((yield* Ref.get(harness.mutations)).length).toBe(written ? 1 : 0);
    if (!written) expect(result).toMatchObject({ code: "capability_denied" });
  }),
);

it.effect("writes a secret from a one-use secretRef the user entered", () =>
  Effect.gen(function* () {
    const harness = yield* settingsHarness(DEFAULT_SERVER_SETTINGS);
    const mutation = upsertAntigravity({
      driver: antigravityDriver,
      config: { apiKey: "secretRef:ref-1" },
    });
    const first = yield* harness.update({ providerInstanceMutation: mutation });
    expect(JSON.stringify(first)).not.toContain("sk-from-user");
    expect(yield* Ref.get(harness.mutations)).toMatchObject([
      { instance: { config: { apiKey: "sk-from-user" } } },
    ]);
    expect(yield* Ref.get(harness.consumedBy)).toEqual([ProjectId.make("project:mcp-test")]);

    const again = yield* harness.update({ providerInstanceMutation: mutation });
    expect(again).toMatchObject({ code: "invalid_request" });
    expect((yield* Ref.get(harness.mutations)).length).toBe(1);
  }),
);

it.effect("never writes a secretRef's value into a plain environment variable", () =>
  Effect.gen(function* () {
    const harness = yield* settingsHarness(DEFAULT_SERVER_SETTINGS);
    yield* harness.update({
      providerInstanceMutation: upsertAntigravity({
        driver: antigravityDriver,
        config: { apiKey: "secretRef:ref-1" },
        environment: [{ name: "LEAK", value: "secretRef:ref-1", sensitive: false }],
      }),
    });
    const written = JSON.stringify(yield* Ref.get(harness.mutations));
    expect(written.match(/sk-from-user/g)).toHaveLength(1);
  }),
);

it.effect("refuses a patch that does not match the settings schema", () =>
  Effect.gen(function* () {
    const harness = yield* settingsHarness(DEFAULT_SERVER_SETTINGS);
    const result = yield* harness.update({ patch: { newWorktreesStartFromOrigin: "yes" } });
    expect(result).toMatchObject({ code: "invalid_request" });
  }),
);

it.effect("refuses a patch that replaces every provider", () =>
  Effect.gen(function* () {
    const harness = yield* settingsHarness(DEFAULT_SERVER_SETTINGS);
    const result = yield* harness.update({ patch: { providerInstances: {} } });
    expect(result).toMatchObject({ code: "invalid_request" });
  }),
);

it.effect("saves a keybinding only for a command T3 knows", () =>
  Effect.gen(function* () {
    const harness = yield* settingsHarness(DEFAULT_SERVER_SETTINGS);
    const unknown = yield* harness.upsertKeybinding({ key: "mod+k", command: "thread.explode" });
    expect(unknown).toMatchObject({ code: "invalid_request" });
    yield* harness.upsertKeybinding({ key: "mod+k", command: "thread.stop" });
    expect(yield* Ref.get(harness.upserts)).toEqual(["thread.stop"]);
  }),
);

it.effect.each<{
  readonly name: string;
  readonly patch: Readonly<Record<string, unknown>>;
  readonly written: unknown;
}>([
  {
    name: "a source control host token",
    patch: { sourceControlHosts: { gitcafe: { token: "secretRef:ref-1" } } },
    written: { sourceControlHosts: { gitcafe: { token: "sk-from-user" } } },
  },
  {
    name: "a usage limit management key, keeping a removed source",
    patch: {
      usageLimitSources: {
        proxy: { kind: "cliproxy", url: "http://proxy.test", managementKey: "secretRef:ref-1" },
        gone: null,
      },
    },
    written: {
      usageLimitSources: { proxy: { managementKey: "sk-from-user" }, gone: null },
    },
  },
  {
    name: "an EAS access token",
    patch: {
      easDeviceHosts: [{ kind: "eas", id: "eas-1", label: "EAS", accessToken: "secretRef:ref-1" }],
    },
    written: { easDeviceHosts: [{ accessToken: "sk-from-user" }] },
  },
])("writes $name from a secretRef and refuses it raw", ({ patch, written }) =>
  Effect.gen(function* () {
    const raw = yield* settingsHarness(DEFAULT_SERVER_SETTINGS);
    const refused = yield* raw.update({
      patch: JSON.parse(JSON.stringify(patch).replace("secretRef:ref-1", "sk-raw")),
    });
    expect(refused).toMatchObject({ code: "capability_denied" });
    expect(yield* Ref.get(raw.patches)).toEqual([]);

    const harness = yield* settingsHarness(DEFAULT_SERVER_SETTINGS);
    yield* harness.update({ patch });
    expect(yield* Ref.get(harness.patches)).toMatchObject([written]);
  }),
);

it.effect("spends no secretRef when an update carries a second, unusable ref", () =>
  Effect.gen(function* () {
    const harness = yield* settingsHarness(DEFAULT_SERVER_SETTINGS);
    const result = yield* harness.update({
      providerInstanceMutation: upsertAntigravity({
        driver: antigravityDriver,
        config: { apiKey: "secretRef:ref-1" },
        environment: [{ name: "TOKEN", value: "secretRef:bogus", sensitive: true }],
      }),
    });
    expect(result).toMatchObject({ code: "invalid_request" });
    expect(yield* Ref.get(harness.consumedBy)).toEqual([]);
  }),
);

it.effect("refuses a patch with a field T3 does not have", () =>
  Effect.gen(function* () {
    const harness = yield* settingsHarness(DEFAULT_SERVER_SETTINGS);
    const result = yield* harness.update({ patch: { notASetting: true } });
    expect(result).toMatchObject({ code: "invalid_request" });
    expect(yield* Ref.get(harness.patches)).toEqual([]);
  }),
);
