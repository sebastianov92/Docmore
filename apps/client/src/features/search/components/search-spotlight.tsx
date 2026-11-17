import { Spotlight } from "@mantine/spotlight";
import { IconSearch, IconSparkles } from "@tabler/icons-react";
import { Group, Button, VisuallyHidden, Text } from "@mantine/core";
import React, { useState, useMemo, useEffect, useCallback } from "react";
import { useDebouncedValue } from "@mantine/hooks";
import { useTranslation } from "react-i18next";
import { notifications } from "@mantine/notifications";
import { searchSpotlightStore } from "../constants.ts";
import { SearchSpotlightFilters } from "./search-spotlight-filters.tsx";
import { useUnifiedSearch } from "../hooks/use-unified-search.ts";
import { SearchResultItem } from "./search-result-item.tsx";
import { useHasFeature } from "@/ee/hooks/use-feature";
import { Feature } from "@/ee/features";
import { useAiAnswers } from "@/features/ai/search/use-ai-answers";
import { AiAnswer } from "@/features/ai/search/ai-answer";

interface SearchSpotlightProps {
  spaceId?: string;
}
export function SearchSpotlight({ spaceId }: SearchSpotlightProps) {
  const { t } = useTranslation();
  const hasAiFeature = useHasFeature(Feature.AI);
  const hasAttachmentIndexing = useHasFeature(Feature.ATTACHMENT_INDEXING);
  const [query, setQuery] = useState("");
  const [debouncedSearchQuery] = useDebouncedValue(query, 300);
  const [filters, setFilters] = useState<{
    spaceId?: string | null;
    spaceArchived?: boolean;
    contentType?: string;
    creatorId?: string | null;
    labelIds?: string[];
    titleOnly?: boolean;
    includeArchived?: boolean;
  }>({
    contentType: "page",
  });
  const [isAiMode, setIsAiMode] = useState(false);
  const isArchivedSpaceSelected = !!filters.spaceArchived;
  const archivedAiNote = t("AI answers don't cover archived spaces.");

  // Build unified search params
  const searchParams = useMemo(() => {
    const params: any = {
      query: debouncedSearchQuery,
      contentType: filters.contentType || "page", // Only used for frontend routing
    };

    // Handle space filtering - only pass spaceId if a specific space is selected
    if (filters.spaceId) {
      params.spaceId = filters.spaceId;
    }

    if (filters.creatorId) {
      params.creatorId = filters.creatorId;
    }

    if (filters.labelIds?.length) {
      params.labelIds = filters.labelIds;
    }

    if (filters.titleOnly) {
      params.titleOnly = true;
    }

    if (filters.includeArchived) {
      params.includeArchived = true;
    }

    return params;
  }, [debouncedSearchQuery, filters]);

  const {
    data: searchResults,
    isFetching,
  } = useUnifiedSearch(
    searchParams,
    !isAiMode // Disable regular search when in AI mode
  );
  const ai = useAiAnswers();
  const resetAi = ai.reset;

  // A new question clears the previous answer.
  useEffect(() => {
    resetAi();
  }, [query, resetAi]);

  useEffect(() => {
    if (ai.error) {
      notifications.show({
        message: ai.error || t("AI search failed. Please try again."),
        color: "red",
        position: "top-center",
      });
    }
  }, [ai.error, t]);

  const isFilterBrowse =
    (filters.labelIds?.length ?? 0) > 0 || !!filters.creatorId;
  // while the debounce is pending the empty list is not a settled "no results"
  const isQuerySettled = query === debouncedSearchQuery;

  // Determine result type for rendering
  const isAttachmentSearch =
    filters.contentType === "attachment" && hasAttachmentIndexing;

  const resultItems = (searchResults || []).map((result) => (
    <SearchResultItem
      key={result.id}
      result={result}
      isAttachmentResult={isAttachmentSearch}
      showSpace={!filters.spaceId}
    />
  ));

  const handleFiltersChange = useCallback((newFilters: any) => {
    setFilters(newFilters);
  }, [setFilters]);

  const handleAskClick = () => {
    setIsAiMode(!isAiMode);
  };

  const handleAiSearchTrigger = () => {
    const question = query.trim();
    if (question && isAiMode && !isArchivedSpaceSelected) {
      ai.ask({
        query: question,
        spaceId: filters.spaceId || undefined,
        includeArchived: filters.includeArchived || undefined,
      });
    }
  };

  return (
    <>
      <Spotlight.Root
        size="xl"
        maxHeight={600}
        store={searchSpotlightStore}
        query={query}
        onQueryChange={setQuery}
        scrollable
        overlayProps={{
          backgroundOpacity: 0.55,
        }}
      >
        <Group gap="xs" px="sm" pt="sm" pb="xs">
          <Spotlight.Search
            placeholder={isAiMode ? t("Ask a question...") : t("Search...")}
            aria-label={isAiMode ? t("Ask a question...") : t("Search")}
            leftSection={<IconSearch size={20} stroke={1.5} />}
            style={{ flex: 1 }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && isAiMode && query.trim() && !ai.loading) {
                e.preventDefault();
                handleAiSearchTrigger();
              }
            }}
          />
          {isAiMode && hasAiFeature && (
            <Button
              size="xs"
              leftSection={<IconSparkles size={16} />}
              onClick={handleAiSearchTrigger}
              disabled={!query.trim() || isArchivedSpaceSelected}
              loading={ai.loading}
            >
              {t("Ask")}
            </Button>
          )}
        </Group>

        <div
          style={{
            padding: "4px 16px",
          }}
        >
          <SearchSpotlightFilters
            onFiltersChange={handleFiltersChange}
            onAskClick={handleAskClick}
            spaceId={spaceId}
            isAiMode={isAiMode}
          />
        </div>

        <VisuallyHidden role="status" aria-live="polite">
          {isAiMode
            ? isArchivedSpaceSelected
              ? archivedAiNote
              : ai.asked && !ai.loading
                ? ai.answer
                  ? t("Answer ready")
                  : t("No answer available")
                : ""
            : (query.length > 0 || isFilterBrowse) && !isFetching
              ? resultItems.length === 0
                ? t("No results found")
                : t("{{count}} results found", { count: resultItems.length })
              : ""}
        </VisuallyHidden>

        <Spotlight.ActionsList>
          {isAiMode && isArchivedSpaceSelected ? (
            <Spotlight.Empty>
              <Text size="sm" c="dimmed">
                {archivedAiNote}
              </Text>
            </Spotlight.Empty>
          ) : isAiMode ? (
            <>
              {query.length === 0 && (
                <Spotlight.Empty>{t("Ask a question...")}</Spotlight.Empty>
              )}
              {query.length > 0 && !ai.asked && (
                <Spotlight.Empty>
                  <Text size="sm" c="dimmed">
                    {t("Press Enter or Ask to get an answer from your pages.")}
                  </Text>
                </Spotlight.Empty>
              )}
              {query.length > 0 && ai.asked && (
                <AiAnswer
                  answer={ai.answer}
                  sources={ai.sources}
                  loading={ai.loading}
                  error={ai.error}
                />
              )}
            </>
          ) : (
            <>
              {query.length === 0 && !isFilterBrowse && resultItems.length === 0 && (
                <Spotlight.Empty>{t("Start typing to search...")}</Spotlight.Empty>
              )}

              {(query.length > 0 || isFilterBrowse) &&
                !isFetching &&
                isQuerySettled &&
                resultItems.length === 0 && (
                  <Spotlight.Empty>{t("No results found...")}</Spotlight.Empty>
                )}

              {resultItems.length > 0 && <>{resultItems}</>}

              {(query.length > 0 || isFilterBrowse) &&
                isFetching &&
                resultItems.length === 0 && (
                <Spotlight.Empty>
                  <Text size="sm" style={{ marginTop: 10 }}>
                    {t("Searching...")}
                  </Text>
                </Spotlight.Empty>
              )}
            </>
          )}
        </Spotlight.ActionsList>
      </Spotlight.Root>
    </>
  );
}
