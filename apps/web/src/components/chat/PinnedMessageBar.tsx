import type { ScopedThreadRef, ServerProviderSkill } from "@t3tools/contracts";
import { shouldPreserveAssistantLineBreaks } from "@t3tools/shared/assistantInsights";
import { useGT } from "gt-react";
import { ArrowDownToLineIcon, ChevronDownIcon, ChevronUpIcon, PinIcon, XIcon } from "lucide-react";
import { useState } from "react";

import type { PinnedMessageSnapshot } from "../../pinnedMessageStore";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MESSAGE_HEADING_LEVEL } from "./TimelineRowParts";
import { USER_MESSAGE_MARKDOWN } from "./TimelineUserMessageRow";

export interface PinnedMessageBarProps {
  snapshot: PinnedMessageSnapshot;
  threadRef: ScopedThreadRef;
  markdownCwd: string | undefined;
  skills: ReadonlyArray<ServerProviderSkill>;
  onJump: (() => void) | undefined;
  onUnpin: () => void;
}

export function PinnedMessageBar({
  snapshot,
  threadRef,
  markdownCwd,
  skills,
  onJump,
  onUnpin,
}: PinnedMessageBarProps) {
  const gt = useGT();
  const [expanded, setExpanded] = useState(false);
  const firstLine = snapshot.text
    .split(/\r\n?|\n/)
    .map((line) => line.trim())
    .find((line) => line !== "" && !line.startsWith("```"))
    ?.replace(/[`*~]|^#+\s*|^>\s*/g, "");
  const label = gt("Pinned message");
  const jumpLabel = gt("Jump to message");
  const unpinLabel = gt("Unpin message");
  const isAssistant = snapshot.role === "assistant";

  return (
    <section
      aria-label={label}
      className="pointer-events-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-sm"
    >
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
        >
          <PinIcon />
          <span className="min-w-0 flex-1 truncate text-start" dir="auto">
            {firstLine || label}
          </span>
          {expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
        </button>
        {onJump ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="icon-xs"
                  aria-label={jumpLabel}
                  onClick={() => {
                    setExpanded(false);
                    onJump();
                  }}
                />
              }
            >
              <ArrowDownToLineIcon />
            </TooltipTrigger>
            <TooltipPopup>{jumpLabel}</TooltipPopup>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost-muted"
                size="icon-xs"
                aria-label={unpinLabel}
                onClick={onUnpin}
              />
            }
          >
            <XIcon />
          </TooltipTrigger>
          <TooltipPopup>{unpinLabel}</TooltipPopup>
        </Tooltip>
      </div>
      {expanded ? (
        <div className="mt-1 max-h-[50vh] overflow-y-auto overscroll-contain border-t border-border px-3 py-2 select-text">
          <ChatMarkdown
            text={snapshot.text}
            cwd={markdownCwd}
            threadRef={threadRef}
            skills={skills}
            {...(isAssistant
              ? {}
              : { className: "user-message-markdown", extensions: USER_MESSAGE_MARKDOWN })}
            renderInsights={isAssistant}
            lineBreaks={!isAssistant || shouldPreserveAssistantLineBreaks(snapshot.text)}
            parseRawHtml={isAssistant}
            headingLevelOffset={MESSAGE_HEADING_LEVEL}
          />
        </div>
      ) : null}
    </section>
  );
}
