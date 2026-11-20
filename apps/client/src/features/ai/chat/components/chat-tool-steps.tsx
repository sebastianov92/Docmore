import { useEffect, useState } from "react";
import { Button, Group } from "@mantine/core";
import { IconChevronDown, IconChevronRight, IconLoader2, IconPlugConnected } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { AiChatToolCall, pendingApprovalOf, splitMcpToolName } from "../types";
import classes from "./chat.module.css";

const LABELS: Record<string, string> = {
  list_spaces: "Listed spaces",
  search_pages: "Searched pages",
  get_page: "Read a page",
  create_page: "Created a page",
  update_page: "Updated a page",
  list_bases: "Listed bases",
  get_base: "Read a base",
  list_base_rows: "Read base rows",
  create_base_row: "Added a row",
  update_base_row: "Changed a row",
};

function labelOf(call: AiChatToolCall, t: (k: string) => string): string {
  const mcp = splitMcpToolName(call.name);
  if (mcp) return `${mcp.server} · ${mcp.tool}`;
  return t(LABELS[call.name] ?? call.name);
}

function detail(call: AiChatToolCall): string {
  const args = call.args ?? {};
  if (typeof args.query === "string") return `“${args.query}”`;
  if (typeof args.title === "string") return args.title;
  if (typeof args.pageId === "string") return args.pageId;
  return "";
}

export type ApprovalDecision = "approved" | "denied";

interface Props {
  toolCalls: AiChatToolCall[];
  isStreaming?: boolean;
  // approvals already answered, by id
  decided?: Record<string, ApprovalDecision>;
  onDecide?: (approvalId: string, decision: ApprovalDecision, tool: string, server: string) => void;
}

// What the assistant did before answering: one line while it works, a
// collapsible list of steps afterwards, each expandable to its data. An MCP
// call waiting for approval shows its Allow / Deny buttons here.
export function ChatToolSteps({ toolCalls, isStreaming, decided = {}, onDecide }: Props) {
  const { t } = useTranslation();
  const pendingCalls = toolCalls.filter((c) => {
    const p = pendingApprovalOf(c);
    return p && !decided[p.approvalId];
  });
  const [open, setOpen] = useState(pendingCalls.length > 0);
  const [openStep, setOpenStep] = useState<string | null>(null);
  useEffect(() => {
    if (pendingCalls.length > 0) setOpen(true);
  }, [pendingCalls.length]);
  if (!toolCalls.length) return null;

  const active = isStreaming ? [...toolCalls].reverse().find((c) => c.result === undefined) : undefined;
  const header = active
    ? `${labelOf(active, t)}…`
    : pendingCalls.length
      ? t("Waiting for your approval")
      : toolCalls.length === 1
        ? t("1 step")
        : t("{{count}} steps", { count: toolCalls.length });

  return (
    <div className={classes.steps}>
      <button type="button" className={classes.stepsHeader} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {active ? <IconLoader2 size={13} className={classes.spin} /> : open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
        <span>{header}</span>
      </button>
      {open && (
        <div className={classes.stepList}>
          {toolCalls.map((call) => {
            const expanded = openStep === call.id;
            const failed = call.result && typeof call.result === "object" && "error" in (call.result as object);
            const pending = pendingApprovalOf(call);
            const decision = pending ? decided[pending.approvalId] : undefined;
            const mcp = splitMcpToolName(call.name);
            return (
              <div key={call.id} className={classes.step}>
                <button type="button" className={classes.stepRow} onClick={() => setOpenStep(expanded ? null : call.id)} aria-expanded={expanded}>
                  {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
                  {mcp && <IconPlugConnected size={12} />}
                  <span className={classes.stepLabel} data-failed={failed || undefined}>
                    {labelOf(call, t)}
                  </span>
                  <span className={classes.stepDetail}>{detail(call)}</span>
                </button>
                {pending && (
                  <div className={classes.approval} data-testid="tool-approval">
                    {decision ? (
                      <span className={classes.approvalNote}>{decision === "approved" ? t("You allowed it") : t("You declined it")}</span>
                    ) : (
                      <>
                        <span>{t("{{tool}} on {{server}} wants to run. Allow it?", { tool: pending.tool, server: pending.server })}</span>
                        {onDecide && !isStreaming && (
                          <Group gap={6} wrap="nowrap">
                            <Button size="compact-xs" onClick={() => onDecide(pending.approvalId, "approved", pending.tool, pending.server)} data-testid="approve-tool">
                              {t("Allow")}
                            </Button>
                            <Button size="compact-xs" variant="default" onClick={() => onDecide(pending.approvalId, "denied", pending.tool, pending.server)} data-testid="deny-tool">
                              {t("Deny")}
                            </Button>
                          </Group>
                        )}
                      </>
                    )}
                  </div>
                )}
                {expanded && <pre className={classes.stepData}>{JSON.stringify({ args: call.args, result: call.result ?? null }, null, 2)}</pre>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
