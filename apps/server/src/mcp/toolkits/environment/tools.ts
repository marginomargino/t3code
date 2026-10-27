import {
  BackgroundActivityProfile,
  BackgroundActivityProfileSelection,
  ExecutionEnvironmentDescriptor,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ProviderInstanceMutation,
  ResolvedKeybindingsConfig,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as Keybindings from "../../../keybindings.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const PreferenceFields = {
  defaultThreadEnvMode: ServerSettings.fields.defaultThreadEnvMode,
  newWorktreesStartFromOrigin: ServerSettings.fields.newWorktreesStartFromOrigin,
  enableProviderUpdateChecks: ServerSettings.fields.enableProviderUpdateChecks,
  backgroundActivity: Schema.Struct({ profile: BackgroundActivityProfileSelection }),
  sourceControlWritingStyle: Schema.Struct({
    mode: Schema.String,
    followChangeRequestTemplates: Schema.Boolean,
    customInstructions: Schema.String,
    truncated: Schema.Boolean,
  }),
};
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerEnvironment.ServerEnvironment,
    Settings.ServerSettingsService,
    ThreadCommandExecutor.ThreadCommandExecutor,
  ],
};
// Plain strings: the full command enum would cost every agent ~5 KB. Handlers decode them.
const KeybindingRuleFields = {
  key: Schema.String,
  command: Schema.String,
  when: Schema.optionalKey(Schema.String),
};
const fullAccessOnly = "Live full-access or default caller thread only.";
const EnvironmentReadTool = Tool.make("t3_environment_read", {
  ...shared,
  description:
    "Read this server's identity and preferences. Providers and models: `orchestrator_capabilities`.",
  parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
  success: Schema.Struct({
    environmentId: ExecutionEnvironmentDescriptor.fields.environmentId,
    label: Schema.String,
    serverVersion: Schema.String,
    platform: ExecutionEnvironmentDescriptor.fields.platform,
    preferences: Schema.Struct(PreferenceFields),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const EnvironmentPreferencesTool = Tool.make("t3_environment_preferences_update", {
  ...shared,
  description:
    "Update environment-wide preferences. Live full-access or default caller thread only. Omitted fields are unchanged; `customInstructions: ''` clears it.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    defaultThreadEnvMode: ServerSettingsPatch.fields.defaultThreadEnvMode,
    newWorktreesStartFromOrigin: ServerSettingsPatch.fields.newWorktreesStartFromOrigin,
    enableProviderUpdateChecks: ServerSettingsPatch.fields.enableProviderUpdateChecks,
    backgroundActivity: Schema.optionalKey(Schema.Struct({ profile: BackgroundActivityProfile })),
    sourceControlWritingStyle: ServerSettingsPatch.fields.sourceControlWritingStyle,
  }),
  success: Schema.Struct(PreferenceFields),
}).annotate(Tool.Destructive, true);
const SettingsReadTool = Tool.make("t3_settings_read", {
  ...shared,
  description: "Read every environment setting and the keybindings. Secrets come back masked.",
  dependencies: [...shared.dependencies, Keybindings.Keybindings],
  success: Schema.Struct({ settings: ServerSettings, keybindings: ResolvedKeybindingsConfig }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const SettingsUpdateTool = Tool.make("t3_settings_update", {
  ...shared,
  description: `Update environment settings. ${fullAccessOnly} \`patch\` takes the fields \`t3_settings_read\` returns; omitted fields are unchanged, but a field inside \`sourceControlHosts.<kind>\` is replaced whole, so resend its masked entries. A secret field takes \`secretRef:<ref>\` from \`request_secret\`, never a raw value; a masked value keeps the stored secret. Change providers one at a time with \`providerInstanceMutation\`.`,
  dependencies: [
    ...shared.dependencies,
    SecretRequests.SecretRequests,
    ChildProcessSpawner.ChildProcessSpawner,
    FileSystem.FileSystem,
    Path.Path,
  ],
  parameters: Schema.Struct({
    patch: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    providerInstanceMutation: Schema.optionalKey(ProviderInstanceMutation),
  }),
  success: ServerSettings,
}).annotate(Tool.Destructive, true);
const KeybindingUpsertTool = Tool.make("t3_keybinding_upsert", {
  ...shared,
  description: `Add or replace a keybinding. ${fullAccessOnly} Rule fields and command ids match the keybindings \`t3_settings_read\` returns; \`replace\` names the rule to swap out.`,
  dependencies: [...shared.dependencies, Keybindings.Keybindings],
  parameters: Schema.Struct({
    ...KeybindingRuleFields,
    replace: Schema.optionalKey(Schema.Struct(KeybindingRuleFields)),
  }),
  success: ResolvedKeybindingsConfig,
}).annotate(Tool.Destructive, true);
const KeybindingRemoveTool = Tool.make("t3_keybinding_remove", {
  ...shared,
  description: `Remove a keybinding. ${fullAccessOnly}`,
  dependencies: [...shared.dependencies, Keybindings.Keybindings],
  parameters: Schema.Struct(KeybindingRuleFields),
  success: ResolvedKeybindingsConfig,
}).annotate(Tool.Destructive, true);
export const EnvironmentToolkit = Toolkit.make(
  EnvironmentReadTool,
  EnvironmentPreferencesTool,
  SettingsReadTool,
  SettingsUpdateTool,
  KeybindingUpsertTool,
  KeybindingRemoveTool,
);
