import { useEffect, useMemo, useState } from "react";
import { Button, Modal, ScrollArea, Stack, Text, Typography, UnstyledButton } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import DOMPurify from "dompurify";
import { markdownToHtml } from "@docmost/editor-ext";
import { AGENT_RUNS_KEY, AGENTS_KEY, listAgentRuns } from "../services";
import { Agent, AgentRun } from "../types";
import classes from "./agents.module.css";

type Props = {
  agent: Agent | null;
  // the run to show first, when it came from a notification
  runId?: string | null;
  onClose: () => void;
};

const active = (run: AgentRun) => run.status === "queued" || run.status === "running";

export function statusText(status: AgentRun["status"], t: (key: string) => string): string {
  if (status === "done") return t("Done");
  if (status === "failed") return t("Failed");
  if (status === "running") return t("Running");
  return t("Waiting");
}

// What each run of an agent did: its result, where it went and what it left.
export function AgentRunsModal({ agent, runId, onClose }: Props) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const agentId = agent?.id ?? "";
  const runs = useQuery({
    queryKey: AGENT_RUNS_KEY(agentId),
    queryFn: () => listAgentRuns(agentId),
    enabled: Boolean(agentId),
    // while one is at work, look again every few seconds
    refetchInterval: (query) => ((query.state.data?.items ?? []).some(active) ? 3000 : false),
  });
  const items = runs.data?.items ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    setSelectedId(runId ?? null);
  }, [agentId, runId]);
  const selected = items.find((r) => r.id === selectedId) ?? items[0] ?? null;
  const working = items.some(active);
  // a run that just finished changes the agent's row too
  useEffect(() => {
    if (agentId && !working) queryClient.invalidateQueries({ queryKey: AGENTS_KEY });
  }, [working, agentId, queryClient]);

  const html = useMemo(
    () => (selected?.result ? DOMPurify.sanitize(markdownToHtml(selected.result) as string) : ""),
    [selected?.result],
  );
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(i18n.language, { dateStyle: "medium", timeStyle: "short" }) : "");

  return (
    <Modal opened={Boolean(agent)} onClose={onClose} size="xl" title={agent ? t("History of “{{name}}”", { name: agent.name }) : ""} data-testid="agent-runs">
      <div className={classes.runs}>
        <ScrollArea.Autosize mah={480} className={classes.runList}>
          <Stack gap={4}>
            {items.length === 0 && (
              <Text size="sm" c="dimmed">
                {runs.isLoading ? t("Loading...") : t("It has not run yet.")}
              </Text>
            )}
            {items.map((run) => (
              <UnstyledButton key={run.id} className={classes.run} data-active={selected?.id === run.id || undefined} onClick={() => setSelectedId(run.id)} data-testid="agent-run-row">
                <span className={classes.status}>
                  <span className={classes.dot} data-status={run.status} />
                  {statusText(run.status, t)}
                  {run.trigger === "manual" ? ` · ${t("by hand")}` : ""}
                </span>
                <Text size="xs" c="dimmed">
                  {when(run.startedAt ?? run.createdAt)}
                </Text>
              </UnstyledButton>
            ))}
          </Stack>
        </ScrollArea.Autosize>
        <div className={classes.runBody}>
          {!selected ? null : active(selected) ? (
            <Text size="sm" c="dimmed" data-testid="agent-run-working">
              {t("The agent is working. This takes a minute or two.")}
            </Text>
          ) : (
            <Stack gap="sm">
              {selected.error && (
                <Text size="sm" c="red" data-testid="agent-run-error">
                  {selected.error}
                </Text>
              )}
              {(selected.page || selected.suggestions.length > 0 || selected.created.length > 0) && (
                <div className={classes.links}>
                  {selected.page && selected.suggestions.length === 0 && (
                    <div className={classes.linkRow}>
                      <span>{t("The result is on “{{title}}”", { title: selected.page.title })}</span>
                      <Button component={Link} to={selected.page.url} size="compact-xs" variant="light" onClick={onClose}>
                        {t("Open page")}
                      </Button>
                    </div>
                  )}
                  {selected.suggestions.map((s) => (
                    <div key={s.suggestionId} className={classes.linkRow} data-testid="agent-run-suggestion">
                      <span>{t("Proposed a change to “{{title}}”. The page stays as it is until it is accepted.", { title: s.title })}</span>
                      <Button component={Link} to={s.reviewUrl} size="compact-xs" variant="light" onClick={onClose}>
                        {t("Review")}
                      </Button>
                    </div>
                  ))}
                  {selected.created
                    .filter((p) => p.id !== selected.page?.id)
                    .map((p) => (
                      <div key={p.url} className={classes.linkRow}>
                        <span>{t("Created the page “{{title}}”", { title: p.title })}</span>
                        <Button component={Link} to={p.url} size="compact-xs" variant="light" onClick={onClose}>
                          {t("Open page")}
                        </Button>
                      </div>
                    ))}
                </div>
              )}
              {html && (
                <ScrollArea.Autosize mah={360}>
                  <Typography className={classes.result} data-testid="agent-run-result">
                    <div dangerouslySetInnerHTML={{ __html: html }} />
                  </Typography>
                </ScrollArea.Autosize>
              )}
              {selected.steps.length > 0 && (
                <Text size="xs" c="dimmed">
                  {t("{{count}} steps", { count: selected.steps.length })}: {selected.steps.map((s) => s.name).join(" · ")}
                </Text>
              )}
            </Stack>
          )}
        </div>
      </div>
    </Modal>
  );
}
