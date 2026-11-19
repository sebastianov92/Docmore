import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Group,
  Menu,
  Modal,
  Progress,
  Stack,
  Table,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { IconChevronDown, IconUpload } from "@tabler/icons-react";
import { useAtom } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { IBase, IBaseProperty } from "@/features/base/types/base.types";
import { importBaseCsv } from "@/features/base/services/base-service";
import { getFileTaskById } from "@/features/file-task/services/file-task-service";
import { importProgressAtomFamily } from "@/features/base/atoms/import-progress-atom";
import {
  buildImport,
  initialMappings,
  isImportable,
  parseCsvFile,
} from "./csv-import-parse";
import {
  ColumnMapping,
  ColumnTarget,
  CSV_IMPORT_LIMITS,
  IMPORTABLE_TYPES,
  ImportableType,
  ParsedCsv,
} from "./csv-import.types";
import classes from "@/features/base/styles/csv-import.module.css";

type Props = {
  base: IBase;
  opened: boolean;
  onClose: () => void;
};

const TYPE_LABELS: Record<ImportableType, string> = {
  text: "Text",
  longText: "Long text",
  number: "Number",
  select: "Select",
  status: "Status",
  multiSelect: "Multi-select",
  date: "Date",
  person: "Person",
  checkbox: "Checkbox",
  url: "URL",
  email: "Email",
  phone: "Phone",
};

