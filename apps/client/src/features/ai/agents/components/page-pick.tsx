import { useState } from "react";
import { CheckIcon, Combobox, Group, InputBase, ScrollArea, Text, useCombobox } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconFileText, IconSearch } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useSearchSuggestionsQuery } from "@/features/search/queries/search-query";

export type PickedPage = { id: string; title: string };

type Props = {
  value: PickedPage | null;
  onChange: (page: PickedPage | null) => void;
  // only pages of this space
  spaceId?: string | null;
  placeholder: string;
  // the choice that stands for "no page"
  noneLabel?: string;
  testId?: string;
};

// A page chosen by searching for it: a compact button and a wide list.
export function PagePick({ value, onChange, spaceId, placeholder, noneLabel, testId }: Props) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [debounced] = useDebouncedValue(search.trim(), 300);
  const combobox = useCombobox({
    onDropdownOpen: () => combobox.focusSearchInput(),
    onDropdownClose: () => {
      combobox.resetSelectedOption();
      setSearch("");
    },
  });
  const { data } = useSearchSuggestionsQuery({
    query: debounced,
    includePages: true,
    spaceId: spaceId ?? undefined,
    limit: 25,
    preload: true,
  });
  const pages = (data?.pages ?? [])
    .filter((page) => page && !(page as any).isBase && (!spaceId || page.spaceId === spaceId))
    .map((page) => ({ id: page!.id as string, title: page!.title || t("Untitled") }));

  return (
    <Combobox
      store={combobox}
      withinPortal
      onOptionSubmit={(id) => {
        if (id === "__none") onChange(null);
        else {
          const page = pages.find((p) => p.id === id);
          if (page) onChange(page);
        }
        combobox.closeDropdown();
      }}
    >
      <Combobox.Target>
        <InputBase
          component="button"
          type="button"
          pointer
          rightSection={<Combobox.Chevron />}
          rightSectionPointerEvents="none"
          onClick={() => combobox.toggleDropdown()}
          data-testid={testId}
        >
          {value ? (
            <Group gap={6} wrap="nowrap">
              <IconFileText size={15} stroke={1.6} />
              <Text size="sm" truncate>
                {value.title}
              </Text>
            </Group>
          ) : (
            <Text size="sm" c="dimmed" truncate>
              {placeholder}
            </Text>
          )}
        </InputBase>
      </Combobox.Target>
      <Combobox.Dropdown>
        <Combobox.Search
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          placeholder={t("Search pages…")}
          leftSection={<IconSearch size={14} />}
        />
        <Combobox.Options>
          <ScrollArea.Autosize mah={260} type="scroll">
            {noneLabel && !debounced && (
              <Combobox.Option value="__none">
                <Group gap={6} wrap="nowrap">
                  {!value && <CheckIcon size={11} />}
                  <Text size="sm">{noneLabel}</Text>
                </Group>
              </Combobox.Option>
            )}
            {pages.map((page) => (
              <Combobox.Option key={page.id} value={page.id}>
                <Group gap={6} wrap="nowrap">
                  {value?.id === page.id ? <CheckIcon size={11} /> : <IconFileText size={14} stroke={1.6} />}
                  <Text size="sm" truncate>
                    {page.title}
                  </Text>
                </Group>
              </Combobox.Option>
            ))}
            {pages.length === 0 && <Combobox.Empty>{t("No pages found")}</Combobox.Empty>}
          </ScrollArea.Autosize>
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  );
}
