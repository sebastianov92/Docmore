import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import { IconPlus } from "@tabler/icons-react";
import { IBase, IBaseRow, IBaseView } from "@/features/base/types/base.types";
import { getFileUrl } from "@/lib/config";
import { CardProperties } from "@/features/base/components/views/cards/card-properties";
import {
  cardProperties,
  coverImageUrl,
  rowTitle,
} from "@/features/base/components/views/cards/card-utils";
import classes from "@/features/base/styles/gallery.module.css";

type BaseGalleryProps = {
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

// Cards in a responsive grid: optional cover from a file property, the
// title, then the filled properties.
export function BaseGallery({
  base,
  rows,
  effectiveView,
  embedded,
  onCardClick,
  onAddRow,
  hasNextPage,
  isFetchingNextPage,
  onFetchNextPage,
}: BaseGalleryProps) {
  const { t } = useTranslation();
  const primary = useMemo(() => base.properties.find((p) => p.isPrimary), [base.properties]);
  const properties = useMemo(() => cardProperties(base, effectiveView, 4), [base, effectiveView]);
  const coverId = effectiveView?.config?.coverPropertyId;
  const coverProperty = useMemo(
    () => (coverId ? base.properties.find((p) => p.id === coverId && p.type === "file") : undefined),
    [coverId, base.properties],
  );
  const size = effectiveView?.config?.cardSize ?? "medium";
  const rootRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hasNextPage || isFetchingNextPage) return;
    const target = endRef.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onFetchNextPage();
      },
      { root: embedded ? null : rootRef.current, threshold: 0.1 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, onFetchNextPage, embedded]);

  return (
    <div
      className={classes.root}
      data-size={size}
      data-standalone={!embedded || undefined}
      ref={rootRef}
    >
      {rows.map((row) => {
        const title = rowTitle(row, primary);
        const cover = coverImageUrl(row, coverProperty);
        return (
          <div
            key={row.id}
            className={classes.card}
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
            {coverProperty &&
              (cover ? (
                <img className={classes.cover} src={getFileUrl(cover)} alt="" loading="lazy" />
              ) : (
                <div className={classes.coverEmpty} />
              ))}
            <div className={classes.body}>
              <div className={clsx(classes.title, !title && classes.titleEmpty)}>
                {title || t("Untitled")}
              </div>
              <CardProperties row={row} properties={properties} layout="stack" />
            </div>
          </div>
        );
      })}
      {onAddRow && (
        <div className={classes.addCard} role="button" tabIndex={0} onClick={onAddRow}>
          <IconPlus size={14} />
          <span>{t("New")}</span>
        </div>
      )}
      <div ref={endRef} className={classes.sentinel} />
    </div>
  );
}
