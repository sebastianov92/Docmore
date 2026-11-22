import { useEffect, useState } from "react";
import { Alert, Anchor, Button, Checkbox, Group, List, Modal, PasswordInput, ScrollArea, Stack, Text, UnstyledButton } from "@mantine/core";
import { IconDatabase, IconFileText, IconInfoCircle } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import api from "@/lib/api-client";
import { getApiErrorMessage } from "@/lib/api-error";

type Root = { id: string; kind: "page" | "database"; title: string; icon: string | null };
type ImportNote = { code: string; name?: string; detail?: string; count?: number };

// What did not come over as it was, in the reader's language.
export function noteText(note: ImportNote, t: (key: string, values?: Record<string, unknown>) => string): string {
  const values = { name: note.name ?? "", detail: note.detail ?? "", count: note.count ?? 0 };
  switch (note.code) {
    case "people_as_names":
      return t("“{{name}}”: people come over as names, not as members of this workspace.", values);
    case "formula_as_values":
      return t("“{{name}}”: the formula comes over as its values, not as a formula.", values);
    case "rollup_as_values":
      return t("“{{name}}”: the rollup comes over as its values.", values);
    case "files_column":
      return t("“{{name}}”: the files of a column are not imported.", values);
    case "column_type":
      return t("“{{name}}”: columns of type {{detail}} are not imported.", values);
    case "view_type":
      return t("View “{{name}}” ({{detail}}) has no equivalent and is not imported.", values);
    case "board_as_table":
      return t("Board “{{name}}” groups by a column that cannot group here; it comes over as a table.", values);
    case "view_filter":
      return t("View “{{name}}”: its filter is not imported; it shows every row.", values);
    case "relation_outside":
      return t("“{{name}}”: it points to a database that is not part of this import, so it was left out.", values);
    case "row_values":
      return t("“{{name}}”: some of its values were not accepted and were left empty.", values);
    case "no_table":
      return t("“{{name}}”: the database has no table the connection can read.", values);
    case "max_rows":
      return t("“{{name}}”: only the first {{count}} rows were imported.", values);
    case "max_pages":
      return t("Only the first {{count}} pages were imported.", values);
    case "max_row_pages":
      return t("Only the first {{count}} rows with text of their own kept that text.", values);
    case "max_row_scans":
      return t("Only the first {{count}} rows were looked at for text of their own.", values);
    case "max_files":
      return t("Only the first {{count}} files were copied.", values);
    case "page_unreadable":
      return t("A page could not be read ({{detail}}).", values);
    case "database_unreadable":
      return t("A database could not be read ({{detail}}).", values);
    case "column_failed":
      return t("“{{name}}” could not be made ({{detail}}).", values);
    case "view_failed":
      return t("View “{{name}}” could not be made ({{detail}}).", values);
    case "page_text_failed":
      return t("The text of a page could not be written ({{detail}}).", values);
    default:
      return [note.code, note.name, note.detail].filter(Boolean).join(": ");
  }
}
type ImportView = {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  progress: { step: string; pages: number; bases: number; rows: number; files: number } | null;
  report: {
    pages: number;
    bases: number;
    rows: number;
    files: number;
    views: number;
    roots: Array<{ title: string; url: string }>;
    skipped: Array<{ type: string; count: number }>;
    notes: ImportNote[];
  } | null;
  error: string | null;
};

async function findRoots(token: string): Promise<{ items: Root[] }> {
  return (await api.post("/import/notion/roots", { token })).data;
}
async function startImport(data: { token: string; roots: Array<{ id: string; kind: string }>; spaceId: string }): Promise<ImportView> {
  return (await api.post("/import/notion/start", data)).data;
}
async function importStatus(importId: string): Promise<ImportView> {
  return (await api.post("/import/notion/status", { importId })).data;
}

// What Notion answered, in the reader's language when it is one of the usual cases.
function notionError(message: string, t: (key: string) => string): string {
  if (message.includes("did not accept the token")) return t("Notion did not accept the secret. Copy it again from your connection.");
  if (message.includes("not allowed to read")) return t("The connection is not allowed to read that. Give it “Read content” in Notion.");
  if (message.includes("shared with the connection")) return t("Notion did not find it: the page has to be shared with the connection.");
  if (message.includes("limiting requests")) return t("Notion is limiting requests right now. Try again in a few minutes.");
  if (message.includes("still running")) return t("An import of yours is still running.");
  return message;
}

