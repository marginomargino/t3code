import type { CommandOutputView } from "@t3tools/client-runtime/state/command-output";
import type { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { TERMINAL_PALETTES, terminalOutputSpans } from "@t3tools/shared/terminalOutput";
import { Maximize2Icon, Minimize2Icon } from "lucide-react";
import { useLayoutEffect, useRef } from "react";

import { useTheme } from "../../hooks/useTheme";
import { useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useInitialOutputReady, type TurnItemSource } from "./timelineRowContext";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const FOLLOW_SLACK_PX = 8;

export function useCommandOutputStreaming(environmentId: EnvironmentId): boolean {
  return (
    useServerConfigs().get(environmentId)?.environment.capabilities.commandOutputStreaming === true
  );
}

/**
 * Output of one expanded command row: streams while the command runs, then
 * shows its final output. Mount it only when `useCommandOutputStreaming` holds
 * or a `source` serves the output.
 * It subscribes only while mounted, so collapsed rows and other threads receive nothing.
 */
export function CommandOutputPanel(props: {
  readonly onInitialOutputReady?: (() => void) | undefined;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  /** A person's `! cmd`: a spinner while loading, and the same 20-line cap as its bubble. */
  readonly variant?: "default" | "shell";
  /** A `! cmd` the person expanded: most of the viewport instead of 20 lines. */
  readonly tall?: boolean;
  readonly source?: TurnItemSource["commandOutput"] | undefined;
}) {
  const shell = props.variant === "shell";
  const input = { threadId: props.threadId, itemId: props.itemId };
  const { data, error } = useEnvironmentQuery<CommandOutputView, unknown>(
    props.source
      ? props.source(input)
      : orchestrationEnvironment.v2.commandOutput({ environmentId: props.environmentId, input }),
  );
  useInitialOutputReady(data === null && !error, props.onInitialOutputReady);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const text = data?.output.text ?? "";
  const { resolvedTheme } = useTheme();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pins the output scroller's scrollTop to the bottom after each commit while the user follows
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && followRef.current) element.scrollTop = element.scrollHeight;
  });

  if (text.length === 0) {
    if (error) return <div className="text-destructive">Couldn&apos;t load output: {error}</div>;
    if (data === null) {
      return shell ? (
        <Spinner size="sm" tone="muted" aria-label="Loading output" />
      ) : (
        <div className="text-muted-foreground italic">Loading output…</div>
      );
    }
    return data.running ? null : <div className="text-muted-foreground italic">No output.</div>;
  }
  return (
    <div
      ref={scrollRef}
      onScroll={(event) => {
        const element = event.currentTarget;
        followRef.current =
          element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_SLACK_PX;
      }}
      className={cn(
        "overflow-auto text-muted-foreground",
        shell ? shellOutputHeight(props.tall) : "max-h-80",
      )}
    >
      {data?.output.truncated ? <div className="italic">Earlier output not shown</div> : null}
      <TerminalOutputSpans text={text} theme={resolvedTheme} />
    </div>
  );
}

function TerminalOutputSpans(props: {
  readonly text: string;
  readonly theme: keyof typeof TERMINAL_PALETTES;
}) {
  const spans = terminalOutputSpans(props.text, TERMINAL_PALETTES[props.theme]);
  return spans.map((span, index) =>
    span.style === null ? (
      span.text
    ) : (
      // Spans never reorder and are rebuilt on each update.
      // oxlint-disable-next-line react/no-array-index-key
      <span key={index} style={span.style}>
        {span.text}
      </span>
    ),
  );
}

/** A `! cmd`'s output the client already holds, colored like the live panel. */
export function CommandOutputText(props: { readonly text: string; readonly tall?: boolean }) {
  const { resolvedTheme } = useTheme();
  return (
    <div className={cn("overflow-auto text-muted-foreground", shellOutputHeight(props.tall))}>
      <TerminalOutputSpans text={props.text} theme={resolvedTheme} />
    </div>
  );
}

function shellOutputHeight(tall: boolean | undefined): string {
  // Leaves room for the header, the composer and the command line above the output.
  return tall ? "max-h-[max(20lh,calc(100dvh-22rem))]" : "max-h-[20lh]";
}

/** Switches a `! cmd`'s output between its 20-line box and most of the viewport. */
export function ShellOutputSizeToggle(props: {
  readonly tall: boolean;
  readonly onToggle: () => void;
}) {
  const label = props.tall ? "Shrink output" : "Expand output";
  const Icon = props.tall ? Minimize2Icon : Maximize2Icon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={label}
            aria-pressed={props.tall}
            onClick={props.onToggle}
          />
        }
      >
        <Icon aria-hidden className="size-3" />
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
