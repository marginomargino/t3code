import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  type ClientSettingsPatchRequest,
  DEFAULT_CLIENT_SETTINGS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ClientSettingsRegistry from "./ClientSettingsRegistry.ts";

const SESSION = AuthSessionId.make("session-1");
const LAPTOP = { deviceType: "desktop", label: "MacBook", os: "macOS", browser: "Chrome" } as const;

const attachClient = (connectionId: string, sessionId = SESSION) =>
  Effect.gen(function* () {
    const registry = yield* ClientSettingsRegistry.ClientSettingsRegistry;
    const received = yield* Queue.unbounded<ClientSettingsPatchRequest>();
    const fiber = yield* registry
      .attach(
        sessionId,
        { connectionId, clientKind: "web", settings: DEFAULT_CLIENT_SETTINGS },
        LAPTOP,
      )
      .pipe(
        Stream.runForEach((request) => Queue.offer(received, request)),
        Effect.forkChild({ startImmediately: true }),
      );
    return { received, fiber };
  });

const startUpdate = (clientId: string) =>
  Effect.gen(function* () {
    const registry = yield* ClientSettingsRegistry.ClientSettingsRegistry;
    return yield* registry
      .update(clientId, { sidebarWorkingShelfEnabled: false })
      .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
  });

const failureReason = (
  exit: Exit.Exit<unknown, ClientSettingsRegistry.ClientSettingsUpdateError>,
) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error.reason
    : undefined;

