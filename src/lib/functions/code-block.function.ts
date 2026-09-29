/** The last fenced code block in a Markdown answer, without the fences. */
export function lastCodeBlock(markdown: string): string | null {
  const blocks = [...markdown.matchAll(/```[^\n`]*\n([\s\S]*?)```/g)];
  const last = blocks[blocks.length - 1]?.[1];
  return last === undefined ? null : last.replace(/\n$/, "");
}
