import { useMemo } from "react";
import { Group, Loader, Paper, Stack, Text, Typography } from "@mantine/core";
import { Spotlight } from "@mantine/spotlight";
import { IconFileText, IconSparkles } from "@tabler/icons-react";
import { Link } from "react-router-dom";
import DOMPurify from "dompurify";
import { useTranslation } from "react-i18next";
import { markdownToHtml } from "@docmost/editor-ext";
import { buildPageUrl } from "@/features/page/page.utils";
import { AiAnswerSource } from "@/features/ai/types";
import classes from "./ai-answer.module.css";

interface Props {
  answer: string;
  sources: AiAnswerSource[];
  loading: boolean;
  error: string | null;
}

const makeActionTabbable = (el: HTMLElement | null) => {
  if (el) el.tabIndex = 0;
};

// The answer card and the pages it came from, inside the search dialog.
export function AiAnswer({ answer, sources, loading, error }: Props) {
  const { t } = useTranslation();

  // One row per page, the closest chunk wins.
  const pages = useMemo(() => {
    const byPage = new Map<string, AiAnswerSource>();
    for (const source of sources) {
      const seen = byPage.get(source.pageId);
      if (!seen || source.similarity > seen.similarity) byPage.set(source.pageId, source);
    }
    return Array.from(byPage.values());
  }, [sources]);

  const html = useMemo(
    () => (answer ? DOMPurify.sanitize(markdownToHtml(answer) as string) : ""),
    [answer],
  );

  if (error) {
    return (
      <Paper p="md" radius="md" withBorder m="sm">
        <Text size="sm" c="red">
          {error}
        </Text>
      </Paper>
    );
  }

  if (loading && !answer && pages.length === 0) {
    return (
      <Paper p="md" radius="md" withBorder m="sm">
        <Group gap="sm">
          <Loader size="sm" />
          <Text size="sm">{t("Looking through your pages…")}</Text>
        </Group>
      </Paper>
    );
  }

  return (
    <Stack gap="sm" p="sm">
      <Paper p="md" radius="md" withBorder>
        <Group gap="xs" mb="xs">
          <IconSparkles size={18} className={classes.sparkle} />
          <Text fw={600} size="sm">
            {t("AI answer")}
          </Text>
          {loading && <Loader size="xs" />}
        </Group>
        {html ? (
          <Typography className={classes.answer}>
            <div dangerouslySetInnerHTML={{ __html: html }} />
          </Typography>
        ) : (
          <Text size="sm" c="dimmed">
            {t("Writing the answer…")}
          </Text>
        )}
      </Paper>

      {pages.length > 0 && (
        <div>
          <Text size="xs" fw={600} c="dimmed" px="xs" pb={4}>
            {t("Sources")}
          </Text>
          {pages.map((source) => (
            <Spotlight.Action
              key={source.pageId}
              component={Link}
              ref={makeActionTabbable}
              //@ts-ignore
              to={buildPageUrl(source.spaceSlug, source.slugId, source.title)}
              className={classes.source}
            >
              <Group wrap="nowrap" gap="sm" w="100%">
                <IconFileText size={18} stroke={1.5} className={classes.sourceIcon} />
                <div className={classes.sourceText}>
                  {/* lineClamp wraps, truncate would widen the dialog to the text */}
                  <Text size="sm" fw={500} lineClamp={1}>
                    {source.title}
                  </Text>
                  <Text size="xs" c="dimmed" lineClamp={1}>
                    {source.spaceName}
                    {source.excerpt ? ` · ${source.excerpt}` : ""}
                  </Text>
                </div>
              </Group>
            </Spotlight.Action>
          ))}
        </div>
      )}
    </Stack>
  );
}
