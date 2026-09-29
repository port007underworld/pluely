export interface ResponseLengthOption {
  id: "short" | "medium" | "auto";
  title: string;
  description: string;
  prompt: string;
}

export interface LanguageOption {
  id: string;
  name: string;
  flag: string;
  prompt: string;
}

export const RESPONSE_LENGTHS: ResponseLengthOption[] = [
  {
    id: "short",
    title: "Short",
    description:
      "Minimal explanation. Code and commands are still complete.",
    prompt:
      "Response length: short. Keep the explanation to 2-4 sentences with only the essential information: no preamble, recap, background or alternatives unless asked. This limit applies to prose only: code, commands and complexity are not limited and must always be complete and runnable.",
  },
  {
    id: "medium",
    title: "Medium",
    description: "A short explanation of the key points. Code is always complete.",
    prompt:
      "Response length: medium. Keep the explanation to about 1-2 short paragraphs (4-8 sentences) covering the key reasoning and relevant details, without padding or repetition. This limit applies to prose only: code, commands and complexity are not limited and must always be complete and runnable.",
  },
  {
    id: "auto",
    title: "Auto",
    description:
      "The AI picks the length for each question. Recommended with the built-in presets.",
    prompt: "",
  },
];

export const LANGUAGES: LanguageOption[] = [
  {
    id: "english",
    name: "English",
    flag: "🇺🇸",
    prompt: "Respond in English.",
  },
  {
    id: "spanish",
    name: "Spanish",
    flag: "🇪🇸",
    prompt: "Respond in Spanish (Español).",
  },
  {
    id: "french",
    name: "French",
    flag: "🇫🇷",
    prompt: "Respond in French (Français).",
  },
  {
    id: "german",
    name: "German",
    flag: "🇩🇪",
    prompt: "Respond in German (Deutsch).",
  },
  {
    id: "italian",
    name: "Italian",
    flag: "🇮🇹",
    prompt: "Respond in Italian (Italiano).",
  },
  {
    id: "portuguese",
    name: "Portuguese",
    flag: "🇵🇹",
    prompt: "Respond in Portuguese (Português).",
  },
  {
    id: "dutch",
    name: "Dutch",
    flag: "🇳🇱",
    prompt: "Respond in Dutch (Nederlands).",
  },
  {
    id: "russian",
    name: "Russian",
    flag: "🇷🇺",
    prompt: "Respond in Russian (Русский).",
  },
  {
    id: "chinese",
    name: "Chinese",
    flag: "🇨🇳",
    prompt: "Respond in Simplified Chinese (简体中文).",
  },
  {
    id: "japanese",
    name: "Japanese",
    flag: "🇯🇵",
    prompt: "Respond in Japanese (日本語).",
  },
  {
    id: "korean",
    name: "Korean",
    flag: "🇰🇷",
    prompt: "Respond in Korean (한국어).",
  },
  {
    id: "arabic",
    name: "Arabic",
    flag: "🇸🇦",
    prompt: "Respond in Arabic (العربية).",
  },
  {
    id: "turkish",
    name: "Turkish",
    flag: "🇹🇷",
    prompt: "Respond in Turkish (Türkçe).",
  },
  {
    id: "polish",
    name: "Polish",
    flag: "🇵🇱",
    prompt: "Respond in Polish (Polski).",
  },
  {
    id: "swedish",
    name: "Swedish",
    flag: "🇸🇪",
    prompt: "Respond in Swedish (Svenska).",
  },
  {
    id: "norwegian",
    name: "Norwegian",
    flag: "🇳🇴",
    prompt: "Respond in Norwegian (Norsk).",
  },
  {
    id: "danish",
    name: "Danish",
    flag: "🇩🇰",
    prompt: "Respond in Danish (Dansk).",
  },
  {
    id: "finnish",
    name: "Finnish",
    flag: "🇫🇮",
    prompt: "Respond in Finnish (Suomi).",
  },
  {
    id: "greek",
    name: "Greek",
    flag: "🇬🇷",
    prompt: "Respond in Greek (Ελληνικά).",
  },
  {
    id: "czech",
    name: "Czech",
    flag: "🇨🇿",
    prompt: "Respond in Czech (Čeština).",
  },
  {
    id: "hungarian",
    name: "Hungarian",
    flag: "🇭🇺",
    prompt: "Respond in Hungarian (Magyar).",
  },
  {
    id: "romanian",
    name: "Romanian",
    flag: "🇷🇴",
    prompt: "Respond in Romanian (Română).",
  },
  {
    id: "ukrainian",
    name: "Ukrainian",
    flag: "🇺🇦",
    prompt: "Respond in Ukrainian (Українська).",
  },
  {
    id: "vietnamese",
    name: "Vietnamese",
    flag: "🇻🇳",
    prompt: "Respond in Vietnamese (Tiếng Việt).",
  },
  {
    id: "thai",
    name: "Thai",
    flag: "🇹🇭",
    prompt: "Respond in Thai (ไทย).",
  },
  {
    id: "indonesian",
    name: "Indonesian",
    flag: "🇮🇩",
    prompt: "Respond in Indonesian (Bahasa Indonesia).",
  },
  {
    id: "malay",
    name: "Malay",
    flag: "🇲🇾",
    prompt: "Respond in Malay (Bahasa Melayu).",
  },
  {
    id: "hebrew",
    name: "Hebrew",
    flag: "🇮🇱",
    prompt: "Respond in Hebrew (עברית).",
  },
  {
    id: "filipino",
    name: "Filipino",
    flag: "🇵🇭",
    prompt: "Respond in Filipino (Tagalog).",
  },
];

export const DEFAULT_RESPONSE_LENGTH = "auto";
export const DEFAULT_LANGUAGE = "english";
export const DEFAULT_AUTO_SCROLL = true;
