import {
  AgentClientSettingsPatch,
  OrchestratorMcpFailure,
  type ProjectId,
  SecretRef,
  ServerRemoveKeybindingInput,
  ServerUpsertKeybindingInput,
  type ServerSettings,
  ServerSettingsPatch,
  type ProviderInstanceMutation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ClientSettingsRegistry from "../../../clientSettings/ClientSettingsRegistry.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as Keybindings from "../../../keybindings.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as Settings from "../../../serverSettings.ts";
import { mapSettingsUpdateSecrets } from "../../../settingsSecrets.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { EnvironmentToolkit } from "./tools.ts";

export function preferences(settings: ServerSettings) {
  const {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity,
    sourceControlWritingStyle,
  } = settings;
  const characters = Array.from(sourceControlWritingStyle.customInstructions);
  return {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity: { profile: backgroundActivity.profile },
    sourceControlWritingStyle: {
      ...sourceControlWritingStyle,
      customInstructions: characters.slice(0, 4000).join(""),
      truncated: characters.length > 4000,
    },
  };
}
const access = Effect.gen(function* () {
  const context = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== context.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  return { ...context, descriptor, settings: yield* Settings.ServerSettingsService };
});
const SECRET_REF_PREFIX = "secretRef:";
const decodeSecretRef = Schema.decodeUnknownOption(SecretRef);
// Tools advertise loose inputs (full schemas would cost every agent ~25 KB) and decode here.
const decodeOrInvalid = <S extends Schema.Top>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      (error) => new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
    ),
  );
const rejected = (error: { readonly message: string }, note = "") =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message + note });

interface SettingsUpdate {
  readonly patch: ServerSettingsPatch;
  readonly providerInstanceMutation?: ProviderInstanceMutation | undefined;
}

/** Agents never write raw secrets: each one must be a one-use ref the user entered. */
const resolveSecretRefs = Effect.fn("EnvironmentHandlers.resolveSecretRefs")(function* (
  update: SettingsUpdate,
  projectId: ProjectId | undefined,
) {
  const refs = new Set<string>();
  let raw = false;
  mapSettingsUpdateSecrets(update, (secret) => {
    if (secret.sensitive && !secret.redacted && secret.value !== "") {
      if (secret.value.startsWith(SECRET_REF_PREFIX)) {
        refs.add(secret.value.slice(SECRET_REF_PREFIX.length));
      } else {
        raw = true;
      }
    }
    return secret;
  });
  if (raw)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Secret fields take `secretRef:<ref>` from `request_secret`, never a raw value.",
    });
  if (refs.size === 0) return { update, spentRefs: false };
  if (projectId === undefined)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Writing a secret needs a calling thread.",
    });
  // A consumed ref cannot be given back, so a later bad ref would burn an earlier one.
  if (refs.size > 1)
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "Write one secret per update.",
    });
  const [ref] = refs;
  const decoded = decodeSecretRef(ref);
  if (ref === undefined || Option.isNone(decoded))
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "That secretRef is not valid.",
    });
  const secretRequests = yield* SecretRequests.SecretRequests;
  const value = yield* secretRequests
    .consume({ ref: decoded.value, projectId })
    .pipe(
      Effect.mapError(
        (error) => new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
      ),
    );
  const values = new Map([[ref, value]]);
  const resolved = mapSettingsUpdateSecrets(update, (secret) => {
    const value =
      secret.sensitive && secret.value.startsWith(SECRET_REF_PREFIX)
        ? values.get(secret.value.slice(SECRET_REF_PREFIX.length))
        : undefined;
    return value === undefined ? secret : { value, redacted: false };
  });
  return { update: resolved, spentRefs: true };
});

const withCallerLock = Effect.fn("EnvironmentHandlers.withCallerLock")(function* <A, E, R>(
  update: Effect.Effect<A, E, R>,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  return yield* scope.thread === undefined
    ? update
    : executor.withLock(scope.thread.threadId, update);
});

