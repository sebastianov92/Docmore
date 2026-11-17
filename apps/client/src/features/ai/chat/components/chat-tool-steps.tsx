import { useState } from "react";
import { IconChevronDown, IconChevronRight, IconLoader2 } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { AiChatToolCall } from "../types";
import classes from "./chat.module.css";

const LABELS: Record<string, string> = {
  list_spaces: "Listed spaces",
  search_pages: "Searched pages",
  get_page: "Read a page",
  create_page: "Created a page",
  update_page: "Updated a page",
};

function detail(call: AiChatToolCall): string {
  const args = call.args ?? {};
  if (typeof args.query === "string") return `“${args.query}”`;
  if (typeof args.title === "string") return args.title;
  if (typeof args.pageId === "string") return args.pageId;
  return "";
}

// What the assistant did before answering: one line while it works, a
// collapsible list of steps afterwards, each expandable to its data.
export function ChatToolSteps({ toolCalls, isStreaming }: { toolCalls: AiChatToolCall[]; isStreaming?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [openStep, setOpenStep] = useState<string | null>(null);
  if (!toolCalls.length) return null;

  const active = isStreaming ? [...toolCalls].reverse().find((c) => c.result === undefined) : undefined;
  const header = active
    ? `${t(LABELS[active.name] ?? active.name)}…`
    : toolCalls.length === 1
      ? t("1 step")
      : t("{{count}} steps", { count: toolCalls.length });

  return (
    <div className={classes.steps}>
      <button type="button" className={classes.stepsHeader} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {active ? (
          <IconLoader2 size={13} className={classes.spin} />
        ) : open ? (
          <IconChevronDown size={13} />
        ) : (
          <IconChevronRight size={13} />
        )}
        <span>{header}</span>
      </button>
      {open && (
        <div className={classes.stepList}>
          {toolCalls.map((call) => {
            const expanded = openStep === call.id;
            const failed = call.result && typeof call.result === "object" && "error" in (call.result as object);
            return (
              <div key={call.id} className={classes.step}>
                <button
                  type="button"
                  className={classes.stepRow}
                  onClick={() => setOpenStep(expanded ? null : call.id)}
                  aria-expanded={expanded}
                >
                  {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
                  <span className={classes.stepLabel} data-failed={failed || undefined}>
                    {t(LABELS[call.name] ?? call.name)}
                  </span>
                  <span className={classes.stepDetail}>{detail(call)}</span>
                </button>
                {expanded && (
                  <pre className={classes.stepData}>
                    {JSON.stringify({ args: call.args, result: call.result ?? null }, null, 2)}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
