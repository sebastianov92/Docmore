import { atom, useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { Kbd, Modal, Stack, Table, Text } from "@mantine/core";
import { useHotkeys, useOs } from "@mantine/hooks";

export const keyboardShortcutsOpenAtom = atom(false);

// What the keyboard does here; opens with Cmd/Ctrl + / from anywhere.
export function KeyboardShortcutsModal() {
  const { t } = useTranslation();
  const [open, setOpen] = useAtom(keyboardShortcutsOpenAtom);
  const os = useOs();
  const mod = os === "macos" ? "⌘" : "Ctrl";
  useHotkeys([["mod+/", () => setOpen((o) => !o)]]);
  const rows: [string, string[]][] = [
    [t("Search"), [mod, "K"]],
    [t("Find in page"), [mod, "F"]],
    [t("Keyboard shortcuts"), [mod, "/"]],
    [t("Block menu in the editor"), ["/"]],
    [t("Mention a page or person"), ["@"]],
    [t("Skill picker in the chat"), ["/"]],
    [t("Send a chat message"), ["Enter"]],
    [t("New line in the chat"), ["Shift", "Enter"]],
    [t("Bold / italic / underline"), [mod, "B · I · U"]],
    [t("Close dialogs"), ["Esc"]],
  ];
  return (
    <Modal opened={open} onClose={() => setOpen(false)} title={t("Keyboard shortcuts")} size="sm">
      <Stack gap="xs">
        <Table fz="sm" verticalSpacing={4}>
          <Table.Tbody>
            {rows.map(([label, keys]) => (
              <Table.Tr key={label}>
                <Table.Td>{label}</Table.Td>
                <Table.Td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  {keys.map((k, i) => (
                    <Kbd key={i} size="xs" ml={i ? 4 : 0}>
                      {k}
                    </Kbd>
                  ))}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Text size="xs" c="dimmed">
          {t("The desktop app adds Home, AI chat and Settings under the File menu.")}
        </Text>
      </Stack>
    </Modal>
  );
}
