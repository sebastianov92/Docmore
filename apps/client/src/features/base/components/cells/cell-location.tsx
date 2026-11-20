import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Group, NumberInput, Popover, Stack, TextInput } from "@mantine/core";
import { IconMapPin } from "@tabler/icons-react";
import { IBaseProperty, ILocationValue } from "@/features/base/types/base.types";
import cellClasses from "@/features/base/styles/cells.module.css";

type Props = {
  value: unknown;
  property: IBaseProperty;
  rowId: string;
  isEditing: boolean;
  onCommit: (value: unknown) => void;
  onCancel: () => void;
};

const COORDS = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

export function asLocation(value: unknown): ILocationValue | null {
  if (!value || typeof value !== "object") return null;
  const v = value as ILocationValue;
  return typeof v.name === "string" || typeof v.lat === "number" ? v : null;
}

export function locationLabel(v: ILocationValue | null): string {
  if (!v) return "";
  if (v.name) return v.name;
  return typeof v.lat === "number" && typeof v.lng === "number" ? `${v.lat}, ${v.lng}` : "";
}

// Where to look at it: a pin on OpenStreetMap by coordinates, else a search
// by name and address.
export function locationMapUrl(v: ILocationValue): string {
  if (typeof v.lat === "number" && typeof v.lng === "number") {
    return `https://www.openstreetmap.org/?mlat=${v.lat}&mlon=${v.lng}#map=16/${v.lat}/${v.lng}`;
  }
  return `https://www.openstreetmap.org/search?query=${encodeURIComponent([v.name, v.address].filter(Boolean).join(", "))}`;
}

// A place: name, address and coordinates in a small form; the display links
// to a map. Typing "lat, lng" in the name box fills the coordinates.
export function CellLocation({ value, isEditing, onCommit, onCancel }: Props) {
  const { t } = useTranslation();
  const current = asLocation(value);
  const [draft, setDraft] = useState<ILocationValue>({ name: "", address: "", lat: null, lng: null });
  useEffect(() => {
    if (isEditing) setDraft({ name: current?.name ?? "", address: current?.address ?? "", lat: current?.lat ?? null, lng: current?.lng ?? null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing]);

  const commit = useCallback(() => {
    let { name, lat, lng } = draft;
    const m = COORDS.exec(name);
    if (m && lat === null) {
      lat = Number(m[1]);
      lng = Number(m[2]);
      name = "";
    }
    const empty = !name.trim() && !(typeof lat === "number" && typeof lng === "number");
    onCommit(empty ? null : { name: name.trim(), address: draft.address?.trim() || null, lat: typeof lat === "number" ? lat : null, lng: typeof lng === "number" ? lng : null });
  }, [draft, onCommit]);

  if (isEditing) {
    return (
      <Popover opened onClose={onCancel} position="bottom-start" withinPortal shadow="md" trapFocus>
        <Popover.Target>
          <span className={cellClasses.cellInput} style={{ display: "block" }}>
            {locationLabel(current) || t("Place")}
          </span>
        </Popover.Target>
        <Popover.Dropdown onClick={(e) => e.stopPropagation()} data-testid="location-editor">
          <Stack gap="xs" w={280}>
            <TextInput
              size="xs"
              label={t("Place")}
              placeholder={t("Name, or lat, lng")}
              autoFocus
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit();
                } else if (e.key === "Escape") onCancel();
              }}
            />
            <TextInput size="xs" label={t("Address")} value={draft.address ?? ""} onChange={(e) => setDraft({ ...draft, address: e.currentTarget.value })} />
            <Group gap="xs" grow>
              <NumberInput size="xs" label={t("Latitude")} min={-90} max={90} decimalScale={6} value={draft.lat ?? ""} onChange={(v) => setDraft({ ...draft, lat: v === "" ? null : Number(v) })} />
              <NumberInput size="xs" label={t("Longitude")} min={-180} max={180} decimalScale={6} value={draft.lng ?? ""} onChange={(v) => setDraft({ ...draft, lng: v === "" ? null : Number(v) })} />
            </Group>
            <Group justify="flex-end" gap="xs">
              <Button size="compact-xs" variant="default" onClick={onCancel}>
                {t("Cancel")}
              </Button>
              <Button size="compact-xs" onClick={commit} data-testid="location-save">
                {t("Save")}
              </Button>
            </Group>
          </Stack>
        </Popover.Dropdown>
      </Popover>
    );
  }

  if (!current) return <span className={cellClasses.emptyValue} />;
  return (
    <a className={cellClasses.urlLink} href={locationMapUrl(current)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title={current.address ?? undefined}>
      <IconMapPin size={12} style={{ verticalAlign: -1, marginRight: 3 }} />
      {locationLabel(current)}
    </a>
  );
}
