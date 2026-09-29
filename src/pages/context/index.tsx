import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  FileTextIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  StickyNoteIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { Badge, Button, Input, Switch, Textarea } from "@/components";
import { PageLayout } from "@/layouts";
import {
  activeContextItems,
  PERSONAL_CONTEXT_MAX_CHARS,
  PersonalContextItem,
  usePersonalContext,
} from "@/lib";
import { cn } from "@/lib/utils";

const tokens = (chars: number) => {
  const t = Math.ceil(chars / 4);
  return t >= 1000 ? `~${(t / 1000).toFixed(1)}k tokens` : `~${t} tokens`;
};

const newId = () => `ctx_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const fileToBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

const MyContext = () => {
  const [context, save] = usePersonalContext();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const active = activeContextItems(context);

  const update = (items: PersonalContextItem[], enabled = context.enabled) => {
    try {
      setError(null);
      save({ enabled, items });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const patch = (id: string, changes: Partial<PersonalContextItem>) =>
    update(context.items.map((i) => (i.id === id ? { ...i, ...changes } : i)));

  const addNote = () => {
    const item: PersonalContextItem = {
      id: newId(),
      kind: "note",
      title: context.items.length === 0 ? "About me" : "Note",
      content: "",
      enabled: true,
      addedAt: Date.now(),
    };
    update([...context.items, item]);
    setEditingId(item.id);
  };

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    setError(null);
    const added: PersonalContextItem[] = [];
    for (const file of Array.from(files)) {
      try {
        const text = await invoke<string>("extract_document_text", {
          fileName: file.name,
          base64Data: await fileToBase64(file),
        });
        added.push({
          id: newId(),
          kind: "file",
          title: file.name.replace(/\.[^.]+$/, ""),
          content: text,
          enabled: true,
          addedAt: Date.now(),
        });
      } catch (e) {
        setError(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (added.length) {
      update([...context.items, ...added]);
      // Open the last one so the extracted text can be checked.
      setEditingId(added[added.length - 1].id);
    }
    setUploading(false);
    if (fileInput.current) fileInput.current.value = "";
  };

  return (
    <PageLayout
      title="My Context"
      description="Tell the AI about yourself: your resume, the job description, projects you want to highlight. It uses this only when it helps with a question, e.g. to answer “tell me about yourself” with your real experience."
    >
      <div className="flex items-center justify-between gap-4 p-4 border rounded-xl">
        <div>
          <p className="text-sm font-medium">Use my context in answers</p>
          <p className="text-xs text-muted-foreground mt-1">
            {context.enabled
              ? active.items.length > 0
                ? `${active.items.length} item${active.items.length === 1 ? "" : "s"} active · ${tokens(active.chars)} added to every request`
                : "Nothing active yet. Add a note or a file below."
              : "Off: none of this is sent."}
          </p>
          {active.truncated && (
            <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
              Over the limit ({tokens(PERSONAL_CONTEXT_MAX_CHARS)}): later items are cut off.
              Switch off what you don't need for this meeting.
            </p>
          )}
        </div>
        <Switch checked={context.enabled} onCheckedChange={(enabled) => update(context.items, enabled)} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={addNote}>
          <PlusIcon className="size-4" />
          Add note
        </Button>
        <Button variant="outline" onClick={() => fileInput.current?.click()} disabled={uploading}>
          {uploading ? <Loader2Icon className="size-4 animate-spin" /> : <UploadIcon className="size-4" />}
          Upload PDF, TXT or Markdown
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".pdf,.txt,.md,.markdown"
          multiple
          className="hidden"
          onChange={(e) => addFiles(e.target.files)}
        />
        <p className="text-xs text-muted-foreground">
          Files are read on this device; only the text is kept.
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {context.items.length === 0 ? (
        <div className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground space-y-2">
          <p className="font-medium text-foreground">Ideas for what to add</p>
          <ul className="list-disc pl-5 space-y-1 text-xs">
            <li>Your resume (upload the PDF).</li>
            <li>The job description for an upcoming interview.</li>
            <li>
              About me: your role, years of experience, main stack, and 2–3 projects you want to
              talk about with concrete numbers.
            </li>
            <li>For meetings: the project, your team, current priorities, terms people will use.</li>
          </ul>
          <p className="text-xs">
            Keep one item per topic and switch them on only when relevant: for example the job
            description of today's interview.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {context.items.map((item) => {
            const editing = editingId === item.id;
            const Icon = item.kind === "file" ? FileTextIcon : StickyNoteIcon;
            const inUse = context.enabled && item.enabled && item.content.trim().length > 0;
            return (
              <div
                key={item.id}
                className={cn(
                  "rounded-xl border p-3 space-y-2",
                  inUse ? "border-input" : "border-input/50 opacity-70"
                )}
              >
                <div className="flex items-center gap-3">
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  {editing ? (
                    <Input
                      value={item.title}
                      onChange={(e) => patch(item.id, { title: e.target.value })}
                      placeholder="Title, e.g. Resume or Job description – Acme"
                      className="h-8"
                    />
                  ) : (
                    <p className="text-sm font-medium flex-1 truncate">{item.title || "Untitled"}</p>
                  )}
                  <Badge variant="secondary" className="text-[10px] shrink-0">
                    {tokens(item.content.length)}
                  </Badge>
                  <Switch
                    checked={item.enabled}
                    onCheckedChange={(enabled) => patch(item.id, { enabled })}
                    title={item.enabled ? "Included" : "Not included"}
                  />
                  <Button
                    size="icon"
                    variant={editing ? "secondary" : "ghost"}
                    title={editing ? "Done" : "Edit"}
                    onClick={() => setEditingId(editing ? null : item.id)}
                  >
                    <PencilIcon className="size-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    title="Delete"
                    onClick={() => {
                      update(context.items.filter((i) => i.id !== item.id));
                      if (editing) setEditingId(null);
                    }}
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
                {editing ? (
                  <>
                    <Textarea
                      value={item.content}
                      onChange={(e) => patch(item.id, { content: e.target.value })}
                      placeholder="Write anything the AI should know…"
                      className="min-h-56 text-sm"
                      autoFocus={item.kind === "note" && !item.content}
                    />
                    {item.kind === "file" && (
                      <p className="text-[11px] text-muted-foreground">
                        Extracted text. Fix anything the PDF conversion got wrong; this is exactly
                        what the AI sees.
                      </p>
                    )}
                  </>
                ) : (
                  item.content && (
                    <p className="text-xs text-muted-foreground line-clamp-2 whitespace-pre-line">
                      {item.content}
                    </p>
                  )
                )}
              </div>
            );
          })}
        </div>
      )}
    </PageLayout>
  );
};

export default MyContext;
