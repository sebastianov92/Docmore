import "@mantine/dates/styles.css";
import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  ColorSwatch,
  Group,
  Input,
  List,
  Modal,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { DateTimePicker } from "@mantine/dates";
import { IconAlertCircle } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { getApiErrorMessage } from "@/lib/api-error";
import { getAnnouncementConflict, getAnnouncementTakeovers, useCreateAnnouncementMutation, useUpdateAnnouncementMutation } from "../queries";
import {
  ANNOUNCEMENT_COLOR_STYLES,
  ANNOUNCEMENT_COLORS,
  ANNOUNCEMENT_MAX_TEXT_LENGTH,
  ANNOUNCEMENT_MAX_TITLE_LENGTH,
  ANNOUNCEMENT_TYPE_DEFAULT_COLOR,
  ANNOUNCEMENT_TYPE_LABELS,
  ANNOUNCEMENT_TYPES,
  Announcement,
  AnnouncementAudience,
  AnnouncementColor,
  AnnouncementContent,
  AnnouncementTakeover,
  AnnouncementType,
} from "../types";
import { formatAnnouncementTime, getAnnouncementPlainText } from "../utils";
import { AnnouncementBanner } from "./announcement-banner";
import { AnnouncementMessageEditor } from "./announcement-message-editor";
import classes from "./announcement-form.module.css";

interface Props {
  opened: boolean;
  onClose: () => void;
  announcement: Announcement | null;
}

interface FormValues {
  title: string;
  type: AnnouncementType;
  color: AnnouncementColor;
  content: AnnouncementContent | null;
  audience: AnnouncementAudience;
  isDismissible: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
}

const EMPTY: FormValues = {
  title: "",
  type: "info",
  color: "blue",
  content: null,
  audience: "members",
  isDismissible: false,
  startsAt: null,
  endsAt: null,
};

function fromAnnouncement(a: Announcement | null): FormValues {
  if (!a) return EMPTY;
  return {
    title: a.title,
    type: a.type,
    color: a.color,
    content: a.content,
    audience: a.audience,
    isDismissible: a.isDismissible,
    startsAt: new Date(a.startsAt),
    endsAt: a.endsAt ? new Date(a.endsAt) : null,
  };
}

