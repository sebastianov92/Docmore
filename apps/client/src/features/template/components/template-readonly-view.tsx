import "@/features/editor/styles/index.css";
import { useMemo } from "react";
import { Title } from "@mantine/core";
import { EditorProvider } from "@tiptap/react";
import { UniqueID } from "@docmost/editor-ext";
import { useTranslation } from "react-i18next";
import { mainExtensions } from "@/features/editor/extensions/extensions";
import { ITemplate } from "@/features/template/types/template.types.ts";
import { templateTitle } from "@/features/template/template.utils.ts";
import { TemplateMeta } from "./template-meta.tsx";

// Renders a template exactly like a page, without letting anyone type in it.
export function TemplateReadonlyView({ template }: { template: ITemplate }) {
  const { t } = useTranslation();

  const extensions = useMemo(
    () => [
      ...mainExtensions.filter((extension) => extension.name !== "uniqueID"),
      UniqueID.configure({ types: ["heading", "paragraph"], updateDocument: false }),
    ],
    [],
  );

  return (
    <>
      <div style={{ padding: "0 3rem" }}>
        <Title order={1} size="2.5rem" lh={1.2}>
          {templateTitle(template, t("Untitled"))}
        </Title>
        <TemplateMeta template={template} />
      </div>

      <EditorProvider
        editable={false}
        immediatelyRender={true}
        textDirection="auto"
        extensions={extensions}
        content={template.content ?? ""}
      />
    </>
  );
}
