import { memo } from "react";
import { ActionIcon } from "@mantine/core";
import { IconChevronDown, IconChevronRight, IconPlus } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { choiceColor } from "@/features/base/components/cells/choice-color";
import { GridGroupHeaderItem } from "./grid-groups";
import classes from "@/features/base/styles/grid.module.css";

type Props = {
  item: GridGroupHeaderItem;
  onToggle: (key: string) => void;
  onAddRow?: (cells: Record<string, unknown>) => void;
};

// One group (or sub-group) heading inside the grid: chevron, name, count,
// and a "+" that adds a row already in that group.
export const GridGroupHeader = memo(function GridGroupHeader({ item, onToggle, onAddRow }: Props) {
  const { t } = useTranslation();
  return (
    <div className={classes.groupHeader} role="row" data-group-key={item.key} data-depth={item.depth}>
      <div className={classes.groupHeaderInner} style={{ paddingLeft: 8 + item.depth * 20 }}>
        <button
          type="button"
          className={classes.groupToggle}
          onClick={() => onToggle(item.key)}
          aria-expanded={!item.collapsed}
          aria-label={item.collapsed ? t("Expand group") : t("Collapse group")}
        >
          {item.collapsed ? <IconChevronRight size={14} /> : <IconChevronDown size={14} />}
        </button>
        <span className={classes.groupChip} style={item.color ? choiceColor(item.color) : undefined}>
          {item.name}
        </span>
        <span className={classes.groupCount}>{item.count}</span>
        {onAddRow && (
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label={t("New row in group")}
            onClick={() => onAddRow(item.presetCells)}
          >
            <IconPlus size={14} />
          </ActionIcon>
        )}
      </div>
    </div>
  );
});
