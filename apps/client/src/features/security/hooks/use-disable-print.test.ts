import { renderHook } from "@testing-library/react";
import { createElement, ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifications } from "@mantine/notifications";
import { useDisablePrint, usePrintBlockReason } from "./use-disable-print";

const platform = vi.hoisted(() => ({ apple: false }));

vi.mock("@/lib/utils.tsx", () => ({
  platformModifierKey: (event: KeyboardEvent) =>
    platform.apple ? event.metaKey : event.ctrlKey,
}));

vi.mock("@mantine/notifications", () => ({
  notifications: { show: vi.fn() },
}));

function routerAt(path: string) {
  return ({ children }: { children: ReactNode }) =>
    createElement(MemoryRouter, { initialEntries: [path] }, children);
}

const onAppPage = { wrapper: routerAt("/s/docs/p/intro-abc123") };

function press(init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  document.dispatchEvent(event);
  return event.defaultPrevented;
}

const ctrlP = { key: "p", code: "KeyP", ctrlKey: true };

beforeEach(() => {
  platform.apple = false;
  vi.mocked(notifications.show).mockClear();
});

afterEach(() => {
  delete document.body.dataset.exportDisabled;
});

describe("useDisablePrint", () => {
  it("flags the body and blocks the shortcut only while mounted", () => {
    const { unmount } = renderHook(() => useDisablePrint("No export"), onAppPage);

    expect(document.body.dataset.exportDisabled).toBe("No export");
    expect(press(ctrlP)).toBe(true);

    unmount();
    expect(document.body.dataset.exportDisabled).toBeUndefined();
    expect(press(ctrlP)).toBe(false);
  });

  it("stays blocked until every holder has unmounted", () => {
    const page = renderHook(() => useDisablePrint("Page"), onAppPage);
    const embed = renderHook(() => useDisablePrint("Embed"), onAppPage);

    page.unmount();
    expect(document.body.dataset.exportDisabled).toBe("Embed");

    embed.unmount();
    expect(document.body.dataset.exportDisabled).toBeUndefined();
  });

  it("uses the platform modifier", () => {
    platform.apple = true;
    renderHook(() => useDisablePrint("Blocked"), onAppPage);

    expect(press({ key: "p", code: "KeyP", metaKey: true })).toBe(true);
    expect(press(ctrlP)).toBe(false);
  });

  it("ignores Shift or Alt variants and other letters", () => {
    renderHook(() => useDisablePrint("Blocked"), onAppPage);

    expect(press({ ...ctrlP, key: "P", shiftKey: true })).toBe(false);
    expect(press({ ...ctrlP, altKey: true })).toBe(false);
    expect(press({ key: "s", code: "KeyS", ctrlKey: true })).toBe(false);
  });

  it("falls back to the physical key on non-Latin layouts only", () => {
    renderHook(() => useDisablePrint("Blocked"), onAppPage);

    expect(press({ key: "з", code: "KeyP", ctrlKey: true })).toBe(true);
    // Dvorak puts "l" on the QWERTY P key: that is not a print request.
    expect(press({ key: "l", code: "KeyP", ctrlKey: true })).toBe(false);
  });

  it("survives keydown events without a key", () => {
    renderHook(() => useDisablePrint("Blocked"), onAppPage);

    expect(() => document.dispatchEvent(new Event("keydown"))).not.toThrow();
  });

  it("tells the user once per press, not on key repeat", () => {
    renderHook(() => useDisablePrint("Blocked"), onAppPage);

    press(ctrlP);
    press({ ...ctrlP, repeat: true });

    expect(notifications.show).toHaveBeenCalledTimes(1);
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Blocked" }),
    );
  });

  it("does nothing without a reason", () => {
    renderHook(() => useDisablePrint(null), onAppPage);

    expect(document.body.dataset.exportDisabled).toBeUndefined();
    expect(press(ctrlP)).toBe(false);
  });

  it("never blocks public share or docs views", () => {
    renderHook(() => useDisablePrint("Blocked"), {
      wrapper: routerAt("/share/abc/p/page-1"),
    });
    renderHook(() => useDisablePrint("Blocked"), {
      wrapper: routerAt("/docs/handbook/page-1"),
    });

    expect(document.body.dataset.exportDisabled).toBeUndefined();
  });
});

describe("usePrintBlockReason", () => {
  it("follows the active block", () => {
    const reason = renderHook(() => usePrintBlockReason(), onAppPage);
    expect(reason.result.current).toBeNull();

    const block = renderHook(() => useDisablePrint("Blocked"), onAppPage);
    expect(reason.result.current).toBe("Blocked");

    block.unmount();
    expect(reason.result.current).toBeNull();
  });
});
