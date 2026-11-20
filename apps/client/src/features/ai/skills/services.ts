import { useQuery } from "@tanstack/react-query";
import api from "@/lib/api-client";

export interface ISkill {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  instructions: string;
  scope: "workspace" | "personal";
  creatorId: string | null;
  enabled: boolean;
  useCount: number;
  createdAt: string;
  updatedAt: string;
}

export const SKILLS_KEY = ["ai-skills"];

export async function listSkills(enabledOnly = false): Promise<{ items: ISkill[] }> {
  return (await api.post("/ai/skills", { enabledOnly })).data;
}
export async function createSkill(data: { name: string; description?: string; instructions: string; scope: "workspace" | "personal" }): Promise<ISkill> {
  return (await api.post("/ai/skills/create", data)).data;
}
export async function updateSkill(data: { skillId: string; name?: string; description?: string | null; instructions?: string; enabled?: boolean; scope?: "workspace" | "personal" }): Promise<ISkill> {
  return (await api.post("/ai/skills/update", data)).data;
}
export async function deleteSkill(skillId: string): Promise<void> {
  await api.post("/ai/skills/delete", { skillId });
}

// Every skill this person may run, for pickers.
export function useUsableSkillsQuery(enabled = true) {
  return useQuery({ queryKey: [...SKILLS_KEY, "usable"], queryFn: () => listSkills(true), enabled, staleTime: 60_000 });
}
