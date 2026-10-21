import { Typography } from "@mantine/core";
import { memo } from "react";

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Chessin: raw HTML is no longer rendered (rehype-raw removed, see docs/seams.md),
// so the Tiptap `++underline++` markers are stripped instead of being turned into
// `<u>` tags. Underline styling comes back once rehype-sanitize (with `u` allowed)
// is added.
function normalizeTiptapMarkdown(comment: string) {
  return comment.replace(/\+\+([\s\S]+?)\+\+/g, "$1");
}

function Comment({ comment }: { comment: string }) {
  const normalizedComment = normalizeTiptapMarkdown(comment);
  const multipleLine = normalizedComment.split("\n").filter((v) => v.trim() !== "").length > 1;

  return (
    <Typography
      pl={0}
      mx={4}
      style={{
        display: multipleLine ? "block" : "inline",
      }}
    >
      <Markdown
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
          p: ({ node: _node, ...props }) => (multipleLine ? <p {...props} /> : <span {...props} />),
        }}
        rehypePlugins={[remarkGfm]}
      >
        {normalizedComment}
      </Markdown>
    </Typography>
  );
}

export default memo(Comment);
