import { useRef } from "react";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { IconEdit, IconFilePlus, IconFileText, IconSearch, IconSparkles } from "@tabler/icons-react";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import ChatInput, { ChatInputHandle } from "./chat-input";
import { ChatAttachment, PageMention, SendExtras } from "../types";
import classes from "./chat.module.css";

interface Props {
  isStreaming: boolean;
  onSend: (content: string, mentions: PageMention[], attachments: ChatAttachment[], extras?: SendExtras) => void;
  onStop: () => void;
}

// A fresh chat: the box in the middle and a few starters that fill it in.
export function ChatEmptyState({ isStreaming, onSend, onStop }: Props) {
  const { t } = useTranslation();
  const workspace = useAtomValue(workspaceAtom);
  const readOnly = workspace?.settings?.ai?.chatReadOnly === true;
  const inputRef = useRef<ChatInputHandle>(null);

  const starters = [
    { icon: IconSearch, label: t("Find pages about…"), prompt: "Find pages about ", write: false },
    { icon: IconFileText, label: t("Summarize a page"), prompt: "Summarize the page @", write: false },
    { icon: IconFilePlus, label: t("Create a page"), prompt: "Create a page titled ", write: true },
    { icon: IconEdit, label: t("Update a page"), prompt: "Update the page @", write: true },
  ].filter((s) => !readOnly || !s.write);

  return (
    <div className={classes.empty}>
      <IconSparkles size={44} stroke={1.5} className={classes.emptyIcon} />
      <h1 className={classes.emptyTitle}>{t("What can I help you with?")}</h1>
      <div className={classes.emptyInput}>
        <ChatInput ref={inputRef} isStreaming={isStreaming} onSend={onSend} onStop={onStop} autofocus />
        <div className={classes.disclaimer}>{t("Answers come from the pages you can read; check anything that matters.")}</div>
      </div>
      <div className={classes.suggestions}>
        {starters.map((s) => (
          <button key={s.label} type="button" className={classes.suggestion} onClick={() => inputRef.current?.prefill(s.prompt)}>
            <s.icon size={16} />
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
