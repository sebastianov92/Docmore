import { useEffect, useRef, useState } from "react";
import { IconLoader2 } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { IResearchReport, researchStatus } from "@/features/ai/research/services";
import classes from "./chat.module.css";

const STEPS = ["planning", "searching", "reading", "writing"] as const;
const POLL_MS = 2500;

// Under a research question: where the job is, polled until the report
// lands, then the thread reloads.
export function ResearchProgress({ reportId, onDone }: { reportId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const [report, setReport] = useState<IResearchReport | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await researchStatus(reportId);
        if (cancelled) return;
        setReport(r);
        if (r.status === "done" || r.status === "failed") {
          if (!doneRef.current) {
            doneRef.current = true;
            onDone();
          }
          return;
        }
      } catch {
        /* try again */
      }
      timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [reportId, onDone]);

  const labels: Record<string, string> = {
    planning: t("Planning"),
    searching: t("Searching the wiki"),
    reading: t("Reading pages"),
    writing: t("Writing the report"),
  };
  const current = report?.progress?.step ?? "queued";
  const idx = STEPS.indexOf(current as any);
  const failed = report?.status === "failed";

  return (
    <div className={classes.research} role="status" data-testid="research-progress">
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        {!failed && report?.status !== "done" && <IconLoader2 size={14} className={classes.spin} />}
        {failed ? report?.error || t("The research failed") : report?.status === "done" ? t("Report ready") : t("Researching…")}
      </span>
      {!failed && (
        <div className={classes.researchSteps}>
          {STEPS.map((s, i) => (
            <span key={s} className={classes.researchStep} data-active={i === idx || undefined} data-done={(idx > i || report?.status === "done") || undefined}>
              {labels[s]}
              {i === idx && report?.progress?.total ? ` ${report.progress.done}/${report.progress.total}` : ""}
            </span>
          ))}
          {report?.progress?.note && idx >= 0 && report.status !== "done" && <span>· {report.progress.note}</span>}
        </div>
      )}
    </div>
  );
}
