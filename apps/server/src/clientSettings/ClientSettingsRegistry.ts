// Client settings live on each device; live web and desktop clients attach here so agents can
// read and patch them. Nothing is persisted: a client that is not connected is not listed.
import type {
  AgentClientSettingsPatch,
  AuthClientMetadata,
  AuthSessionId,
  ClientKind,
  ClientSettings,
  ClientSettingsAttachInput,
  ClientSettingsPatchRequest,
  ClientSettingsReportInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export const CLIENT_SETTINGS_UPDATE_TIMEOUT = "10 seconds";
const MAX_CLIENT_ERROR_LENGTH = 300;

export class ClientSettingsUpdateError extends Schema.TaggedError<ClientSettingsUpdateError>()(
  "ClientSettingsUpdateError",
  {
    reason: Schema.Literals(["unavailable", "timeout", "rejected"]),
    message: Schema.String,
  },
) {}

export interface ConnectedClient {
  readonly clientId: string;
  readonly kind: ClientKind;
  readonly label?: string;
  readonly os?: string;
  readonly browser?: string;
  readonly settings: ClientSettings;
}

interface Entry {
  readonly sessionId: AuthSessionId;
  readonly clientKind: ClientKind;
  readonly client: AuthClientMetadata | undefined;
  readonly settings: ClientSettings;
  readonly queue: Queue.Queue<ClientSettingsPatchRequest>;
}

interface Pending {
  readonly clientId: string;
  readonly deferred: Deferred.Deferred<ClientSettings, ClientSettingsUpdateError>;
}

export class ClientSettingsRegistry extends Context.Service<
  ClientSettingsRegistry,
  {
    readonly attach: (
      sessionId: AuthSessionId,
      input: ClientSettingsAttachInput,
      client: AuthClientMetadata | undefined,
    ) => Stream.Stream<ClientSettingsPatchRequest>;
    readonly report: (
      sessionId: AuthSessionId,
      input: ClientSettingsReportInput,
    ) => Effect.Effect<void>;
    readonly list: Effect.Effect<ReadonlyArray<ConnectedClient>>;
    readonly update: (
      clientId: string,
      patch: AgentClientSettingsPatch,
    ) => Effect.Effect<ClientSettings, ClientSettingsUpdateError>;
  }
>()("t3/clientSettings/ClientSettingsRegistry") {}

const unavailable = (clientId: string) =>
  new ClientSettingsUpdateError({
    reason: "unavailable",
    message: `Client ${clientId} is not connected; read the live clients again.`,
  });

const make = Effect.gen(function* () {
  const entries = yield* Ref.make(new Map<string, Entry>());
  const pending = yield* Ref.make(new Map<string, Pending>());
  const nextRequestId = yield* Ref.make(0);

  const takePending = (requestId: string, clientId?: string) =>
    Ref.modify(pending, (current) => {
      const found = current.get(requestId);
      // A report naming another client's request must not cancel it.
      if (found === undefined || (clientId !== undefined && found.clientId !== clientId))
        return [undefined, current] as const;
      const next = new Map(current);
      next.delete(requestId);
      return [found, next] as const;
    });

  const detach = Effect.fnUntraced(function* (clientId: string, queue: Entry["queue"]) {
    // A reconnect may have re-attached under the same id before this finalizer ran.
    // Reports replace the entry, so the queue is what identifies this attachment.
    const removed = yield* Ref.modify(entries, (current) => {
      if (current.get(clientId)?.queue !== queue) return [false, current] as const;
      const next = new Map(current);
      next.delete(clientId);
      return [true, next] as const;
    });
    if (!removed) return;
    const orphaned = yield* Ref.modify(pending, (current) => {
      const next = new Map(current);
      const found: Array<Pending> = [];
      for (const [requestId, request] of current) {
        if (request.clientId !== clientId) continue;
        found.push(request);
        next.delete(requestId);
      }
      return [found, next] as const;
    });
    yield* Effect.forEach(
      orphaned,
      (request) => Deferred.fail(request.deferred, unavailable(clientId)),
      { discard: true },
    );
  });

  const attach: ClientSettingsRegistry["Service"]["attach"] = (sessionId, input, client) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<ClientSettingsPatchRequest>();
        const entry: Entry = {
          sessionId,
          clientKind: input.clientKind,
          client,
          settings: input.settings,
          queue,
        };
        const attached = yield* Ref.modify(entries, (current) => {
          // Ids are listed to agents; another session must not take one over and its patches.
          const owner = current.get(input.connectionId)?.sessionId;
          if (owner !== undefined && owner !== sessionId) return [false, current] as const;
          return [true, new Map(current).set(input.connectionId, entry)] as const;
        });
        if (!attached) return Stream.empty;
        return Stream.fromQueue(queue).pipe(Stream.ensuring(detach(input.connectionId, queue)));
      }),
    ).pipe(Stream.withSpan("ClientSettingsRegistry.attach"));

  const report: ClientSettingsRegistry["Service"]["report"] = Effect.fn(
    "ClientSettingsRegistry.report",
  )(function* (sessionId, input) {
    const accepted = yield* Ref.modify(entries, (current) => {
      const entry = current.get(input.connectionId);
      // Only the session that attached a client may speak for it.
      if (entry === undefined || entry.sessionId !== sessionId) return [false, current] as const;
      return [
        true,
        new Map(current).set(input.connectionId, { ...entry, settings: input.settings }),
      ] as const;
    });
    if (!accepted || input.requestId === undefined) return;
    const request = yield* takePending(input.requestId, input.connectionId);
    if (request === undefined) return;
    yield* input.error === undefined
      ? Deferred.succeed(request.deferred, input.settings)
      : Deferred.fail(
          request.deferred,
          new ClientSettingsUpdateError({
            reason: "rejected",
            // Client-supplied text reaches the agent; keep it to a short reason.
            message: `The client could not save the change: ${input.error.slice(0, MAX_CLIENT_ERROR_LENGTH)}`,
          }),
        );
  });

  const list: ClientSettingsRegistry["Service"]["list"] = Ref.get(entries).pipe(
    Effect.map((current) =>
      Array.from(current, ([clientId, { client, clientKind, settings }]): ConnectedClient => ({
        clientId,
        kind: clientKind,
        ...(client?.label === undefined ? {} : { label: client.label }),
        ...(client?.os === undefined ? {} : { os: client.os }),
        ...(client?.browser === undefined ? {} : { browser: client.browser }),
        settings,
      })),
    ),
  );

  const update: ClientSettingsRegistry["Service"]["update"] = Effect.fn(
    "ClientSettingsRegistry.update",
  )(function* (clientId, patch) {
    const entry = (yield* Ref.get(entries)).get(clientId);
    if (entry === undefined) return yield* unavailable(clientId);
    const requestId = String(yield* Ref.updateAndGet(nextRequestId, (n) => n + 1));
    const deferred = yield* Deferred.make<ClientSettings, ClientSettingsUpdateError>();
    yield* Ref.update(pending, (current) =>
      new Map(current).set(requestId, {
        clientId,
        deferred,
      }),
    );
    // The client may have detached after the lookup, before its pending requests were swept.
    if ((yield* Ref.get(entries)).get(clientId)?.queue !== entry.queue) {
      yield* takePending(requestId);
      return yield* unavailable(clientId);
    }
    yield* Queue.offer(entry.queue, { requestId, patch });
    return yield* Deferred.await(deferred).pipe(
      Effect.timeoutOrElse({
        duration: CLIENT_SETTINGS_UPDATE_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new ClientSettingsUpdateError({
              reason: "timeout",
              message: `Client ${clientId} did not confirm the change in time.`,
            }),
          ),
      }),
      Effect.ensuring(takePending(requestId)),
    );
  });

  return ClientSettingsRegistry.of({ attach, report, list, update });
});

export const layer = Layer.effect(ClientSettingsRegistry, make);