export const layer = McpToolAccess.toLayer(EnvironmentToolkit, {
  t3_environment_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { descriptor, settings } = yield* access;
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        serverVersion: descriptor.serverVersion,
        platform: descriptor.platform,
        preferences: preferences(current),
      };
    }),
  ),
  t3_environment_preferences_update: McpToolAccess.writesEnvironment((patch, check) =>
    withCallerLock(
      Effect.gen(function* () {
        // The turn may have ended, or the thread's modes changed, while this waited for the lock.
        yield* check;
        const { settings } = yield* access;
        return preferences(
          yield* settings.updateSettings(patch).pipe(Effect.mapError(unavailable)),
        );
      }),
    ),
  ),
  t3_settings_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { settings } = yield* access;
      const keybindings = yield* Keybindings.Keybindings;
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      const snapshot = yield* keybindings.getSnapshot.pipe(Effect.mapError(unavailable));
      return {
        settings: Settings.redactServerSettingsForClient(current, { secretReferences: true }),
        keybindings: snapshot.keybindings,
      };
    }),
  ),
  t3_settings_update: McpToolAccess.writesEnvironment(
    ({ patch: rawPatch = {}, providerInstanceMutation }, check) =>
      withCallerLock(
        Effect.gen(function* () {
          // The turn may have ended, or the thread's modes changed, while this waited for the lock.
          const { caller } = yield* check;
          const patch = yield* decodeOrInvalid(ServerSettingsPatch, rawPatch);
          if (patch.providerInstances !== undefined)
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message:
                "`patch.providerInstances` replaces every provider; use `providerInstanceMutation`.",
            });
          const { settings } = yield* access;
          const { update, spentRefs } = yield* resolveSecretRefs(
            { patch, providerInstanceMutation },
            caller?.projectId,
          );
          return yield* Settings.applyClientSettingsUpdate(settings, update, {
            secretReferences: true,
          }).pipe(
            Effect.mapError((error) =>
              rejected(
                error,
                spentRefs
                  ? " The secretRef was spent; ask the user again with request_secret."
                  : "",
              ),
            ),
          );
        }),
      ),
  ),
  t3_client_settings_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      yield* access;
      const registry = yield* ClientSettingsRegistry.ClientSettingsRegistry;
      return { clients: yield* registry.list };
    }),
  ),
  t3_client_settings_update: McpToolAccess.writesEnvironment(
    ({ clientId, patch: rawPatch }, check) =>
      withCallerLock(
        Effect.gen(function* () {
          // The turn may have ended, or the thread's modes changed, while this waited for the lock.
          yield* check;
          yield* access;
          const patch = yield* decodeOrInvalid(AgentClientSettingsPatch, rawPatch);
          const registry = yield* ClientSettingsRegistry.ClientSettingsRegistry;
          return yield* registry
            .update(clientId, patch)
            .pipe(Effect.mapError((error) => rejected(error)));
        }),
      ),
  ),
  t3_keybinding_upsert: McpToolAccess.writesEnvironment((rule, check) =>
    withCallerLock(
      Effect.gen(function* () {
        yield* check;
        const input = yield* decodeOrInvalid(ServerUpsertKeybindingInput, rule);
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.upsertKeybindingRule(input).pipe(
          Effect.map((state) => state.keybindings),
          Effect.mapError((error) => rejected(error)),
        );
      }),
    ),
  ),
  t3_keybinding_remove: McpToolAccess.writesEnvironment((rule, check) =>
    withCallerLock(
      Effect.gen(function* () {
        yield* check;
        const input = yield* decodeOrInvalid(ServerRemoveKeybindingInput, rule);
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.removeKeybindingRule(input).pipe(
          Effect.map((state) => state.keybindings),
          Effect.mapError((error) => rejected(error)),
        );
      }),
    ),
  ),
});
