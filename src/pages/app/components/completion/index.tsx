import { useCompletion } from "@/hooks";
import { Screenshot } from "./Screenshot";
import { MeetingModeToggle } from "./MeetingModeToggle";
import { AutoAnswerToggle } from "./AutoAnswerToggle";
import { Files } from "./Files";
import { Input } from "./Input";

export const Completion = ({ isHidden }: { isHidden: boolean }) => {
  const completion = useCompletion();

  return (
    <>
      <Input {...completion} isHidden={isHidden} />
      <Screenshot {...completion} />
      <MeetingModeToggle />
      <AutoAnswerToggle />
      <Files {...completion} />
    </>
  );
};
