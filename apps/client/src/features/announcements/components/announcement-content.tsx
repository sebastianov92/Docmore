import { Fragment, ReactNode } from "react";
import { AnnouncementContent as Content, AnnouncementText } from "../types";
import { isSafeAnnouncementHref } from "../utils";

// Renders the one-paragraph message: text runs with bold, italic,
// underline and links. Unsafe links are shown as plain text.
export function AnnouncementContent({ content }: { content: Content }) {
  const runs = content?.content?.flatMap((p) => p.content ?? []) ?? [];
  return (
    <span>
      {runs.map((run, index) => (
        <Fragment key={index}>{renderRun(run)}</Fragment>
      ))}
    </span>
  );
}

function renderRun(run: AnnouncementText): ReactNode {
  let node: ReactNode = run.text;
  for (const mark of run.marks ?? []) {
    if (mark.type === "bold") node = <strong>{node}</strong>;
    else if (mark.type === "italic") node = <em>{node}</em>;
    else if (mark.type === "underline") node = <u>{node}</u>;
    else if (mark.type === "link" && isSafeAnnouncementHref(mark.attrs?.href)) {
      const href = mark.attrs.href.trim();
      const external = /^https?:/i.test(href);
      node = (
        <a href={href} target={external ? "_blank" : undefined} rel={external ? "noopener noreferrer" : undefined}>
          {node}
        </a>
      );
    }
  }
  return node;
}
