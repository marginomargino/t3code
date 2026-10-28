import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { request, subscribeDynamic } from "@t3tools/client-runtime/rpc";
import {
  type ClientSettingsPatchRequest,
  type ClientSettingsReportInput,
  type EnvironmentId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { randomUUID } from "./utils";

/** Lets agents read and patch this device's client settings through each connected server. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (typeof window === "undefined") return;
    // Loaded lazily: useSettings reaches the connection catalog, which imports this runtime.
    const settings = yield* Effect.promise(() => import("../hooks/useSettings"));
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const connectionId = randomUUID();
    const clientKind = window.desktopBridge ? "desktop-renderer" : "web";

    // Reporting defaults before hydration would show agents settings this device does not have.
    // Forked below so a slow or failed hydration never holds up the connection runtime.
    const awaitHydrated = Effect.callback<void>((resume) => {
      if (settings.getClientSettingsHydratedSnapshot()) return resume(Effect.void);
      const unsubscribe = settings.subscribeClientSettingsHydration(() => {
        if (!settings.getClientSettingsHydratedSnapshot()) return;
        unsubscribe();
        resume(Effect.void);
      });
      return Effect.sync(unsubscribe);
    });

    const report = (
      environmentId: EnvironmentId,
      input: Omit<ClientSettingsReportInput, "connectionId">,
    ) =>
      registry
        .run(environmentId, request(WS_METHODS.clientSettingsReport, { connectionId, ...input }))
        // Not `ignore`: an interrupt leaking out of a torn-down environment would end the loop.
        .pipe(Effect.ignoreCause);

    const apply = (
      environmentId: EnvironmentId,
      { requestId, patch }: ClientSettingsPatchRequest,
    ) =>
      Effect.promise(() =>
        settings
          .persistClientSettingsUpdate((current) => ({ ...current, ...patch }))
          .then(
            (saved) => ({ settings: saved }),
            (error: unknown) => ({
              settings: settings.getClientSettings(),
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
      ).pipe(Effect.flatMap((result) => report(environmentId, { requestId, ...result })));

    const attached = new Set<EnvironmentId>();
    const attach = (environmentId: EnvironmentId) =>
      registry
        .followStream(
          environmentId,
          subscribeDynamic(WS_METHODS.subscribeClientSettingsPatches, () =>
            Effect.sync(() => ({
              connectionId,
              clientKind,
              settings: settings.getClientSettings(),
            })),
          ),
        )
        .pipe(
          Stream.runForEach((patchRequest) => apply(environmentId, patchRequest)),
          Effect.ignoreCause,
          // A failed subscription ends the stream; the next registry change attaches again.
          Effect.ensuring(Effect.sync(() => attached.delete(environmentId))),
          Effect.forkScoped,
        );

    const attachEnvironments = Stream.concat(
      Stream.fromEffect(SubscriptionRef.get(registry.entries)),
      SubscriptionRef.changes(registry.entries),
    ).pipe(
      Stream.runForEach((entries) =>
        Effect.forEach(
          entries.keys(),
          (environmentId) => {
            // followStream already idles while an environment is gone and resumes when it returns.
            if (attached.has(environmentId)) return Effect.void;
            attached.add(environmentId);
            return attach(environmentId);
          },
          { discard: true },
        ),
      ),
    );

    const changes = yield* Queue.sliding<void>(1);
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        settings.subscribeClientSettings(() => Queue.offerUnsafe(changes, undefined)),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    );
    const reportChanges = Stream.fromQueue(changes).pipe(
      Stream.debounce("250 millis"),
      Stream.runForEach(() =>
        Effect.gen(function* () {
          const entries = yield* SubscriptionRef.get(registry.entries);
          const current = settings.getClientSettings();
          yield* Effect.forEach(
            entries.keys(),
            (environmentId) => report(environmentId, { settings: current }),
            { concurrency: "unbounded", discard: true },
          );
        }),
      ),
    );

    yield* awaitHydrated.pipe(
      Effect.andThen(Effect.all([attachEnvironments, reportChanges], { concurrency: 2 })),
      Effect.forkScoped,
    );
  }),
);
