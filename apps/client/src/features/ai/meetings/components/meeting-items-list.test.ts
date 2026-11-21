import { describe, expect, it } from "vitest";
import { previousVersion } from "./meeting-items-list";
import { IMeetingItem } from "../services";

function item(patch: Partial<IMeetingItem>): IMeetingItem {
  return { id: "i1", kind: "agreement", text: "Entregar el lunes", owner: null, due: "lunes", status: "active", locked: false, at: 70, updatedBy: "ai", history: [], ...patch };
}

describe("previousVersion", () => {
  it("is empty for an entry that never changed", () => {
    expect(previousVersion(item({}))).toBeNull();
  });

  it("says what the entry said before, with who and when", () => {
    const changed = item({ history: [{ text: "Entregar el viernes", owner: "Ana", due: "viernes", status: "active", at: 10, by: "ai" }] });
    expect(previousVersion(changed)).toBe("Entregar el viernes — Ana · viernes");
  });

  it("tells the first wording when the person refined it after the meeting changed it", () => {
    const refined = item({
      due: "lunes 9:00",
      updatedBy: "user",
      locked: true,
      history: [
        { text: "Entregar el viernes", owner: null, due: null, status: "active", at: 5, by: "ai" },
        { text: "Entregar el lunes", owner: null, due: "lunes", status: "active", at: 60, by: "ai" },
      ],
    });
    expect(previousVersion(refined)).toBe("Entregar el viernes");
  });

  it("is empty when only the person reworded the entry", () => {
    const reworded = item({ text: "Entrega final", updatedBy: "user", locked: true, history: [{ text: "Entregar el lunes", owner: null, due: "lunes", status: "active", at: 5, by: "ai" }] });
    expect(previousVersion(reworded)).toBeNull();
  });
});
