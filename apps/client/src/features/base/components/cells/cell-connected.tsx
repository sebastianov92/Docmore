import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Tooltip } from "@mantine/core";
import { IconLink, IconLoader2 } from "@tabler/icons-react";
import { IBaseProperty, IConnectedValue } from "@/features/base/types/base.types";
import { getIntegrationIcon } from "@/features/integration/components/integration-icons";
import cellClasses from "@/features/base/styles/cells.module.css";

type Props = {
  value: unknown;
  property: IBaseProperty;
  rowId: string;
  isEditing: boolean;
  onCommit: (value: unknown) => void;
  onCancel: () => void;
};

export function asConnected(value: unknown): IConnectedValue | null {
  return value && typeof value === "object" && typeof (value as IConnectedValue).url === "string" ? (value as IConnectedValue) : null;
}

// Paste a link; the server fills in the title and status through the
// integrations and keeps them fresh.
export function CellConnected({ value, isEditing, onCommit, onCancel }: Props) {
  const { t } = useTranslation();
  const current = asConnected(value);
  const [draft, setDraft] = useState(current?.url ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);

  useEffect(() => {
    if (isEditing) {
      committedRef.current = false;
      setDraft(current?.url ?? "");
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [isEditing, current?.url]);

  const commitOnce = useCallback(
    (url: string) => {
      if (committedRef.current) return;
      committedRef.current = true;
      const trimmed = url.trim();
      if (!trimmed) return onCommit(null);
      if (trimmed === current?.url) return onCommit(value);
      onCommit({ url: trimmed });
    },
    [onCommit, current?.url, value],
  );

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        type="url"
        className={cellClasses.cellInput}
        value={draft}
        placeholder="https://"
        onChange={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitOnce(draft);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => commitOnce(draft)}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }

  if (!current) return <span className={cellClasses.emptyValue} />;
  const pending = !current.fetchedAt;
  const label = current.title || current.url.replace(/^https?:\/\//, "");
  return (
    <Tooltip label={current.error ?? (current.description || current.author ? [current.author, current.description].filter(Boolean).join(" · ") : current.url)} openDelay={400} withArrow multiline maw={320}>
      <a className={cellClasses.urlLink} href={current.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} style={{ display: "inline-flex", alignItems: "center", gap: 4, maxWidth: "100%" }} data-testid="connected-cell">
        {pending ? <IconLoader2 size={12} className="spin" /> : current.providerIcon || current.provider ? getIntegrationIcon(current.providerIcon ?? current.provider ?? "", 14) : <IconLink size={12} />}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        {current.status && (
          <Badge size="xs" variant="light" color={current.statusColor ?? "gray"} style={{ textTransform: "none", flexShrink: 0 }}>
            {current.status}
          </Badge>
        )}
        {current.error && !current.status && (
          <Badge size="xs" variant="light" color="yellow" style={{ textTransform: "none", flexShrink: 0 }}>
            {t("no details")}
          </Badge>
        )}
      </a>
    </Tooltip>
  );
}