describe("ClientSettingsRegistry", () => {
  it.effect("lists an attached client with its settings and session label", () =>
    Effect.gen(function* () {
      const registry = yield* ClientSettingsRegistry.ClientSettingsRegistry;
      yield* attachClient("tab-1");
      const clients = yield* registry.list;
      assert.deepStrictEqual(clients, [
        {
          clientId: "tab-1",
          kind: "web",
          label: "MacBook",
          os: "macOS",
          browser: "Chrome",
          settings: DEFAULT_CLIENT_SETTINGS,
        },
      ]);
    }).pipe(Effect.provide(ClientSettingsRegistry.layer)),
  );

  it.effect("sends the patch to the client and resolves with what it saved", () =>
    Effect.gen(function* () {
      const registry = yield* ClientSettingsRegistry.ClientSettingsRegistry;
      const { received } = yield* attachClient("tab-1");
      const update = yield* startUpdate("tab-1");
      const request = yield* Queue.take(received);
      assert.deepStrictEqual(request.patch, { sidebarWorkingShelfEnabled: false });
      const saved = { ...DEFAULT_CLIENT_SETTINGS, sidebarWorkingShelfEnabled: false };
      yield* registry.report(SESSION, {
        connectionId: "tab-1",
        requestId: request.requestId,
        settings: saved,
      });
      const exit = yield* Fiber.join(update);
      assert.deepStrictEqual(exit, Exit.succeed(saved));
      const [client] = yield* registry.list;
      assert.strictEqual(client?.settings.sidebarWorkingShelfEnabled, false);
    }).pipe(Effect.provide(ClientSettingsRegistry.layer)),
  );

  it.effect("fails the update when the client could not save it", () =>
    Effect.gen(function* () {
      const registry = yield* ClientSettingsRegistry.ClientSettingsRegistry;
      const { received } = yield* attachClient("tab-1");
      const update = yield* startUpdate("tab-1");
      const request = yield* Queue.take(received);
      yield* registry.report(SESSION, {
        connectionId: "tab-1",
        requestId: request.requestId,
        settings: DEFAULT_CLIENT_SETTINGS,
        error: "QuotaExceededError",
      });
      assert.strictEqual(failureReason(yield* Fiber.join(update)), "rejected");
    }).pipe(Effect.provide(ClientSettingsRegistry.layer)),
  );

  it.effect("ignores a report from a session that did not attach the client", () =>
    Effect.gen(function* () {
      const registry = yield* ClientSettingsRegistry.ClientSettingsRegistry;
      yield* attachClient("tab-1");
      yield* registry.report(AuthSessionId.make("session-2"), {
        connectionId: "tab-1",
        settings: { ...DEFAULT_CLIENT_SETTINGS, sidebarWorkingShelfEnabled: false },
      });
      const [client] = yield* registry.list;
      assert.strictEqual(client?.settings.sidebarWorkingShelfEnabled, true);
    }).pipe(Effect.provide(ClientSettingsRegistry.layer)),
  );

  it.effect("fails an update for a client that is not connected", () =>
    Effect.gen(function* () {
      const update = yield* startUpdate("tab-missing");
      assert.strictEqual(failureReason(yield* Fiber.join(update)), "unavailable");
    }).pipe(Effect.provide(ClientSettingsRegistry.layer)),
  );

  it.effect("drops a disconnected client and fails its pending update", () =>
    Effect.gen(function* () {
      const registry = yield* ClientSettingsRegistry.ClientSettingsRegistry;
      const { received, fiber } = yield* attachClient("tab-1");
      const update = yield* startUpdate("tab-1");
      yield* Queue.take(received);
      yield* Fiber.interrupt(fiber);
      assert.strictEqual(failureReason(yield* Fiber.join(update)), "unavailable");
      assert.deepStrictEqual(yield* registry.list, []);
    }).pipe(Effect.provide(ClientSettingsRegistry.layer)),
  );

  it.effect("keeps an update pending when another client reports its request id", () =>
    Effect.gen(function* () {
      const registry = yield* ClientSettingsRegistry.ClientSettingsRegistry;
      const { received } = yield* attachClient("tab-1");
      const other = AuthSessionId.make("session-2");
      yield* attachClient("tab-2", other);
      const update = yield* startUpdate("tab-1");
      const request = yield* Queue.take(received);
      yield* registry.report(other, {
        connectionId: "tab-2",
        requestId: request.requestId,
        settings: DEFAULT_CLIENT_SETTINGS,
        error: "forged",
      });
      const saved = { ...DEFAULT_CLIENT_SETTINGS, sidebarWorkingShelfEnabled: false };
      yield* registry.report(SESSION, {
        connectionId: "tab-1",
        requestId: request.requestId,
        settings: saved,
      });
      assert.deepStrictEqual(yield* Fiber.join(update), Exit.succeed(saved));
    }).pipe(Effect.provide(ClientSettingsRegistry.layer)),
  );

  it.effect("drops a client that disconnects after it reported", () =>
    Effect.gen(function* () {
      const registry = yield* ClientSettingsRegistry.ClientSettingsRegistry;
      const { fiber } = yield* attachClient("tab-1");
      yield* registry.report(SESSION, { connectionId: "tab-1", settings: DEFAULT_CLIENT_SETTINGS });
      yield* Fiber.interrupt(fiber);
      assert.deepStrictEqual(yield* registry.list, []);
    }).pipe(Effect.provide(ClientSettingsRegistry.layer)),
  );

  it.effect("refuses another session attaching under a listed client id", () =>
    Effect.gen(function* () {
      const registry = yield* ClientSettingsRegistry.ClientSettingsRegistry;
      const { received } = yield* attachClient("tab-1");
      const intruder = yield* attachClient("tab-1", AuthSessionId.make("session-2"));
      const update = yield* startUpdate("tab-1");
      const [recipient, request] = yield* Effect.raceFirst(
        Queue.take(received).pipe(Effect.map((request) => ["owner", request] as const)),
        Queue.take(intruder.received).pipe(Effect.map((request) => ["intruder", request] as const)),
      );
      assert.strictEqual(recipient, "owner");
      yield* registry.report(SESSION, {
        connectionId: "tab-1",
        requestId: request.requestId,
        settings: DEFAULT_CLIENT_SETTINGS,
      });
      assert.isTrue(Exit.isSuccess(yield* Fiber.join(update)));
    }).pipe(Effect.provide(ClientSettingsRegistry.layer)),
  );

  it.effect("keeps a client that re-attached before its old stream finished", () =>
    Effect.gen(function* () {
      const registry = yield* ClientSettingsRegistry.ClientSettingsRegistry;
      const first = yield* attachClient("tab-1");
      yield* attachClient("tab-1");
      yield* Fiber.interrupt(first.fiber);
      assert.deepStrictEqual(
        (yield* registry.list).map((client) => client.clientId),
        ["tab-1"],
      );
    }).pipe(Effect.provide(ClientSettingsRegistry.layer)),
  );

  it.effect("times out when the client never confirms", () =>
    Effect.gen(function* () {
      const { received } = yield* attachClient("tab-1");
      const update = yield* startUpdate("tab-1");
      yield* Queue.take(received);
      yield* TestClock.adjust(ClientSettingsRegistry.CLIENT_SETTINGS_UPDATE_TIMEOUT);
      assert.strictEqual(failureReason(yield* Fiber.join(update)), "timeout");
    }).pipe(Effect.provide(ClientSettingsRegistry.layer)),
  );
});