type Props = { spaceId: string; opened: boolean; onClose: () => void };

// Bringing pages and databases over from Notion with the secret of a
// connection made there: a template duplicated into one's own Notion comes
// with its sub-pages, databases, rows and views.
export function NotionConnectModal({ spaceId, opened, onClose }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");
  const [roots, setRoots] = useState<Root[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [importId, setImportId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (opened) return;
    // nothing of the secret stays on the screen once it closes
    setToken("");
    setRoots(null);
    setPicked(new Set());
    setImportId(null);
    setError(null);
  }, [opened]);

  const find = useMutation({
    mutationFn: () => findRoots(token.trim()),
    onSuccess: (data) => {
      setError(null);
      setRoots(data.items);
      setPicked(new Set(data.items.map((r) => r.id)));
    },
    onError: (err) => setError(notionError(getApiErrorMessage(err, t("Could not reach Notion")), t)),
  });
  const start = useMutation({
    mutationFn: () => startImport({ token: token.trim(), roots: (roots ?? []).filter((r) => picked.has(r.id)).map((r) => ({ id: r.id, kind: r.kind })), spaceId }),
    onSuccess: (data) => {
      setError(null);
      setImportId(data.id);
    },
    onError: (err) => setError(notionError(getApiErrorMessage(err, t("Could not start the import")), t)),
  });
  const status = useQuery({
    queryKey: ["notion-import", importId],
    queryFn: () => importStatus(importId as string),
    enabled: Boolean(importId),
    refetchInterval: (query) => (query.state.data?.status === "done" || query.state.data?.status === "failed" ? false : 2000),
  });
  const run = status.data;
  const finished = run?.status === "done";
  useEffect(() => {
    if (!finished) return;
    queryClient.invalidateQueries({ queryKey: ["root-sidebar-pages", spaceId] });
    queryClient.invalidateQueries({ queryKey: ["recent-changes", spaceId] });
  }, [finished, queryClient, spaceId]);

  const toggle = (id: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const stepText = (step: string | undefined) =>
    step === "reading" ? t("Reading from Notion…") : step === "creating" ? t("Creating pages and bases…") : step === "writing" ? t("Writing the pages…") : t("Starting…");

  return (
    <Modal opened={opened} onClose={onClose} size="lg" title={t("Import from Notion")} data-testid="notion-connect">
      <Stack gap="md">
        {error && (
          <Alert color="red" variant="light" icon={<IconInfoCircle size={16} />} data-testid="notion-error">
            {error}
          </Alert>
        )}

        {!roots && !importId && (
          <>
            <Text size="sm">{t("Works with your own pages and with templates: duplicate the template into your Notion first.")}</Text>
            <List size="sm" spacing={6} type="ordered">
              <List.Item>
                {t("In Notion, create a connection and copy its secret:")}{" "}
                <Anchor href="https://www.notion.so/profile/integrations" target="_blank" rel="noreferrer" size="sm">
                  notion.so/profile/integrations
                </Anchor>
              </List.Item>
              <List.Item>{t("Open the page to import, then ••• > Connections, and add your connection. Its sub-pages come with it.")}</List.Item>
              <List.Item>{t("Paste the secret here. It is used for this import and not saved.")}</List.Item>
            </List>
            <PasswordInput
              label={t("Secret of the connection")}
              placeholder="ntn_…"
              value={token}
              onChange={(e) => setToken(e.currentTarget.value)}
              autoComplete="off"
              data-testid="notion-token"
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={onClose}>
                {t("Cancel")}
              </Button>
              <Button onClick={() => find.mutate()} loading={find.isPending} disabled={token.trim().length < 20} data-testid="notion-find">
                {t("Find my pages")}
              </Button>
            </Group>
          </>
        )}

        {roots && !importId && (
          <>
            {roots.length === 0 ? (
              <Text size="sm" c="dimmed" data-testid="notion-empty">
                {t("The connection reaches no page yet. In Notion, open the page, then ••• > Connections, and add it.")}
              </Text>
            ) : (
              <>
                <Group justify="space-between">
                  <Text size="sm">{t("Choose what to bring over. Sub-pages, databases, rows and views come with each one.")}</Text>
                </Group>
                <ScrollArea.Autosize mah={320}>
                  <Stack gap={4}>
                    {roots.map((root) => (
                      <UnstyledButton
                        key={root.id}
                        onClick={() => toggle(root.id)}
                        style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--mantine-color-default-border)" }}
                        aria-pressed={picked.has(root.id)}
                        data-testid="notion-root"
                      >
                        <Checkbox checked={picked.has(root.id)} readOnly tabIndex={-1} aria-hidden />
                        {root.kind === "database" ? <IconDatabase size={16} stroke={1.6} /> : <IconFileText size={16} stroke={1.6} />}
                        <Text size="sm" truncate style={{ flex: 1 }}>
                          {root.title}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {root.kind === "database" ? t("Database") : t("Page")}
                        </Text>
                      </UnstyledButton>
                    ))}
                  </Stack>
                </ScrollArea.Autosize>
              </>
            )}
            <Group justify="space-between">
              <Button variant="subtle" color="gray" onClick={() => setRoots(null)}>
                {t("Back")}
              </Button>
              <Button onClick={() => start.mutate()} loading={start.isPending} disabled={picked.size === 0} data-testid="notion-start">
                {t("Import {{count}}", { count: picked.size })}
              </Button>
            </Group>
          </>
        )}

        {importId && !finished && run?.status !== "failed" && (
          <Stack gap={6} data-testid="notion-progress">
            <Text size="sm" fw={600}>
              {stepText(run?.progress?.step)}
            </Text>
            <Text size="sm" c="dimmed">
              {t("{{pages}} pages · {{bases}} bases · {{rows}} rows · {{files}} files", {
                pages: run?.progress?.pages ?? 0,
                bases: run?.progress?.bases ?? 0,
                rows: run?.progress?.rows ?? 0,
                files: run?.progress?.files ?? 0,
              })}
            </Text>
            <Text size="xs" c="dimmed">
              {t("You can close this window: the import keeps going and the pages show up in the sidebar.")}
            </Text>
          </Stack>
        )}

        {run?.status === "failed" && (
          <Stack gap="sm">
            <Alert color="red" variant="light" data-testid="notion-failed">
              {run.error ? notionError(run.error, t) : t("The import failed")}
            </Alert>
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setImportId(null)}>
                {t("Back")}
              </Button>
            </Group>
          </Stack>
        )}

        {finished && run?.report && (
          <Stack gap="sm" data-testid="notion-done">
            <Text size="sm" fw={600}>
              {t("Import finished. Pages: {{pages}} · Bases: {{bases}} · Rows: {{rows}} · Views: {{views}} · Files: {{files}}", {
                pages: run.report.pages,
                bases: run.report.bases,
                rows: run.report.rows,
                views: run.report.views,
                files: run.report.files,
              })}
            </Text>
            <Stack gap={4}>
              {run.report.roots.map((root) => (
                <Group key={root.url} justify="space-between" wrap="nowrap" style={{ padding: "6px 10px", border: "1px solid var(--mantine-color-default-border)", borderRadius: 8 }}>
                  <Text size="sm" truncate>
                    {root.title}
                  </Text>
                  <Button component={Link} to={root.url} size="compact-xs" variant="light" onClick={onClose} data-testid="notion-open-root">
                    {t("Open page")}
                  </Button>
                </Group>
              ))}
            </Stack>
            {(run.report.notes.length > 0 || run.report.skipped.length > 0) && (
              <div data-testid="notion-notes">
                <Text size="sm" fw={600} mb={4}>
                  {t("What did not come over as it was")}
                </Text>
                <ScrollArea.Autosize mah={180}>
                  <List size="xs" spacing={3}>
                    {run.report.skipped.map((s) => (
                      <List.Item key={s.type}>{t("Blocks with no equivalent here: {{type}} × {{count}}", { count: s.count, type: s.type })}</List.Item>
                    ))}
                    {run.report.notes.map((note, index) => (
                      <List.Item key={index}>{noteText(note, t)}</List.Item>
                    ))}
                  </List>
                </ScrollArea.Autosize>
              </div>
            )}
            <Group justify="flex-end">
              <Button onClick={onClose}>{t("Done")}</Button>
            </Group>
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}
