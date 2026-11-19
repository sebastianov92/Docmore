import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Popover } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { useQuery } from "@tanstack/react-query";
import { IconX } from "@tabler/icons-react";
import { Link } from "react-router-dom";
import clsx from "clsx";
import { IBaseProperty, RelationTypeOptions } from "@/features/base/types/base.types";
import { useBaseRowReferences } from "@/features/base/hooks/use-base-row-references";
import { useBaseQuery } from "@/features/base/queries/base-query";
import { listRows } from "@/features/base/services/base-service";
import { useListKeyboardNav } from "@/features/base/hooks/use-list-keyboard-nav";
import cellClasses from "@/features/base/styles/cells.module.css";

type CellRelationProps = {
  value: unknown;
  property: IBaseProperty;
  rowId: string;
  isEditing: boolean;
  onCommit: (value: unknown) => void;
  onCancel: () => void;
};

function idsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") return [value];
  return [];
}

// Chips with the related rows' titles; the picker searches the target base.
export function CellRelation({ value, property, isEditing, onCommit, onCancel }: CellRelationProps) {
  const options = (property.typeOptions ?? {}) as RelationTypeOptions;
  const allowMultiple = options.allowMultiple !== false;
  const ids = idsOf(value);
  const references = useBaseRowReferences(property.pageId);
  const titleOf = (id: string) => references.rows?.[id]?.title || "Untitled";

  if (isEditing) {
    return (
      <RelationPicker
        ids={ids}
        targetPageId={options.targetPageId}
        allowMultiple={allowMultiple}
        titleOf={titleOf}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    );
  }

  if (ids.length === 0) return <span className={cellClasses.emptyValue} />;
  return (
    <div className={cellClasses.badgeGroup}>
      {ids.slice(0, 3).map((id) => (
        <Link
          key={id}
          to={`/base/${options.targetPageId}?row=${id}`}
          className={clsx(cellClasses.badge, cellClasses.pagePill)}
          onClick={(e) => e.stopPropagation()}
          title={titleOf(id)}
        >
          <span className={cellClasses.pagePillText}>{titleOf(id)}</span>
        </Link>
      ))}
      {ids.length > 3 && <span className={cellClasses.overflowCount}>+{ids.length - 3}</span>}
    </div>
  );
}

type PickerProps = {
  ids: string[];
  targetPageId: string;
  allowMultiple: boolean;
  titleOf: (id: string) => string;
  onCommit: (value: unknown) => void;
  onCancel: () => void;
};

function RelationPicker({ ids, targetPageId, allowMultiple, titleOf, onCommit, onCancel }: PickerProps) {
  const [search, setSearch] = useState("");
  const [debounced] = useDebouncedValue(search, 250);
  const searchRef = useRef<HTMLInputElement>(null);
  const { data: targetBase } = useBaseQuery(targetPageId);
  const primaryId = useMemo(() => targetBase?.properties.find((p) => p.isPrimary)?.id, [targetBase]);

  useEffect(() => {
    requestAnimationFrame(() => searchRef.current?.focus());
  }, []);

  const trimmed = debounced.trim();
  const { data } = useQuery({
    queryKey: ["bases", "relation-search", targetPageId, trimmed],
    queryFn: () =>
      listRows(targetPageId, {
        limit: 25,
        ...(trimmed ? { search: { query: trimmed } } : {}),
      }),
    staleTime: 10_000,
    enabled: !!targetPageId,
  });
  const candidates = useMemo(
    () =>
      (data?.items ?? []).map((row) => ({
        id: row.id,
        title: (primaryId ? (row.cells?.[primaryId] as string) : "") || "Untitled",
      })),
    [data, primaryId],
  );
  const { activeIndex, setActiveIndex, handleNavKey, setOptionRef } = useListKeyboardNav(candidates.length, [debounced]);

  const handleSelect = useCallback(
    (id: string) => {
      if (allowMultiple) {
        if (ids.includes(id)) {
          const next = ids.filter((x) => x !== id);
          onCommit(next.length ? next : null);
        } else onCommit([...ids, id]);
      } else {
        onCommit(ids.includes(id) ? null : [id]);
      }
    },
    [allowMultiple, ids, onCommit],
  );
  const handleRemove = useCallback(
    (id: string) => {
      const next = ids.filter((x) => x !== id);
      onCommit(next.length ? next : null);
    },
    [ids, onCommit],
  );
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }
      if (handleNavKey(e)) return;
      if (e.key === "Enter" && activeIndex >= 0 && activeIndex < candidates.length) {
        e.preventDefault();
        handleSelect(candidates[activeIndex].id);
        return;
      }
      if (e.key === "Backspace" && search === "" && ids.length > 0) {
        e.preventDefault();
        handleRemove(ids[ids.length - 1]);
      }
    },
    [onCancel, handleNavKey, activeIndex, candidates, handleSelect, search, ids, handleRemove],
  );

  return (
    <Popover opened onClose={onCancel} position="bottom-start" width={320} trapFocus>
      <Popover.Target>
        <div style={{ width: "100%", height: "100%" }} />
      </Popover.Target>
      <Popover.Dropdown p={0}>
        <div className={cellClasses.personTagArea}>
          {ids.map((id) => (
            <span key={id} className={cellClasses.personTag}>
              <span className={cellClasses.personTagName}>{titleOf(id)}</span>
              <button
                type="button"
                className={cellClasses.personTagRemove}
                onClick={(e) => {
                  e.stopPropagation();
                  handleRemove(id);
                }}
              >
                <IconX size={10} />
              </button>
            </span>
          ))}
          <input
            ref={searchRef}
            className={cellClasses.personTagInput}
            placeholder={ids.length ? "" : "Search rows..."}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div className={cellClasses.personDropdownDivider} />
        <div className={cellClasses.selectDropdown}>
          {candidates.length === 0 && (
            <div className={cellClasses.personDropdownHint}>{trimmed ? "No rows found" : "No rows yet"}</div>
          )}
          {candidates.map((row, idx) => {
            const selected = ids.includes(row.id);
            return (
              <div
                key={row.id}
                ref={setOptionRef(idx)}
                className={clsx(
                  cellClasses.selectOption,
                  selected && cellClasses.selectOptionActive,
                  idx === activeIndex && cellClasses.selectOptionKeyboardActive,
                )}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => handleSelect(row.id)}
              >
                <span className={cellClasses.personOptionName}>{row.title}</span>
              </div>
            );
          })}
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}