// Pick a file, map its columns to properties (existing, new or skipped),
// then follow the server-side import until it finishes.
export function CsvImportModal({ base, opened, onClose }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [mappings, setMappings] = useState<ColumnMapping[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [progress, setProgress] = useAtom(importProgressAtomFamily(base.id));

  const reset = useCallback(() => {
    setFile(null);
    setParsed(null);
    setMappings([]);
    setError(null);
    setStarting(false);
  }, []);

  const close = useCallback(() => {
    if (progress && progress.status !== "running") {
      setProgress(null);
      queryClient.invalidateQueries({ queryKey: ["base-rows", base.id] });
      queryClient.invalidateQueries({ queryKey: ["bases", base.id] });
    }
    reset();
    onClose();
  }, [progress, setProgress, queryClient, base.id, reset, onClose]);

  const pickFile = useCallback(
    async (picked: File | null) => {
      setError(null);
      if (!picked) return;
      if (picked.size > CSV_IMPORT_LIMITS.maxFileBytes) {
        setError(t("The file is larger than 50 MB"));
        return;
      }
      try {
        const result = await parseCsvFile(picked);
        setFile(picked);
        setParsed(result);
        setMappings(initialMappings(result, base.properties));
      } catch (err: any) {
        setError(err?.message ?? t("Could not read the file"));
      }
    },
    [base.properties, t],
  );

  const setTarget = (index: number, target: ColumnTarget) =>
    setMappings((prev) => prev.map((m) => (m.index === index ? { ...m, target } : m)));

  const usedPropertyIds = useMemo(
    () => new Set(mappings.map((m) => (m.target.kind === "existing" ? m.target.propertyId : null))),
    [mappings],
  );
  const importableProperties = useMemo(
    () => base.properties.filter((p) => isImportable(p.type)),
    [base.properties],
  );
  const newNameClash = useMemo(() => {
    const taken = new Set(base.properties.map((p) => p.name.trim().toLowerCase()));
    const seen = new Set<string>();
    for (const m of mappings) {
      if (m.target.kind !== "new") continue;
      const key = m.target.name.trim().toLowerCase();
      if (taken.has(key) || seen.has(key)) return m.target.name;
      seen.add(key);
    }
    return null;
  }, [mappings, base.properties]);
  const activeCount = mappings.filter((m) => m.target.kind !== "skip").length;

  const start = async () => {
    if (!parsed || !file) return;
    setStarting(true);
    setError(null);
    try {
      const { spec, jsonl, rowCount } = buildImport(parsed, mappings, base.properties, file.name);
      if (rowCount === 0) {
        setError(t("Nothing to import: every row is empty"));
        return;
      }
      const task = await importBaseCsv(base.id, spec, jsonl);
      setProgress({
        fileTaskId: task.id,
        status: "running",
        processedRows: 0,
        totalRows: rowCount,
      });
    } catch (err: any) {
      const message = err?.response?.data?.message;
      setError(Array.isArray(message) ? message.join(", ") : message ?? t("Import failed"));
    } finally {
      setStarting(false);
    }
  };

  // The socket reports progress; polling covers a missed event.
  useEffect(() => {
    if (!progress || progress.status !== "running") return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const task = await getFileTaskById(progress.fileTaskId);
        if (cancelled) return;
        const meta = (task.metadata ?? {}) as Record<string, number>;
        if (task.status === "success" || task.status === "failed") {
          setProgress({
            fileTaskId: task.id,
            status: task.status,
            processedRows: meta.totalRows ?? progress.totalRows,
            totalRows: meta.totalRows ?? progress.totalRows,
            importedRows: meta.importedRows,
            skippedValues: meta.skippedValues,
            error: task.errorMessage,
          });
        } else if (typeof meta.processedRows === "number") {
          setProgress((prev) =>
            prev && prev.status === "running" ? { ...prev, processedRows: meta.processedRows } : prev,
          );
        }
      } catch {
        // keep polling
      }
    }, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [progress?.fileTaskId, progress?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const targetLabel = (m: ColumnMapping): string => {
    if (m.target.kind === "skip") return t("Skip");
    if (m.target.kind === "existing") {
      const wanted = m.target.propertyId;
      const property = base.properties.find((p) => p.id === wanted);
      return property ? property.name : t("Skip");
    }
    return `${t("New")}: ${t(TYPE_LABELS[m.target.type])}`;
  };

  return (
    <Modal
      opened={opened}
      onClose={close}
      title={t("Import CSV")}
      size="xl"
      centered
      closeOnClickOutside={!progress || progress.status !== "running"}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        style={{ display: "none" }}
        onChange={(e) => pickFile(e.currentTarget.files?.[0] ?? null)}
      />

      {progress ? (
        <Stack gap="md">
          {progress.status === "running" && (
            <>
              <Text size="sm">
                {t("Importing {{done}} of {{total}} rows", {
                  done: progress.processedRows,
                  total: progress.totalRows,
                })}
              </Text>
              <Progress
                value={progress.totalRows ? (progress.processedRows / progress.totalRows) * 100 : 0}
                animated
              />
            </>
          )}
          {progress.status === "success" && (
            <Alert color="green" variant="light">
              {t("Imported {{count}} rows", { count: progress.importedRows ?? progress.totalRows })}
              {progress.skippedValues ? ` · ${t("{{count}} values could not be read", { count: progress.skippedValues })}` : ""}
            </Alert>
          )}
          {progress.status === "failed" && (
            <Alert color="red" variant="light">
              {progress.error || t("Import failed")}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button onClick={close} disabled={progress.status === "running"}>
              {t("Close")}
            </Button>
          </Group>
        </Stack>
      ) : !parsed ? (
        <Stack gap="md">
          <UnstyledButton className={classes.dropzone} onClick={() => inputRef.current?.click()}>
            <IconUpload size={28} stroke={1.5} />
            <Text size="sm" fw={500}>
              {t("Choose a CSV file")}
            </Text>
            <Text size="xs" c="dimmed">
              {t("The first row holds the column names. Up to 100,000 rows and 200 columns.")}
            </Text>
          </UnstyledButton>
          {error && (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}
        </Stack>
      ) : (
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            {t("{{rows}} rows in {{name}}. Choose where each column goes.", {
              rows: parsed.rows.length,
              name: file?.name ?? "",
            })}
            {parsed.truncatedRows > 0 && ` ${t("{{count}} rows beyond the limit were dropped.", { count: parsed.truncatedRows })}`}
          </Text>
          <div className={classes.tableWrap}>
            <Table verticalSpacing="xs" withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t("CSV column")}</Table.Th>
                  <Table.Th>{t("Sample values")}</Table.Th>
                  <Table.Th>{t("Import into")}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {mappings.map((m) => (
                  <Table.Tr key={m.index}>
                    <Table.Td>
                      <Text size="sm" fw={500}>
                        {m.header}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed" lineClamp={2}>
                        {m.samples.filter(Boolean).join(" · ") || "—"}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <TargetMenu
                        mapping={m}
                        label={targetLabel(m)}
                        properties={importableProperties}
                        usedPropertyIds={usedPropertyIds}
                        onChange={(target) => setTarget(m.index, target)}
                      />
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
          {newNameClash && (
            <Alert color="yellow" variant="light">
              {t('A property named "{{name}}" already exists. Pick it or skip the column.', { name: newNameClash })}
            </Alert>
          )}
          {error && (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}
          <Group justify="space-between">
            <Button variant="subtle" onClick={reset}>
              {t("Choose another file")}
            </Button>
            <Group>
              <Button variant="default" onClick={close}>
                {t("Cancel")}
              </Button>
              <Button
                onClick={start}
                loading={starting}
                disabled={activeCount === 0 || Boolean(newNameClash)}
              >
                {t("Import {{count}} rows", {
                  count: parsed.rows.length,
                  formatted: parsed.rows.length.toLocaleString(),
                })}
              </Button>
            </Group>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

function TargetMenu({
  mapping,
  label,
  properties,
  usedPropertyIds,
  onChange,
}: {
  mapping: ColumnMapping;
  label: string;
  properties: IBaseProperty[];
  usedPropertyIds: Set<string | null>;
  onChange: (target: ColumnTarget) => void;
}) {
  const { t } = useTranslation();
  const current = mapping.target;
  return (
    <Menu position="bottom-start" withinPortal shadow="md" width={240}>
      <Menu.Target>
        <UnstyledButton className={classes.targetButton}>
          <Text size="sm">{label}</Text>
          <IconChevronDown size={14} />
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown className={classes.targetDropdown}>
        <Menu.Item onClick={() => onChange({ kind: "skip" })}>{t("Skip this column")}</Menu.Item>
        {properties.length > 0 && <Menu.Label>{t("Existing property")}</Menu.Label>}
        {properties.map((p) => {
          const taken =
            usedPropertyIds.has(p.id) && !(current.kind === "existing" && current.propertyId === p.id);
          return (
            <Menu.Item
              key={p.id}
              disabled={taken}
              onClick={() => onChange({ kind: "existing", propertyId: p.id })}
            >
              {p.name}
              <Text span size="xs" c="dimmed">
                {" "}
                · {t(TYPE_LABELS[p.type as ImportableType] ?? p.type)}
              </Text>
            </Menu.Item>
          );
        })}
        <Menu.Label>{t("New property")}</Menu.Label>
        {IMPORTABLE_TYPES.map((type) => (
          <Menu.Item
            key={type}
            onClick={() => onChange({ kind: "new", name: mapping.header, type })}
          >
            {t(TYPE_LABELS[type])}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
