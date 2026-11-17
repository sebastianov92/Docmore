import {
  InfiniteData,
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  UseQueryResult,
} from "@tanstack/react-query";
import { useAtom, useStore } from "jotai";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { IPagination } from "@/lib/types.ts";
import { IPage } from "@/features/page/types/page.types.ts";
import { invalidateOnCreatePage } from "@/features/page/queries/page-query.ts";
import { treeDataAtom } from "@/features/page/tree/atoms/tree-data-atom.ts";
import { treeModel } from "@/features/page/tree/model/tree-model";
import { spaceRoots, updateSpaceRoots } from "@/features/page/tree/utils/utils.ts";
import { SpaceTreeNode } from "@/features/page/tree/types.ts";
import { useQueryEmit } from "@/features/websocket/use-query-emit.ts";
import {
  createPageFromTemplate,
  createTemplate,
  deleteTemplate,
  getTemplateById,
  getTemplates,
  updateTemplate,
} from "@/features/template/services/template-service.ts";
import {
  ICreateTemplate,
  ITemplate,
  IUpdateTemplate,
  IUseTemplate,
} from "@/features/template/types/template.types.ts";

export const TEMPLATES_KEY = "templates";
export const TEMPLATE_KEY = "template";

type TemplatePages = InfiniteData<IPagination<ITemplate>>;

function apiMessage(error: unknown): string | undefined {
  return (error as any)?.response?.data?.message;
}

export function useTemplatesQuery(params?: {
  spaceId?: string;
  currentSpaceId?: string;
}) {
  const { spaceId, currentSpaceId } = params ?? {};
  return useInfiniteQuery({
    queryKey: [TEMPLATES_KEY, { spaceId, currentSpaceId }],
    queryFn: ({ pageParam }) =>
      getTemplates({ spaceId, currentSpaceId, cursor: pageParam, limit: 30 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.meta.hasNextPage ? lastPage.meta.nextCursor : undefined,
    placeholderData: keepPreviousData,
  });
}

export function useTemplateQuery(
  templateId: string | undefined,
): UseQueryResult<ITemplate, Error> {
  return useQuery({
    queryKey: [TEMPLATE_KEY, templateId],
    queryFn: () => getTemplateById(templateId as string),
    enabled: !!templateId,
  });
}

function patchLists(
  queryClient: ReturnType<typeof useQueryClient>,
  patch: (items: ITemplate[]) => ITemplate[],
) {
  queryClient.setQueriesData<TemplatePages>({ queryKey: [TEMPLATES_KEY] }, (old) => {
    if (!old) return old;
    return {
      ...old,
      pages: old.pages.map((page) => ({ ...page, items: patch(page.items) })),
    };
  });
}

export function useCreateTemplateMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation<ITemplate, Error, ICreateTemplate>({
    mutationFn: createTemplate,
    onSuccess: (created) => {
      queryClient.setQueryData([TEMPLATE_KEY, created.id], created);
      queryClient.invalidateQueries({ queryKey: [TEMPLATES_KEY] });
    },
    onError: (error) => {
      notifications.show({
        message: apiMessage(error) || t("Could not create the template"),
        color: "red",
      });
    },
  });
}

export function useUpdateTemplateMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation<ITemplate, Error, IUpdateTemplate>({
    mutationFn: updateTemplate,
    onSuccess: (updated) => {
      queryClient.setQueryData([TEMPLATE_KEY, updated.id], updated);
      patchLists(queryClient, (items) =>
        items.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)),
      );
    },
    onError: (error) => {
      notifications.show({
        message: apiMessage(error) || t("Could not save the template"),
        color: "red",
      });
    },
  });
}

export function useDeleteTemplateMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation<void, Error, string>({
    mutationFn: deleteTemplate,
    onSuccess: (_data, templateId) => {
      patchLists(queryClient, (items) => items.filter((item) => item.id !== templateId));
      queryClient.removeQueries({ queryKey: [TEMPLATE_KEY, templateId] });
      notifications.show({ message: t("Template deleted") });
    },
    onError: (error) => {
      notifications.show({
        message: apiMessage(error) || t("Could not delete the template"),
        color: "red",
      });
    },
  });
}

// Creates the page on the server, then shows it in the sidebar tree right away.
export function useCreatePageFromTemplateMutation() {
  const { t } = useTranslation();
  const [, setTreeData] = useAtom(treeDataAtom);
  const store = useStore();
  const emit = useQueryEmit();

  return useMutation<IPage, Error, IUseTemplate>({
    mutationFn: createPageFromTemplate,
    onSuccess: (page) => {
      invalidateOnCreatePage(page);

      // Only touch the tree when this space is loaded; other spaces refetch on their own.
      const roots = spaceRoots(store.get(treeDataAtom), page.spaceId);
      if (roots.length === 0) return;

      const parentId = page.parentPageId ?? null;
      const node: SpaceTreeNode = {
        id: page.id,
        slugId: page.slugId,
        name: page.title,
        icon: page.icon,
        position: page.position,
        spaceId: page.spaceId,
        parentPageId: page.parentPageId,
        hasChildren: false,
        children: [],
      };
      const index =
        parentId === null
          ? roots.length
          : (treeModel.find(roots, parentId)?.children?.length ?? 0);

      setTreeData((prev) =>
        updateSpaceRoots(prev, page.spaceId, (current) =>
          treeModel.insert(current, parentId, node, index),
        ),
      );

      setTimeout(() => {
        emit({
          operation: "addTreeNode",
          spaceId: page.spaceId,
          payload: { parentId, index, data: node },
        });
      }, 50);
    },
    onError: (error) => {
      notifications.show({
        message: apiMessage(error) || t("Could not create the page from the template"),
        color: "red",
      });
    },
  });
}
