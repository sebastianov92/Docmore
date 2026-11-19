import { useTranslation } from "react-i18next";
import { IBaseProperty, IBaseRow } from "@/features/base/types/base.types";
import { CellRenderer } from "@/features/base/components/cells/cell-renderer";
import { propertyTypes } from "@/features/base/components/property/property-type-picker";
import { cellValue, isEmptyValue } from "./card-utils";
import classes from "@/features/base/styles/cards.module.css";

const ICON_BY_TYPE = new Map(propertyTypes.map((p) => [p.type, p.icon] as const));
const noop = () => {};

type Props = {
  row: IBaseRow;
  properties: IBaseProperty[];
  // "stack" lists label + value per line; "inline" packs filled values in a row.
  layout: "stack" | "inline";
};

// Read-only property values on a card. Empty values are skipped so cards
// stay short; the cells themselves are the grid's own renderers.
export function CardProperties({ row, properties, layout }: Props) {
  const { t } = useTranslation();
  const filled = properties
    .map((property) => ({ property, value: cellValue(row, property) }))
    .filter(({ value }) => !isEmptyValue(value));
  if (filled.length === 0) return null;
  return (
    <div className={layout === "inline" ? classes.inlineProps : classes.stackProps}>
      {filled.map(({ property, value }) => {
        const Icon = ICON_BY_TYPE.get(property.type);
        return (
          <div key={property.id} className={classes.prop} title={property.name || t("Untitled")}>
            {layout === "stack" ? (
              <span className={classes.propLabel}>
                {Icon && <Icon size={12} />}
                <span>{property.name || t("Untitled")}</span>
              </span>
            ) : (
              Icon && <Icon size={12} className={classes.propIcon} />
            )}
            <span className={classes.propValue}>
              <CellRenderer
                value={value}
                property={property}
                rowId={row.id}
                isEditing={false}
                onCommit={noop}
                onCancel={noop}
              />
            </span>
          </div>
        );
      })}
    </div>
  );
}
