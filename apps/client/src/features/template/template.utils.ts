import { Editor } from "@tiptap/core";
import { ITemplate } from "@/features/template/types/template.types.ts";

// Fills an empty page with the template. Returns false when the page already has content.
export function applyTemplateToPage(
  editor: Editor,
  titleEditor: Editor,
  template: ITemplate,
): boolean {
  if (!editor.isEmpty) return false;

  if (titleEditor.isEmpty && template.title) {
    titleEditor.commands.setContent(template.title, { emitUpdate: true });
  }
  if (template.content) {
    editor.commands.setContent(template.content);
  }
  return true;
}

export function templateTitle(template: Pick<ITemplate, "title">, fallback: string) {
  return template.title?.trim() || fallback;
}
