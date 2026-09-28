import {
  Settings,
  MessagesSquare,
  WandSparkles,
  SquareSlashIcon,
  MonitorIcon,
  HomeIcon,
  PowerIcon,
  MessageSquareTextIcon,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useApp } from "@/contexts";

export const useMenuItems = () => {
  const { hasActiveLicense } = useApp();

  const menu: {
    icon: React.ElementType;
    label: string;
    href: string;
    count?: number;
  }[] = [
    {
      icon: HomeIcon,
      label: "Dashboard",
      href: "/dev-space",
    },
    {
      icon: MessagesSquare,
      label: "Chats",
      href: "/chats",
    },
    {
      icon: WandSparkles,
      label: "System prompts",
      href: "/system-prompts",
    },
    {
      icon: Settings,
      label: "App Settings",
      href: "/settings",
    },
    {
      icon: MessageSquareTextIcon,
      label: "Responses",
      href: "/responses",
    },
    {
      icon: MonitorIcon,
      label: "Screenshot & Audio",
      href: "/screenshot",
    },
    {
      icon: SquareSlashIcon,
      label: "Cursor & Shortcuts",
      href: "/shortcuts",
    },

  ];

  const footerItems = [
    ...(hasActiveLicense
      ? [

        ]
      : []),

    {
      icon: PowerIcon,
      label: "Quit runningbord",
      action: async () => {
        await invoke("exit_app");
      },
    },
  ];

  const footerLinks: {
    title: string;
    icon: React.ElementType;
    link: string;
  }[] = [

  ];

  return {
    menu,
    footerItems,
    footerLinks,
  };
};
