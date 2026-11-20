import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { IconPlus } from "@tabler/icons-react";
import { IBase, IBaseProperty, IBaseRow, IBaseView } from "@/features/base/types/base.types";
import { useBaseRowReferences } from "@/features/base/hooks/use-base-row-references";
import { getFileUrl } from "@/lib/config";
import { CardProperties } from "@/features/base/components/views/cards/card-properties";
import { cardProperties, coverImageUrl, rowTitle } from "@/features/base/components/views/cards/card-utils";
import { CustomAvatar } from "@/components/ui/custom-avatar";
import classes from "@/features/base/styles/feed.module.css";

type BaseFeedProps = {
  base: IBase;
  rows: IBaseRow[];
  effectiveView: IBaseView | undefined;
  embedded?: boolean;
  onCardClick: (rowId: string) => void;
  onAddRow?: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onFetchNextPage: () => void;
};

// Rows as posts in one column: who added it and when, the title, a long
// text as the body, the cover, then the rest of the properties.
export function BaseFeed({ base, rows, effectiveView, embedded, onCardClick, onAddRow, hasNextPage, isFetchingNextPage, onFetchNextPage }: BaseFeedProps) {
  const { t } = useTranslation();
  const references = useBaseRowReferences(base.id);
  const primary = useMemo(() => base.properties.find((p) => p.isPrimary), [base.properties]);
  const bodyId = effectiveView?.config?.feedBodyPropertyId;
  const body = useMemo<IBaseProperty | undefined>(
    () => (bodyId ? base.properties.find((p) => p.id === bodyId) : base.properties.find((p) => p.type === "longText")),
    [bodyId, base.properties],
  );
  const coverId = effectiveView?.config?.coverPropertyId;
  const coverProperty = useMemo(() => (coverId ? base.properties.find((p) => p.id === coverId && p.type === "file") : undefined), [coverId, base.properties]);
  const showProps = effectiveView?.config?.feedShowProperties !== false;
  const properties = useMemo(() => cardProperties(base, effectiveView, 6).filter((p) => p.id !== body?.id), [base, effectiveView, body?.id]);
  const rootRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = endRef.current;
    if (!target || !hasNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingNextPage) onFetchNextPage();
      },
      { root: embedded ? null : rootRef.current, threshold: 0.1 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, onFetchNextPage, embedded]);

  return (
    <div className={classes.root} data-standalone={!embedded || undefined} ref={rootRef} data-testid="base-feed">
      {onAddRow && (
        <button type="button" className={classes.compose} onClick={onAddRow}>
          <IconPlus size={14} />
          <span>{t("New post")}</span>
        </button>
      )}
      {rows.map((row) => {
        const title = rowTitle(row, primary);
        const cover = coverImageUrl(row, coverProperty);
        const author = references?.users?.[row.creatorId];
        const text = body ? String(row.cells?.[body.id] ?? "") : "";
        return (
          <article
            key={row.id}
            className={classes.post}
            role="button"
            tabIndex={0}
            data-row-id={row.id}
            onClick={() => onCardClick(row.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onCardClick(row.id);
              }
            }}
          >
            <header className={classes.head}>
              <CustomAvatar avatarUrl={author?.avatarUrl ?? undefined} name={author?.name ?? "?"} size="sm" />
              <div className={classes.meta}>
                <span className={classes.author}>{author?.name ?? t("Someone")}</span>
                <time className={classes.when} dateTime={row.createdAt}>
                  {new Date(row.createdAt).toLocaleString()}
                </time>
              </div>
            </header>
            {title && <h3 className={classes.title}>{title}</h3>}
            {text && <p className={classes.body}>{text}</p>}
            {cover && <img className={classes.cover} src={getFileUrl(cover)} alt="" loading="lazy" />}
            {showProps && properties.length > 0 && (
              <div className={classes.props}>
                <CardProperties row={row} properties={properties} layout="inline" />
              </div>
            )}
          </article>
        );
      })}
      {rows.length === 0 && <div className={classes.empty}>{t("Nothing posted yet.")}</div>}
      <div ref={endRef} className={classes.sentinel} />
    </div>
  );
}
