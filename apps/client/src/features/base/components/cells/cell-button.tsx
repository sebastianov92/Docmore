import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconPlayerPlay } from "@tabler/icons-react";
import { ButtonTypeOptions, IBaseProperty } from "@/features/base/types/base.types";
import { runAutomation } from "@/features/base/services/base-service";
import { getApiErrorMessage } from "@/lib/api-error";

type Props = {
  value: unknown;
  property: IBaseProperty;
  rowId: string;
  isEditing: boolean;
  onCommit: (value: unknown) => void;
  onCancel: () => void;
};

// A button in a cell: runs the property's automation for this row.
export function CellButton({ property, rowId }: Props) {
  const { t } = useTranslation();
  const options = (property.typeOptions ?? {}) as ButtonTypeOptions;
  const [running, setRunning] = useState(false);
  const run = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!options.automationId) return;
    setRunning(true);
    try {
      const result = await runAutomation({ pageId: property.pageId, automationId: options.automationId, rowId });
      if (!result.ran) notifications.show({ message: t("Conditions not met for this row"), color: "yellow" });
      else if (result.ok === false) notifications.show({ message: result.errors?.join("; ") || t("Automation failed"), color: "red" });
      else notifications.show({ message: t("Done") });
    } catch (err) {
      notifications.show({ message: getApiErrorMessage(err), color: "red" });
    } finally {
      setRunning(false);
    }
  };
  return (
    <Button
      size="compact-xs"
      variant="light"
      leftSection={<IconPlayerPlay size={12} />}
      disabled={!options.automationId}
      loading={running}
      onClick={run}
      onDoubleClick={(e) => e.stopPropagation()}
      data-testid="cell-button"
    >
      {options.label || t("Run")}
    </Button>
  );
}
