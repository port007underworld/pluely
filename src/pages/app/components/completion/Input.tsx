import { useEffect } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Loader2,
  MessageSquarePlusIcon,
  MessagesSquareIcon,
  XIcon,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Button,
  ScrollArea,
  Input as InputComponent,
  Markdown,
  CopyButton,
} from "@/components";
import { UseCompletionReturn } from "@/types";
import { QUICK_ACTIONS } from "@/config";
import { lastCodeBlock } from "@/lib";
import { useAnswerPager } from "./useAnswerPager";

const MOD = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+";

export const Input = ({
  isPopoverOpen,
  isLoading,
  reset,
  input,
  setInput,
  handleKeyPress,
  handlePaste,
  currentConversationId,
  conversationHistory,
  startNewConversation,
  error,
  audioNotice,
  idleResetNotice,
  contextInfo,
  response,
  cancel,
  scrollAreaRef,
  inputRef,
  isHidden,
  keepEngaged,
  setKeepEngaged,
  modelSpeed,
  setModelSpeed,
  hasSlowModel,
  actionNotice,
  runQuickAction,
  copyLastCode,
}: UseCompletionReturn & { isHidden: boolean }) => {
  const pager = useAnswerPager({
    history: conversationHistory,
    response,
    input,
    isLoading,
    conversationId: currentConversationId,
  });
  const { toLatest, previous, next } = pager;
  const shownAnswer = pager.older?.content ?? response;

  // Closing the panel returns to the latest answer.
  useEffect(() => {
    if (!isPopoverOpen) toLatest();
  }, [isPopoverOpen, toLatest]);

  // Cmd/Ctrl+[ and ] page through answers while the panel is open.
  useEffect(() => {
    if (!isPopoverOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.key === "[") {
        e.preventDefault();
        previous();
      } else if (e.key === "]") {
        e.preventDefault();
        next();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isPopoverOpen, previous, next]);

  return (
    <div className="relative flex-1">
      <Popover
        open={isPopoverOpen}
        onOpenChange={(open) => {
          if (!open && !isLoading && !keepEngaged) {
            reset();
          }
        }}
      >
        <PopoverTrigger asChild className="!border-none !bg-transparent">
          <div className="relative select-none">
            <InputComponent
              ref={inputRef}
              placeholder="Ask me anything..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyPress={handleKeyPress}
              onPaste={handlePaste}
              disabled={isLoading || isHidden}
              className={`${
                currentConversationId && conversationHistory.length > 0
                  ? "pr-12"
                  : "pr-2"
              }`}
            />

            {/* In a conversation: message count; click to see it (conversation mode) */}
            {currentConversationId &&
              conversationHistory.length > 0 &&
              !isLoading && (
                <button
                  type="button"
                  onClick={() => setKeepEngaged(true)}
                  title={`${conversationHistory.length} messages in this conversation. Click to view (${MOD}K)`}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-1 rounded-md border border-input/50 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted/50 cursor-pointer"
                >
                  <MessagesSquareIcon className="size-3.5" />
                  {conversationHistory.length}
                </button>
              )}

            {/* Loading indicator */}
            {isLoading && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2 animate-pulse">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            )}
          </div>
        </PopoverTrigger>

        {/* Response Panel */}
        <PopoverContent
          align="end"
          side="bottom"
          className="w-screen p-0 border shadow-lg overflow-hidden"
          sideOffset={8}
        >
          <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30">
            <div className="flex flex-row gap-1 items-center">
              <h3
                className="font-semibold text-xs select-none"
                title="Use the arrow keys to scroll"
              >
                {keepEngaged ? "Conversation" : "AI Response"}
              </h3>
              {contextInfo && contextInfo.totalMessages > 0 && (
                <div
                  className="text-[10px] text-muted-foreground/70"
                  title="Past messages sent with the last request. Adjust in Response Settings › Conversation Memory."
                >
                  · Context: {contextInfo.sentMessages}/{contextInfo.totalMessages} msgs, ~
                  {contextInfo.estimatedTokens >= 1000
                    ? `${(contextInfo.estimatedTokens / 1000).toFixed(1)}k`
                    : contextInfo.estimatedTokens}{" "}
                  tokens
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 select-none">
              {pager.total > 1 && !keepEngaged && (
                <div className="flex items-center gap-0.5 text-[11px] text-muted-foreground">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-6 cursor-pointer"
                    title={`Previous answer (${MOD}[)`}
                    disabled={pager.position === 0}
                    onClick={previous}
                  >
                    <ChevronLeftIcon className="size-3.5" />
                  </Button>
                  <span className="tabular-nums" title="Answers in this conversation">
                    {pager.position + 1}/{pager.total}
                  </span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-6 cursor-pointer"
                    title={`Next answer (${MOD}])`}
                    disabled={pager.newer === 0}
                    onClick={next}
                  >
                    <ChevronRightIcon className="size-3.5" />
                  </Button>
                </div>
              )}
              {/* Fast/Slow model toggle — only visible when slow model is configured */}
              {hasSlowModel && (
                <div className="flex flex-row items-center gap-1.5 mr-1">
                  <button
                    onClick={() => setModelSpeed("fast")}
                    className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                      modelSpeed === "fast"
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-muted/30 text-muted-foreground/60 border-input/50 hover:bg-muted/50"
                    }`}
                    title="Fast: lower latency, lower cost (provider dependent)"
                  >
                    Fast
                  </button>
                  <button
                    onClick={() => setModelSpeed("slow")}
                    className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                      modelSpeed === "slow"
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-muted/30 text-muted-foreground/60 border-input/50 hover:bg-muted/50"
                    }`}
                    title="Slow: higher quality, potentially slower and more expensive"
                  >
                    Slow
                  </button>
                </div>
              )}
              <Button
                size="icon"
                variant={keepEngaged ? "secondary" : "ghost"}
                className="cursor-pointer"
                title={
                  keepEngaged
                    ? `Show only the latest answer (${MOD}K)`
                    : `Show the whole conversation (${MOD}K)`
                }
                aria-pressed={keepEngaged}
                onClick={() => {
                  setKeepEngaged(!keepEngaged);
                  setTimeout(() => inputRef?.current?.focus(), 100);
                }}
              >
                <MessagesSquareIcon />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="cursor-pointer"
                title={`New chat (${MOD}⇧N)`}
                disabled={isLoading || conversationHistory.length === 0}
                onClick={() => {
                  startNewConversation();
                  setKeepEngaged(false);
                  setTimeout(() => inputRef?.current?.focus(), 100);
                }}
              >
                <MessageSquarePlusIcon />
              </Button>
              <CopyButton content={shownAnswer} />
              <Button
                size="icon"
                variant="ghost"
                onClick={() => {
                  if (isLoading) {
                    cancel();
                  } else {
                    setKeepEngaged(false);
                    reset(true);
                  }
                }}
                className="cursor-pointer"
                title={isLoading ? "Stop generating" : "Close"}
              >
                <XIcon />
              </Button>
            </div>
          </div>

          <ScrollArea ref={scrollAreaRef} className="h-[calc(100vh-7rem)]">
            <div className="p-4">
              {error && (
                <div className="mb-4 p-3 bg-destructive/10 border border-destructive/20 rounded text-sm text-destructive">
                  <strong>Error:</strong> {error}
                </div>
              )}
              {idleResetNotice && (
                <p className="mb-3 text-[11px] text-muted-foreground">{idleResetNotice}</p>
              )}
              {audioNotice && (
                <div className="mb-4 p-3 bg-amber-500/10 border border-amber-500/20 rounded text-xs text-amber-700 dark:text-amber-400">
                  <strong>Meeting audio:</strong> {audioNotice}
                </div>
              )}
              {pager.older && !keepEngaged ? (
                <>
                  <p className="mb-2 text-[11px] text-muted-foreground line-clamp-2 select-none">
                    {pager.older.question}
                  </p>
                  <Markdown>{pager.older.content}</Markdown>
                  <button
                    type="button"
                    onClick={toLatest}
                    className="mt-3 text-[11px] px-2 py-0.5 rounded-full border border-primary/50 text-primary hover:bg-primary/10 cursor-pointer select-none"
                  >
                    {isLoading ? "New answer being written" : "Back to latest answer"}
                    {pager.newer > 1 ? ` (${pager.newer} newer)` : ""} ›
                  </button>
                </>
              ) : (
                <>
              {pager.total > 1 && !keepEngaged && pager.question && (
                <p className="mb-2 text-[11px] text-muted-foreground line-clamp-2 select-none">
                  {pager.question}
                </p>
              )}
              {isLoading && (
                <div className="flex items-center gap-2 my-4 text-muted-foreground animate-pulse select-none">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-sm">Generating response...</span>
                </div>
              )}
              {response && <Markdown>{response}</Markdown>}
              {response && !isLoading && (
                <div className="flex flex-wrap items-center gap-1.5 pt-3 select-none">
                  {QUICK_ACTIONS.map((action, i) => (
                    <button
                      key={action.id}
                      type="button"
                      onClick={() => runQuickAction(action.id)}
                      title={`${action.prompt} (${MOD}${i + 1})`}
                      className="text-[11px] px-2 py-0.5 rounded-full border border-input/60 text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors cursor-pointer"
                    >
                      {action.label}
                    </button>
                  ))}
                  {lastCodeBlock(response) !== null && (
                    <button
                      type="button"
                      onClick={() => void copyLastCode()}
                      title="Copy the last code block (also a global shortcut; see Cursor & Shortcuts)"
                      className="text-[11px] px-2 py-0.5 rounded-full border border-input/60 text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors cursor-pointer"
                    >
                      Copy code
                    </button>
                  )}
                  {actionNotice && (
                    <span className="text-[11px] text-muted-foreground">{actionNotice}</span>
                  )}
                </div>
              )}
                </>
              )}

              {/* Conversation History - Separate scroll, no auto-scroll */}
              {keepEngaged && conversationHistory.length > 1 && (
                <div className="space-y-3 pt-3">
                  {[...conversationHistory]
                    .sort((a, b) => b?.timestamp - a?.timestamp)
                    .map((message, index) => {
                      if (!isLoading && index === 0) {
                        return null;
                      }
                      return (
                        <div
                          key={message.id}
                          className={`p-3 rounded-lg text-sm ${
                            message.role === "user"
                              ? "bg-primary/10 border-l-4 border-primary"
                              : "bg-muted/50"
                          }`}
                        >
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-xs font-medium text-muted-foreground uppercase">
                              {message.role === "user" ? "You" : "AI"}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {new Date(message.timestamp).toLocaleTimeString(
                                [],
                                {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                }
                              )}
                            </span>
                          </div>
                          <Markdown>{message.content}</Markdown>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          </ScrollArea>
        </PopoverContent>
      </Popover>
    </div>
  );
};
