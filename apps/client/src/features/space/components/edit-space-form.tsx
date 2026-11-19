import { Group, Box, Button, TextInput, Stack, Textarea } from "@mantine/core";
import React from "react";
import { useForm } from "@mantine/form";
import { zod4Resolver } from "mantine-form-zod-resolver";
import { z } from "zod/v4";
import { useUpdateSpaceMutation } from "@/features/space/queries/space-query.ts";
import { ISpace } from "@/features/space/types/space.types.ts";
import { useTranslation } from "react-i18next";
import { SpaceVisibilitySelect } from "@/features/space/components/visibility-select";
import { SpaceVisibility } from "@/features/space/types/space.types";

const formSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().max(500),
  visibility: z.enum(["open", "closed", "private"]),
  slug: z
    .string()
    .min(2)
    .max(100)
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
      "Space slug must start with a letter or number and may contain hyphens and underscores",
    ),
});

type FormValues = z.infer<typeof formSchema>;
interface EditSpaceFormProps {
  space: ISpace;
  readOnly?: boolean;
}
export function EditSpaceForm({ space, readOnly }: EditSpaceFormProps) {
  const { t } = useTranslation();
  const updateSpaceMutation = useUpdateSpaceMutation();

  const form = useForm<FormValues>({
    validate: zod4Resolver(formSchema),
    initialValues: {
      name: space?.name,
      description: space?.description || "",
      slug: space.slug,
      visibility: (space.visibility ?? "private") as SpaceVisibility,
    },
  });

  const handleSubmit = async (values: {
    name?: string;
    description?: string;
    slug?: string;
    visibility?: SpaceVisibility;
  }) => {
    const spaceData: Partial<ISpace> = {
      spaceId: space.id,
    };
    if (form.isDirty("name")) {
      spaceData.name = values.name;
    }
    if (form.isDirty("description")) {
      spaceData.description = values.description;
    }

    if (form.isDirty("visibility")) {
      spaceData.visibility = values.visibility;
    }

    if (form.isDirty("slug")) {
      spaceData.slug = values.slug;
    }

    await updateSpaceMutation.mutateAsync(spaceData);
    form.resetDirty();
  };

  return (
    <>
      <Box>
        <form onSubmit={form.onSubmit((values) => handleSubmit(values))}>
          <Stack>
            <TextInput
              id="name"
              label={t("Name")}
              placeholder={t("e.g Sales")}
              variant="filled"
              readOnly={readOnly}
              {...form.getInputProps("name")}
            />

            <TextInput
              id="slug"
              label={t("Slug")}
              variant="filled"
              readOnly={readOnly}
              {...form.getInputProps("slug")}
            />

            <SpaceVisibilitySelect
              value={form.values.visibility}
              onChange={(v) => form.setFieldValue("visibility", v)}
              readOnly={readOnly}
            />

            <Textarea
              id="description"
              label={t("Description")}
              placeholder={t("e.g Space for sales team to collaborate")}
              variant="filled"
              readOnly={readOnly}
              autosize
              minRows={1}
              maxRows={3}
              {...form.getInputProps("description")}
            />
          </Stack>

          {!readOnly && (
            <Group justify="flex-end" mt="md">
              <Button type="submit" disabled={!form.isDirty()}>
                {t("Save")}
              </Button>
            </Group>
          )}
        </form>
      </Box>
    </>
  );
}
