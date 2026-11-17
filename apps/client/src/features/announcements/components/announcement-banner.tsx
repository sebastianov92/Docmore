import type { MouseEvent } from "react";
import { ActionIcon, VisuallyHidden } from "@mantine/core";
import { IconAlertOctagon, IconAlertTriangle, IconCircleCheck, IconInfoCircle, IconX, type Icon } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  ANNOUNCEMENT_COLOR_STYLES,
  ANNOUNCEMENT_TYPE_LABELS,
  AnnouncementBanner as Banner,
  AnnouncementType,
} from "../types";
import { getAnnouncementPreview } from "../utils";
import { AnnouncementContent } from "./announcement-content";
import classes from "./announcement-banners.module.css";

export const ANNOUNCEMENT_TYPE_ICONS: Record<AnnouncementType, Icon | null> = {
  info: IconInfoCircle,
  success: IconCircleCheck,
  warning: IconAlertTriangle,
  critical: IconAlertOctagon,
  neutral: null,
};

interface Props {
  announcement: Pick<Banner, "type" | "color" | "content" | "isDismissible">;
  onDismiss?: (event: MouseEvent<HTMLButtonElement>) => void;
}

export function AnnouncementBanner({ announcement, onDismiss }: Props) {
  const { t } = useTranslation();
  const colors = ANNOUNCEMENT_COLOR_STYLES[announcement.color] ?? ANNOUNCEMENT_COLOR_STYLES.gray;
  const TypeIcon = ANNOUNCEMENT_TYPE_ICONS[announcement.type] ?? null;
  const typeLabel = ANNOUNCEMENT_TYPE_LABELS[announcement.type];

  return (
    <div
      className={classes.bar}
      data-dismissible={announcement.isDismissible || undefined}
      style={{ backgroundColor: colors.background, color: colors.text }}
    >
      {TypeIcon && <TypeIcon size={18} className={classes.icon} aria-hidden />}
      <div>
        {typeLabel && announcement.type !== "neutral" && <VisuallyHidden>{`${t(typeLabel)}: `}</VisuallyHidden>}
        <AnnouncementContent content={announcement.content} />
      </div>
      {announcement.isDismissible && (
        <span className={classes.close}>
          <ActionIcon
            variant="subtle"
            color={colors.text}
            aria-label={t("Dismiss {{name}}", { name: getAnnouncementPreview(announcement.content) })}
            onClick={onDismiss}
          >
            <IconX size={16} aria-hidden />
          </ActionIcon>
        </span>
      )}
    </div>
  );
}
