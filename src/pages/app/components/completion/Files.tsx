import { useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button, ScrollArea } from "@/components";
import { PaperclipIcon, XIcon, PlusIcon, TrashIcon, MusicIcon, DownloadIcon } from "lucide-react";
import { UseCompletionReturn } from "@/types";
import { MAX_FILES } from "@/config";

export const Files = ({
  attachedFiles,
  handleFileSelect,
  removeFile,
  onRemoveAllFiles,
  isLoading,
  isFilesPopoverOpen,
  setIsFilesPopoverOpen,
}: UseCompletionReturn) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleAddMoreClick = () => {
    fileInputRef.current?.click();
  };

  const handleSaveAudio = async (file: any) => {
    if (!file?.base64) {
      return;
    }

    try {
      await invoke("system_audio_save_ogg_base64", {
        base64Data: file.base64,
        suggestedFilename: file.name || `system_audio_${Date.now()}.ogg`,
      });
    } catch (error) {
      console.error("Failed to save audio file:", error);
    }
  };

  const canAddMore = attachedFiles.length < MAX_FILES;

  return (
    <div className="relative">
      <Popover open={isFilesPopoverOpen} onOpenChange={setIsFilesPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            size="icon"
            onClick={() => {
              if (attachedFiles.length === 0) {
                fileInputRef.current?.click();
              } else {
                setIsFilesPopoverOpen(true);
              }
            }}
            // 🔥 REMOVE or update !supportsImages if you want audio to work 
            // even if the provider says it doesn't support "images"
            disabled={isLoading} 
            className="cursor-pointer"
            title="Attach Files"
          >
            <PaperclipIcon className="h-4 w-4" />
          </Button>
        </PopoverTrigger>

        {attachedFiles.length > 0 && (
          <div className="absolute -top-2 -right-2 bg-primary-foreground text-primary rounded-full h-5 w-5 flex border border-primary items-center justify-center text-xs font-medium">
            {attachedFiles.length}
          </div>
        )}

        {attachedFiles.length > 0 && (
          <PopoverContent
            align="end"
            side="bottom"
            className="w-96 p-0 border shadow-lg overflow-hidden"
            sideOffset={8}
          >
            <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30">
              <h3 className="font-semibold text-sm select-none">
                Attached Files ({attachedFiles.length}/{MAX_FILES})
              </h3>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setIsFilesPopoverOpen(false)}
                className="cursor-pointer"
                title="Close"
              >
                <XIcon className="h-4 w-4" />
              </Button>
            </div>

            <ScrollArea className="p-4 h-[320px]">
              <div
                className={`gap-3 ${
                  attachedFiles.length <= 2
                    ? "flex flex-col"
                    : "grid grid-cols-2"
                }`}
              >
                {attachedFiles.map((file) => {
                  const isAudio = file.type.startsWith("audio/");
                  
                  return (
                    <div key={file.id} className="relative group border rounded-lg overflow-hidden bg-muted/20 aspect-square flex items-center justify-center">
                      {isAudio ? (
                        <div className="flex flex-col items-center gap-2 p-4 w-full">
                          <MusicIcon className="h-8 w-8 text-primary/60" />
                          <span className="text-[10px] text-center truncate w-full px-2 font-medium">
                            {file.name}
                          </span>
                        </div>
                      ) : (
                        <img
                          src={`data:${file.type};base64,${file.base64}`}
                          alt={file.name}
                          className="w-full object-cover h-full"
                        />
                      )}

                      <div className="absolute bottom-0 left-0 right-0 bg-black/70 text-white p-2 text-[10px]">
                        <div className="truncate font-medium">{file.name}</div>
                        <div className="text-gray-300">
                          {(file.size / 1024 / 1024).toFixed(2)} MB
                        </div>
                      </div>
                      
                      {isAudio && (
                        <Button
                          size="icon"
                          variant="secondary"
                          className="absolute top-2 left-2 h-6 w-6 cursor-pointer opacity-100"
                          onClick={() => handleSaveAudio(file)}
                          title="Save audio"
                        >
                          <DownloadIcon className="h-3 w-3" />
                        </Button>
                      )}

                      <Button
                        size="icon"
                        variant="destructive"
                        className="absolute top-2 right-2 h-6 w-6 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => removeFile(file.id)}
                      >
                        <XIcon className="h-3 w-3" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>

            <div className="sticky bottom-0 border-t bg-background p-3 flex flex-row gap-2">
              <Button
                onClick={handleAddMoreClick}
                disabled={!canAddMore || isLoading}
                className="w-2/4"
                variant="outline"
              >
                <PlusIcon className="h-4 w-4 mr-2" />
                Add More
              </Button>
              <Button
                className="w-2/4"
                variant="destructive"
                onClick={onRemoveAllFiles}
              >
                <TrashIcon className="h-4 w-4 mr-2" />
                Remove All
              </Button>
            </div>
          </PopoverContent>
        )}
      </Popover>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,audio/*"
        onChange={handleFileSelect}
        className="hidden"
      />
    </div>
  );
};