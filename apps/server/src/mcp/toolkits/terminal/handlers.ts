import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as TerminalMcpService from "../../TerminalMcpService.ts";
import { TerminalToolkit } from "./tools.ts";

const asCaller = Effect.fn("TerminalMcpHandlers.asCaller")(function* <A, E>(
  call: (
    service: TerminalMcpService.TerminalMcpService["Service"],
    scope: McpInvocationContext.McpThreadInvocationScope,
  ) => Effect.Effect<A, E>,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const thread = yield* McpInvocationContext.requireThreadScope(scope, "This tool");
  const service = yield* TerminalMcpService.TerminalMcpService;
  return yield* call(service, thread);
});

const handlers = {
  t3_terminal_run: McpToolAccess.actsAsCaller((input) =>
    asCaller((service, scope) => service.run(scope, input)),
  ),
  t3_terminal_read: McpToolAccess.readsAsCaller((input) =>
    asCaller((service, scope) => service.read(scope, input)),
  ),
  t3_terminal_stop: McpToolAccess.actsAsCaller((input) =>
    asCaller((service, scope) => service.stop(scope, input)),
  ),
} satisfies McpToolAccess.Handlers<typeof TerminalToolkit.tools>;

export const layer = McpToolAccess.toLayer(TerminalToolkit, handlers);
