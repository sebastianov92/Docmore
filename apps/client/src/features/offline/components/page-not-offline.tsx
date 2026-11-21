import { Button } from "@mantine/core";
import { IconCloudOff } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { EmptyState } from "@/components/ui/empty-state.tsx";

// A page that exists but was not brought down to this device.
export function PageNotOffline() {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon={IconCloudOff}
      title={t("This page is not on this device")}
      description={t(
        "It opens again when the server is reachable. To have it next time, mark the page or its space as available offline.",
      )}
      action={
        <Button component={Link} to="/home" variant="default" size="sm" mt="xs">
          {t("Go to homepage")}
        </Button>
      }
    />
  );
}
