import {
  IconAlignJustified,
  IconArrowBackUp,
  IconArrowDownLeft,
  IconCheck,
  IconChevronLeft,
  IconCopy,
  IconHelp,
  IconLanguage,
  IconList,
  IconMoodSmile,
  IconRefresh,
  IconSparkles,
  IconTextPlus,
  IconTrash,
  IconWand,
  IconWriting,
} from "@tabler/icons-react";
import { AiAction } from "@/features/ai/types";

export type CommandSet = "main" | "tone" | "translate" | "result";

export interface AiCommand {
  id: string;
  name: string;
  icon: typeof IconSparkles;
  action?: AiAction;
  prompt?: string;
  opens?: CommandSet;
}

const back: AiCommand = { id: "back", name: "Back", icon: IconChevronLeft, opens: "main" };

const tones = ["Professional", "Casual", "Friendly", "Confident", "Direct"];
const languages = [
  "English",
  "Spanish",
  "French",
  "German",
  "Portuguese",
  "Italian",
  "Dutch",
  "Japanese",
  "Korean",
  "Chinese",
];

export const AI_COMMANDS: Record<CommandSet, AiCommand[]> = {
  main: [
    { id: "improve", name: "Improve writing", icon: IconSparkles, action: "improve_writing" },
    { id: "fix", name: "Fix spelling and grammar", icon: IconCheck, action: "fix_spelling_grammar" },
    { id: "shorter", name: "Make shorter", icon: IconAlignJustified, action: "make_shorter" },
    { id: "longer", name: "Make longer", icon: IconTextPlus, action: "make_longer" },
    { id: "simplify", name: "Simplify", icon: IconWand, action: "simplify" },
    { id: "continue", name: "Continue writing", icon: IconWriting, action: "continue_writing" },
    { id: "summarize", name: "Summarize", icon: IconList, action: "summarize" },
    { id: "explain", name: "Explain", icon: IconHelp, action: "explain" },
    { id: "tone", name: "Change tone", icon: IconMoodSmile, opens: "tone" },
    { id: "translate", name: "Translate", icon: IconLanguage, opens: "translate" },
  ],
  tone: [
    back,
    ...tones.map((tone) => ({
      id: `tone-${tone.toLowerCase()}`,
      name: tone,
      icon: IconMoodSmile,
      action: "change_tone" as AiAction,
      prompt: tone.toLowerCase(),
    })),
  ],
  translate: [
    back,
    ...languages.map((language) => ({
      id: `translate-${language.toLowerCase()}`,
      name: language,
      icon: IconLanguage,
      action: "translate" as AiAction,
      prompt: language,
    })),
  ],
  result: [
    { id: "replace", name: "Replace selection", icon: IconCheck },
    { id: "insert", name: "Insert below", icon: IconArrowDownLeft },
    { id: "copy", name: "Copy", icon: IconCopy },
    { id: "retry", name: "Try again", icon: IconRefresh },
    { id: "discard", name: "Discard", icon: IconTrash },
    { id: "back-to-commands", name: "Ask something else", icon: IconArrowBackUp, opens: "main" },
  ],
};
