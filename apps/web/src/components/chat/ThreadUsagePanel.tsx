import { useAtomValue } from "@effect/atom-react";
import { collectLimitAccounts, collectLimitPools } from "@t3tools/shared/usageLimits";
import { formatDuration } from "@t3tools/shared/usageLimitsCopy";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import { ChartColumnIcon } from "lucide-react";
import { Fragment, useState } from "react";

import { environmentPresentations } from "../../state/presentation";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { barColor } from "../usage/UsageLimits";
import { readUsagePagePreferences } from "../usage/usagePagePreferences";
import { PROVIDER_PRESENTATION } from "../usage/usageProviders";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { usageLimitRows } from "./threadUsagePanel.logic";

function providerLabel(driver: string): string {
  const presentation = Object.values(PROVIDER_PRESENTATION).find(
    (entry) => entry.driverKind === driver,
  );
  return presentation?.label.replace(/ Code$/, "") ?? driver;
}

export function ThreadUsagePanel() {
  const gt = useGT();
  const messages = useMessages();
  const navigate = useNavigate();
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const [hiddenDrivers] = useState(
    () =>
      new Set<string>(
        (readUsagePagePreferences().hiddenProviders ?? []).map(
          (provider) => PROVIDER_PRESENTATION[provider].driverKind,
        ),
      ),
  );
  const accounts = collectLimitAccounts(presentations);
  // Measure from the newest report so countdowns advance with provider pushes, not a clock.
  const now = Math.max(0, ...accounts.map((account) => Date.parse(account.limits.checkedAt)));
  const pools = collectLimitPools(accounts, now).flatMap((pool) => {
    const rows = hiddenDrivers.has(pool.driver) ? [] : usageLimitRows(pool, messages);
    return rows.length > 0 ? [{ driver: pool.driver, rows }] : [];
  });
  if (pools.length === 0) return null;

  return (
    <ThreadDetailsSection
      headingId="thread-details-usage-heading"
      title={gt("Usage")}
      data-thread-details-usage
      actions={
        <Tooltip>
          <TooltipTrigger
            render={
              <ThreadDetailsControl
                size="icon-xs"
                variant="ghost"
                part="icon"
                aria-label={gt("Open usage")}
                onClick={() => void navigate({ to: "/usage" })}
              >
                <ChartColumnIcon className="size-3.5" />
              </ThreadDetailsControl>
            }
          />
          <TooltipPopup>
            <T>Open usage</T>
          </TooltipPopup>
        </Tooltip>
      }
    >
      <div className="grid grid-cols-[auto_auto_minmax(0,1fr)_2.25rem] items-center gap-x-2 gap-y-1 px-2.5 pb-0.5 text-xs">
        {pools.map(({ driver, rows }) => (
          <Fragment key={driver}>
            {rows.map((row, index) => {
              const resetsIn =
                row.nextResetAt !== null && row.nextResetAt > now
                  ? formatDuration(row.nextResetAt - now, messages)
                  : null;
              const summary = resetsIn
                ? gt("{provider} {window}: {percent}% left, resets in {duration}", {
                    provider: providerLabel(driver),
                    window: row.label,
                    percent: row.remainingPercent,
                    duration: resetsIn,
                  })
                : gt("{provider} {window}: {percent}% left", {
                    provider: providerLabel(driver),
                    window: row.label,
                    percent: row.remainingPercent,
                  });
              return (
                <Fragment key={row.id}>
                  <span className="truncate font-medium text-foreground/80">
                    {index === 0 ? providerLabel(driver) : ""}
                  </span>
                  <span className="text-muted-foreground">{row.label}</span>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <div
                          role="img"
                          aria-label={summary}
                          className="h-1.5 overflow-hidden rounded-full bg-muted"
                        />
                      }
                    >
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${row.remainingPercent}%`,
                          backgroundColor: barColor(driver),
                        }}
                      />
                    </TooltipTrigger>
                    <TooltipPopup side="left">{summary}</TooltipPopup>
                  </Tooltip>
                  <span className="text-right text-muted-foreground tabular-nums">
                    {row.remainingPercent}%
                  </span>
                </Fragment>
              );
            })}
          </Fragment>
        ))}
      </div>
    </ThreadDetailsSection>
  );
}
