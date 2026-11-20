import { useCallback } from "react";
import { useAtom } from "jotai";
import { userAtom } from "@/features/user/atoms/current-user-atom";
import { updateUser } from "@/features/user/services/user-service";
import { IShortcut } from "@/features/user/types/user.types";

// The person's sidebar shortcuts, kept in their preferences.
export function useShortcuts() {
  const [user, setUser] = useAtom(userAtom);
  const shortcuts: IShortcut[] = user?.settings?.preferences?.shortcuts ?? [];
  const save = useCallback(
    async (next: IShortcut[]) => {
      const updated = await updateUser({ shortcuts: next } as any);
      setUser(updated);
    },
    [setUser],
  );
  const add = useCallback((s: IShortcut) => save([...shortcuts.filter((x) => x.url !== s.url), s]), [shortcuts, save]);
  const remove = useCallback((url: string) => save(shortcuts.filter((x) => x.url !== url)), [shortcuts, save]);
  const has = useCallback((url: string) => shortcuts.some((x) => x.url === url), [shortcuts]);
  return { shortcuts, add, remove, has, save };
}
