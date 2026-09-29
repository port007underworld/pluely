import React from "react";
import { Streamdown, defaultRemarkPlugins } from "streamdown";
import "katex/dist/katex.min.css";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { PluggableList } from "unified";

// Override the built-in remark-math to enable single $ for inline math.
// Streamdown ships with singleDollarTextMath: false, but every LLM outputs $...$.
const customRemarkPlugins: PluggableList = Object.values({
  ...defaultRemarkPlugins,
  math: [
    (defaultRemarkPlugins as any).math[0],
    { singleDollarTextMath: true },
  ],
});

interface MarkdownRendererProps {
  children: string;
  isStreaming?: boolean;
}

export function Markdown({
  children,
  isStreaming = false,
}: MarkdownRendererProps) {
  // Wide content (long code lines, display math, tables) scrolls inside its own
  // box so it can't widen the answer and push wrapped text past the edge.
  return (
    <div className="min-w-0 max-w-full [overflow-wrap:anywhere] [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_.katex-display]:max-w-full [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex]:inline-block [&_.katex]:max-w-full [&_.katex]:overflow-x-auto [&_.katex]:overflow-y-hidden [&_.katex]:align-bottom [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto">
    <Streamdown
      isAnimating={isStreaming}
      shikiTheme={["github-light", "github-dark"]}
      remarkPlugins={customRemarkPlugins}
      components={COMPONENTS as any}
      controls={{
        table: true,
        code: true,
        mermaid: {
          download: true,
          copy: true,
          fullscreen: false,
          panZoom: false,
        },
      }}
    >
      {children}
    </Streamdown>
    </div>
  );
}

const COMPONENTS = {
  a: ({ children, href, ...props }: any) => {
    const handleClick = async (e: React.MouseEvent) => {
      e.preventDefault();
      if (href) {
        try {
          await openUrl(href);
        } catch (error) {
          console.error("Failed to open URL:", error);
        }
      }
    };

    return (
      <a
        href={href}
        className="text-gray-600 underline underline-offset-2 hover:text-gray-800 dark:text-gray-300 dark:hover:text-gray-100 cursor-pointer"
        onClick={handleClick}
        {...props}
      >
        {children}
      </a>
    );
  },
};
