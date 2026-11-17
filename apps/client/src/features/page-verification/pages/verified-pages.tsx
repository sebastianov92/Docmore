import { useMemo, useState } from "react";
import { Group, Select, Space, TextInput } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconSearch } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import SettingsTitle from "@/components/settings/settings-title.tsx";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import Paginate from "@/components/common/paginate.tsx";
import { useCursorPaginate } from "@/hooks/use-cursor-paginate.tsx";
import { useVerificationListQuery } from "@/features/page-verification/queries";
import { IVerificationListParams, VerificationType } from "@/features/page-verification/types";
import VerificationTable from "@/features/page-verification/components/verification-table";

// Settings > Verified pages: every verification the user can see.
export default function VerifiedPages() {
  const { t } = useTranslation();
  const { cursor, goNext, goPrev, resetCursor } = useCursorPaginate();
  const [search, setSearch] = useState("");
  const [debounced] = useDebouncedValue(search, 300);
  const [type, setType] = useState<VerificationType | null>(null);

  const params: IVerificationListParams = useMemo(
    () => ({ cursor, limit: 50, query: debounced || undefined, type: type ?? undefined }),
    [cursor, debounced, type],
  );
  const { data, isLoading } = useVerificationListQuery(params);

  return (
    <>
      <DocumentTitle title={t("Verified pages")} />
      <SettingsTitle title={t("Verified pages")} />

      <Group mb="md" gap="sm">
        <TextInput
          placeholder={t("Search by title")}
          leftSection={<IconSearch size={16} />}
          value={search}
          onChange={(e) => {
            setSearch(e.currentTarget.value);
            resetCursor();
          }}
          size="sm"
          w={240}
        />
        <Select
          placeholder={t("Any workflow")}
          data={[
            { value: "expiring", label: t("Recurring verification") },
            { value: "qms", label: t("Approval workflow") },
          ]}
          value={type}
          onChange={(v) => {
            setType((v as VerificationType) ?? null);
            resetCursor();
          }}
          clearable
          size="sm"
          w={220}
          comboboxProps={{ withinPortal: true }}
        />
      </Group>

      <VerificationTable items={data?.items} isLoading={isLoading} />
      <Space h="md" />
      <Paginate
        hasPrevPage={Boolean(data?.meta?.hasPrevPage)}
        hasNextPage={Boolean(data?.meta?.hasNextPage)}
        onPrev={goPrev}
        onNext={() => goNext(data?.meta?.nextCursor)}
      />
    </>
  );
}