// New or edited announcement. An overlap with another one comes back from
// the server as a notice; saving again replaces (cuts short) the others.
export function AnnouncementFormModal({ opened, onClose, announcement }: Props) {
  const { t, i18n } = useTranslation();
  const create = useCreateAnnouncementMutation();
  const update = useUpdateAnnouncementMutation();
  const mutation = announcement ? update : create;
  const [values, setValues] = useState<FormValues>(() => fromAnnouncement(announcement));
  const [errors, setErrors] = useState<Partial<Record<keyof FormValues, string>>>({});
  const [takeovers, setTakeovers] = useState<{ replaces: AnnouncementTakeover[]; replacedBy: AnnouncementTakeover[] } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (opened) {
      setValues(fromAnnouncement(announcement));
      setErrors({});
      setTakeovers(null);
      setFailure(null);
      create.reset();
      update.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, announcement?.id]);

  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setTakeovers(null);
    setFailure(null);
  };

  const preview = useMemo(
    () => ({
      type: values.type,
      color: values.color,
      content: values.content ?? { type: "doc" as const, content: [{ type: "paragraph" as const, content: [] }] },
      isDismissible: values.isDismissible,
    }),
    [values.type, values.color, values.content, values.isDismissible],
  );

  const validate = (): boolean => {
    const next: typeof errors = {};
    const title = values.title.trim();
    if (!title) next.title = t("Give the announcement a title");
    else if (title.length > ANNOUNCEMENT_MAX_TITLE_LENGTH) next.title = t("The title is too long");
    const text = getAnnouncementPlainText(values.content);
    if (!text.trim()) next.content = t("Write the message");
    else if (text.length > ANNOUNCEMENT_MAX_TEXT_LENGTH) next.content = t("The message is too long (max {{max}} characters)", { max: ANNOUNCEMENT_MAX_TEXT_LENGTH });
    const start = values.startsAt?.getTime() ?? Date.now();
    if (values.endsAt) {
      const end = values.endsAt.getTime();
      const storedEnd = announcement?.endsAt ? Date.parse(announcement.endsAt) : null;
      if (end !== storedEnd && end <= Date.now()) next.endsAt = t("The end time must be in the future");
      else if (end <= start) next.endsAt = t("The end time must be after the start");
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async (replace: boolean) => {
    if (!validate()) return;
    const input = {
      title: values.title.trim(),
      type: values.type,
      color: values.color,
      content: values.content!,
      isDismissible: values.isDismissible,
      audience: values.audience,
      startsAt: values.startsAt ? values.startsAt.toISOString() : null,
      endsAt: values.endsAt ? values.endsAt.toISOString() : null,
      replace,
    };
    try {
      if (announcement) await update.mutateAsync({ ...input, announcementId: announcement.id });
      else await create.mutateAsync(input);
      onClose();
    } catch (err) {
      const overlap = getAnnouncementTakeovers(err);
      if (overlap) {
        setTakeovers(overlap);
        return;
      }
      const conflict = getAnnouncementConflict(err);
      setFailure(
        conflict
          ? t("It overlaps: {{titles}}", { titles: conflict.announcements.map((a) => a.title).join(", ") })
          : getApiErrorMessage(err, announcement ? t("Could not update the announcement") : t("Could not create the announcement")),
      );
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={announcement ? t("Edit announcement") : t("New announcement")}
      size="lg"
      closeButtonProps={{ "aria-label": t("Close") }}
    >
      <Stack gap="md">
        {takeovers && (
          <Alert color="yellow" icon={<IconAlertCircle size={16} />} title={t("Only one announcement shows at a time")}>
            <List size="sm" listStyleType="none">
              {takeovers.replaces.map((item) => (
                <List.Item key={`r-${item.id}`}>
                  {t("“{{title}}” will stop showing when this one starts.", { title: item.title })}
                </List.Item>
              ))}
              {takeovers.replacedBy.map((item) => (
                <List.Item key={`b-${item.id}`}>
                  {t("This one will stop when “{{title}}” starts ({{time}}).", {
                    title: item.title,
                    time: formatAnnouncementTime(item.at, i18n.language),
                  })}
                </List.Item>
              ))}
            </List>
          </Alert>
        )}
        {failure && (
          <Alert color="red" icon={<IconAlertCircle size={16} />}>
            {failure}
          </Alert>
        )}

        <TextInput
          label={t("Title")}
          description={t("For the list; the banner shows the message.")}
          value={values.title}
          maxLength={ANNOUNCEMENT_MAX_TITLE_LENGTH}
          onChange={(e) => set("title", e.currentTarget.value)}
          error={errors.title}
          data-autofocus
        />

        <Group grow align="flex-start">
          <Select
            label={t("Type")}
            data={ANNOUNCEMENT_TYPES.map((type) => ({ value: type, label: t(ANNOUNCEMENT_TYPE_LABELS[type]) }))}
            value={values.type}
            allowDeselect={false}
            onChange={(value) => {
              const type = (value ?? "info") as AnnouncementType;
              setValues((prev) => ({ ...prev, type, color: ANNOUNCEMENT_TYPE_DEFAULT_COLOR[type] }));
            }}
          />
          <Select
            label={t("Audience")}
            data={[
              { value: "members", label: t("Signed-in members") },
              { value: "everyone", label: t("Everyone, public pages too") },
            ]}
            value={values.audience}
            allowDeselect={false}
            onChange={(value) => set("audience", (value ?? "members") as AnnouncementAudience)}
          />
        </Group>

        <Input.Wrapper label={t("Color")} labelElement="div">
          <Group gap="xs" role="radiogroup" aria-label={t("Color")} mt={4}>
            {ANNOUNCEMENT_COLORS.map((color) => (
              <ColorSwatch
                key={color}
                component="button"
                type="button"
                role="radio"
                aria-checked={values.color === color}
                aria-label={t(ANNOUNCEMENT_COLOR_STYLES[color].label)}
                color={ANNOUNCEMENT_COLOR_STYLES[color].background}
                className={classes.swatch}
                data-selected={values.color === color || undefined}
                size={24}
                onClick={() => set("color", color)}
              />
            ))}
          </Group>
        </Input.Wrapper>

        <div>
          <Text size="sm" fw={500} mb={4}>
            {t("Message")}
          </Text>
          <AnnouncementMessageEditor value={values.content} onChange={(content) => set("content", content)} error={errors.content} />
        </div>

        <Switch
          label={t("People can dismiss it")}
          description={t("A dismissed banner comes back if you change its text.")}
          checked={values.isDismissible}
          onChange={(e) => set("isDismissible", e.currentTarget.checked)}
        />

        <Group grow align="flex-start">
          <DateTimePicker
            label={t("Starts")}
            placeholder={t("Now")}
            value={values.startsAt}
            onChange={(value) => set("startsAt", value ? new Date(value) : null)}
            clearable
            valueFormat="DD MMM YYYY HH:mm"
          />
          <DateTimePicker
            label={t("Ends")}
            placeholder={t("No end")}
            value={values.endsAt}
            onChange={(value) => set("endsAt", value ? new Date(value) : null)}
            clearable
            error={errors.endsAt}
            valueFormat="DD MMM YYYY HH:mm"
          />
        </Group>

        <Input.Wrapper label={t("Preview")} labelElement="div">
          <div className={classes.preview}>
            <AnnouncementBanner announcement={preview} />
          </div>
        </Input.Wrapper>

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button onClick={() => submit(Boolean(takeovers))} loading={mutation.isPending}>
            {takeovers ? t("Save and replace") : announcement ? t("Save") : t("Create")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
