import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ClientKind } from "./background.ts";
import { ClientSettingsPatch, ClientSettingsSchema } from "./settings.ts";

// Client-chosen per attach: RPC client ids are only unique within one WebSocket.
export const ClientSettingsConnectionId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type ClientSettingsConnectionId = typeof ClientSettingsConnectionId.Type;

export const ClientSettingsAttachInput = Schema.Struct({
  connectionId: ClientSettingsConnectionId,
  clientKind: ClientKind,
  settings: ClientSettingsSchema,
});
export type ClientSettingsAttachInput = typeof ClientSettingsAttachInput.Type;

export const ClientSettingsPatchRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  patch: ClientSettingsPatch,
});
export type ClientSettingsPatchRequest = typeof ClientSettingsPatchRequest.Type;

export const ClientSettingsReportInput = Schema.Struct({
  connectionId: ClientSettingsConnectionId,
  settings: ClientSettingsSchema,
  requestId: Schema.optionalKey(TrimmedNonEmptyString),
  error: Schema.optionalKey(Schema.String),
});
export type ClientSettingsReportInput = typeof ClientSettingsReportInput.Type;

/**
 * Fields agents may not change: onboarding and browser profiles, where the device's searches go,
 * and the confirmations that guard deleting, archiving and quitting.
 */
export const AgentClientSettingsPatch = ClientSettingsPatch.mapFields(
  Struct.omit([
    "onboardingCompletedAt",
    "browserProfiles",
    "browserDefaultProfileId",
    "browserSearchEngine",
    "browserCustomSearchUrl",
    "confirmThreadDelete",
    "confirmThreadArchive",
    "confirmQuit",
  ]),
);
export type AgentClientSettingsPatch = typeof AgentClientSettingsPatch.Type;
