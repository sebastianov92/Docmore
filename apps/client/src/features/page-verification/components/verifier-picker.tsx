import { useState } from "react";
import { Group, Select, SelectProps, Text } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { useTranslation } from "react-i18next";
import { CustomAvatar } from "@/components/ui/custom-avatar";
import { useSearchSuggestionsQuery } from "@/features/search/queries/search-query";
import { IVerifier } from "@/features/page-verification/types";

interface Props {
  excludeIds: string[];
  onSelect: (user: IVerifier) => void;
  disabled?: boolean;
}

const renderOption: SelectProps["renderOption"] = ({ option }) => (
  <Group gap="sm" wrap="nowrap">
    <CustomAvatar avatarUrl={option["avatarUrl"]} name={option.label} size={20} />
    <div style={{ minWidth: 0 }}>
      <Text size="sm" lineClamp={1}>
        {option.label}
      </Text>
      {option["email"] && (
        <Text size="xs" c="dimmed" lineClamp={1}>
          {option["email"]}
        </Text>
      )}
    </div>
  </Group>
);

// Searches workspace members by name; picking one hands it back and clears.
export default function VerifierPicker({ excludeIds, onSelect, disabled }: Props) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [query] = useDebouncedValue(search, 250);
  const { data } = useSearchSuggestionsQuery({
    query,
    includeUsers: true,
    includeGroups: false,
    preload: true,
  });

  const excluded = new Set(excludeIds);
  const options = (data?.users ?? [])
    .filter((u) => !excluded.has(u.id))
    .map((u) => ({ value: u.id, label: u.name, email: u.email, avatarUrl: u.avatarUrl }));

  return (
    <Select
      data={options}
      value={null}
      searchable
      searchValue={search}
      onSearchChange={setSearch}
      onChange={(id) => {
        const picked = options.find((o) => o.value === id);
        if (!picked) return;
        onSelect({ id: picked.value, name: picked.label, email: picked.email, avatarUrl: picked.avatarUrl });
        setSearch("");
      }}
      renderOption={renderOption}
      filter={({ options }) => options}
      placeholder={t("Add a verifier")}
      nothingFoundMessage={t("No member found")}
      variant="filled"
      disabled={disabled}
      comboboxProps={{ withinPortal: true }}
      aria-label={t("Add a verifier")}
    />
  );
}
