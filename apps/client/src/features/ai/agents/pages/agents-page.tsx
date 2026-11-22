import { useEffect, useState } from "react";
import { ActionIcon, Button, Menu, Switch, Text, Tooltip } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconCalendarTime, IconDots, IconFileText, IconHistory, IconPlayerPlay, IconPlus, IconRobot, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { getApiErrorMessage } from "@/lib/api-error";
import { AgentEditorModal } from "../components/agent-editor-modal";
import { AgentRunsModal } from "../components/agent-runs-modal";
import { outputText, relativeTime, scheduleText } from "../schedule-text";
import { AGENT_RUNS_KEY, AGENTS_KEY, deleteAgent, listAgents, runAgent, updateAgent } from "../services";
import { Agent } from "../types";
import classes from "../components/agents.module.css";

// /ai/agents: the tasks the assistant carries out on its own, on a schedule.
export default function AgentsPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const agents = useQuery({ queryKey: AGENTS_KEY, queryFn: listAgents });
  const items = agents.data?.items ?? [];
  const [editing, setEditing] = useState<{ agent: Agent | null } | null>(null);
  const [history, setHistory] = useState<{ agent: Agent; runId?: string | null } | null>(null);

  // a notification brings the reader straight to a run
  const linkedAgent = searchParams.get("agent");
  const linkedRun = searchParams.get("run");
  useEffect(() => {
    if (!linkedAgent || !items.length) return;
    const agent = items.find((a) => a.id === linkedAgent);
    if (agent) setHistory({ agent, runId: linkedRun });
    const rest = new URLSearchParams(searchParams);
    rest.delete("agent");
    rest.delete("run");
    setSearchParams(rest, { replace: true });
  }, [linkedAgent, items.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => queryClient.invalidateQueries({ queryKey: AGENTS_KEY });
  const fail = (err: unknown) => notifications.show({ color: "red", message: getApiErrorMessage(err, t("Something went wrong")) });
  const toggle = useMutation({ mutationFn: (a: Agent) => updateAgent(a.id, { enabled: !a.enabled }), onSuccess: refresh, onError: fail });
  const remove = useMutation({ mutationFn: (a: Agent) => deleteAgent(a.id), onSuccess: refresh, onError: fail });
  const run = useMutation({
    mutationFn: (a: Agent) => runAgent(a.id),
    onSuccess: (started, agent) => {
      queryClient.invalidateQueries({ queryKey: AGENT_RUNS_KEY(agent.id) });
      setHistory({ agent, runId: started.id });
    },
    onError: fail,
  });

  const confirmDelete = (agent: Agent) =>
    modals.openConfirmModal({
      title: t("Delete agent"),
      centered: true,
      children: <Text size="sm">{t("Delete “{{name}}”? Its history goes with it; the pages it made stay.", { name: agent.name })}</Text>,
      labels: { confirm: t("Delete"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => remove.mutate(agent),
    });

  const open = (agent: Agent) => (agent.mine ? setEditing({ agent }) : setHistory({ agent }));

  return (
    <div className={classes.page}>
      <DocumentTitle title={t("Scheduled agents")} />
      <div className={classes.head}>
        <div>
          <h1 className={classes.title}>{t("Scheduled agents")}</h1>
          <Text size="sm" c="dimmed">
            {t("Tasks the assistant does on its own, on a schedule: a weekly summary, pages to review, a daily digest. Each one works with what you can see.")}
          </Text>
        </div>
        {items.length > 0 && (
          <Button leftSection={<IconPlus size={16} />} onClick={() => setEditing({ agent: null })} data-testid="agent-new" className={classes.headAction}>
            {t("New agent")}
          </Button>
        )}
      </div>

      {!agents.isLoading && items.length === 0 && (
        <EmptyState
          icon={IconRobot}
          title={t("No agents yet")}
          description={t("Make the first one from a ready-made task or write your own.")}
          action={
            <Button mt="xs" leftSection={<IconPlus size={16} />} onClick={() => setEditing({ agent: null })} data-testid="agent-new">
              {t("New agent")}
            </Button>
          }
        />
      )}

      <div className={classes.list}>
        {items.map((agent) => (
          <div
            key={agent.id}
            className={classes.row}
            data-off={!agent.enabled || undefined}
            role="button"
            tabIndex={0}
            onClick={() => open(agent)}
            onKeyDown={(e) => {
              if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                open(agent);
              }
            }}
            data-testid="agent-row"
          >
            <span className={classes.rowIcon}>
              <IconRobot size={18} stroke={1.6} />
            </span>
            <div className={classes.rowMain}>
              <div className={classes.rowName}>{agent.name}</div>
              <div className={classes.rowMeta}>
                <span>
                  <IconCalendarTime size={13} stroke={1.6} />
                  {scheduleText(agent.schedule, t, i18n.language)}
                </span>
                <span>
                  <IconFileText size={13} stroke={1.6} />
                  {outputText(agent, t)}
                </span>
                {agent.space && <span>{agent.space.name}</span>}
                {!agent.mine && agent.creator && <span>{t("by {{name}}", { name: agent.creator.name })}</span>}
              </div>
              <div className={classes.rowMeta}>
                {agent.enabled && agent.nextRunAt ? (
                  <span data-testid="agent-next">{t("Next run {{when}}", { when: relativeTime(agent.nextRunAt, i18n.language) })}</span>
                ) : (
                  <span data-testid="agent-paused">{t("Paused")}</span>
                )}
                {agent.lastRunAt && (
                  <span className={classes.status} title={agent.lastError ?? undefined}>
                    <span className={classes.dot} data-status={agent.lastStatus ?? undefined} />
                    {agent.lastStatus === "failed" ? t("Last run failed {{when}}", { when: relativeTime(agent.lastRunAt, i18n.language) }) : t("Last run {{when}}", { when: relativeTime(agent.lastRunAt, i18n.language) })}
                  </span>
                )}
              </div>
            </div>
            <div className={classes.rowSide} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
              <Tooltip label={agent.enabled ? t("Pause") : agent.mine ? t("Turn on") : t("Only its owner turns it on")} openDelay={300} withArrow>
                <Switch
                  checked={agent.enabled}
                  onChange={() => toggle.mutate(agent)}
                  disabled={toggle.isPending || (!agent.mine && !agent.enabled)}
                  aria-label={t("Agent is on")}
                  data-testid="agent-enabled"
                />
              </Tooltip>
              <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                  <ActionIcon variant="subtle" color="gray" aria-label={t("More")} data-testid="agent-menu">
                    <IconDots size={18} />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  {agent.mine && (
                    <Menu.Item leftSection={<IconPlayerPlay size={15} />} onClick={() => run.mutate(agent)} data-testid="agent-run-now">
                      {t("Run now")}
                    </Menu.Item>
                  )}
                  <Menu.Item leftSection={<IconHistory size={15} />} onClick={() => setHistory({ agent })} data-testid="agent-history">
                    {t("History")}
                  </Menu.Item>
                  <Menu.Item color="red" leftSection={<IconTrash size={15} />} onClick={() => confirmDelete(agent)} data-testid="agent-delete">
                    {t("Delete")}
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            </div>
          </div>
        ))}
      </div>

      <AgentEditorModal opened={Boolean(editing)} agent={editing?.agent ?? null} onClose={() => setEditing(null)} />
      <AgentRunsModal agent={history?.agent ?? null} runId={history?.runId} onClose={() => setHistory(null)} />
    </div>
  );
}
