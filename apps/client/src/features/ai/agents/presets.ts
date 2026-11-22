import { AgentOutputKind, AgentSchedule } from "./types";

// Ready-made tasks to start from. The text is the task the model gets, in
// the reader's language (it goes through the translations).
export interface AgentPreset {
  id: string;
  name: string;
  description: string;
  instructions: string;
  schedule: Omit<AgentSchedule, "timezone">;
  output: AgentOutputKind;
}

export const AGENT_PRESETS: AgentPreset[] = [
  {
    id: "weekly-changes",
    name: "Weekly summary of changes",
    description: "Every Monday: what was created and edited during the week, by space.",
    instructions:
      "Summarize what changed in the wiki since last time. List the pages that were created and the ones that were edited, grouped by space, with a line on what each one is about and who changed it last. Read the most important pages before describing them. Close with three points worth the team's attention.",
    schedule: { kind: "weekly", hour: 8, minute: 0, weekdays: [1] },
    output: "page",
  },
  {
    id: "pages-to-verify",
    name: "Pages to verify",
    description: "Every Monday: pages whose verification ran out or runs out soon.",
    instructions:
      "List the pages whose verification has run out, and the ones that run out within the next 14 days, oldest first. For each one give the title, the space, when it ran out and who verified it last. Say which three look most urgent and why.",
    schedule: { kind: "weekly", hour: 9, minute: 0, weekdays: [1] },
    output: "notify",
  },
  {
    id: "daily-digest",
    name: "Daily digest",
    description: "Every morning: yesterday's changes in a few lines.",
    instructions:
      "Write a short digest of what changed in the wiki since last time: at most ten lines, the most important change first, each line with a link to its page. If nothing changed, say so in one line.",
    schedule: { kind: "daily", hour: 8, minute: 0 },
    output: "notify",
  },
];
