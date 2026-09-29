// Shared fakes for the docs-screenshot pages: sample settings in local
// storage, the Tauri bridge, and an OpenAI-compatible streaming reply.
// Classic script (not a module) so it runs before the app's modules load.
(function () {
  const params = new URLSearchParams(location.search);
  const now = Date.now();

  localStorage.clear();
  const set = (k, v) => localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
  set("theme", params.get("theme") || "dark");
  set("onboarding_completed", "true");
  set("curl_selected_ai_provider", { provider: "openai", variables: { model: "gpt-4o-mini" }, secretVariables: ["api_key"] });
  set("system_audio_daemon_config", { enabled: true, bufferSeconds: 30 });
  set("transcription_config", {
    engine: "local", localModel: "base.en", language: "auto", captureMic: true, live: true,
    transcriptWindowSeconds: 300, separateSpeakers: true, autoAnswer: true,
    autoAnswerScreenshot: false, autoAnswerDelayMs: 2000, meetingNotes: true,
  });
  set("pinned_facts", [
    { id: "p1", text: "Budget is $40k", addedAt: 1 },
    { id: "p2", text: "Decision needed by Oct 31", addedAt: 2 },
    { id: "p3", text: "They run Kubernetes in three regions", addedAt: 3 },
  ]);
  set("speaker_names", { "Speaker 1": "Priya", "Speaker 2": "Tom" });
  set("screen_recording_granted", "true");

  /** Replies to AI requests, in order; the last one repeats. */
  window.__docsReplies = [];
  let replyIndex = 0;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, init) => {
    if (!String(url).includes("api.openai.com")) return realFetch(url, init);
    const replies = window.__docsReplies;
    const text = replies[Math.min(replyIndex++, replies.length - 1)] || "";
    const body =
      (text.match(/[\s\S]{1,24}/g) || [])
        .map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`)
        .join("") + "data: [DONE]\n\n";
    return new Response(new Blob([body]).stream(), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };

  const stats = {
    startedMs: now - 1_200_000,
    speakers: [
      { label: "Speaker 1", source: "system", lines: 41, words: 910, talkMs: 262_000, lastText: "What happens if an entire region goes down?" },
      { label: "Speaker 2", source: "system", lines: 17, words: 380, talkMs: 118_000, lastText: "We need a decision by October 31." },
      { label: "You", source: "mic", lines: 26, words: 610, talkMs: 245_000, lastText: "We'd fail over to the next region in seconds." },
    ],
    longestMonologueMs: 74_000,
    currentMonologueMs: 0,
  };
  const models = [
    { id: "tiny.en", name: "Tiny (English)", sizeMb: 75, multilingual: false, description: "Fastest, least accurate.", downloaded: false, downloading: false },
    { id: "base.en", name: "Base (English)", sizeMb: 142, multilingual: false, description: "Good balance of speed and accuracy.", downloaded: true, downloading: false },
    { id: "small.en", name: "Small (English)", sizeMb: 466, multilingual: false, description: "More accurate; needs a faster Mac.", downloaded: false, downloading: false },
  ];

  let callback = 0;
  const label = document.documentElement.dataset.window || "main";
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label }, currentWebview: { label, windowLabel: label } },
    transformCallback: () => ++callback,
    unregisterCallback: () => {},
    convertFileSrc: (p) => p,
    invoke: async (cmd) => {
      switch (cmd) {
        case "secret_get": return "sk-docs-example";
        case "get_app_version": return "0.3.0";
        case "live_transcript_stats": return stats;
        case "live_transcript_status": return { running: true, modelId: "base.en", segmentCount: 84, lastError: null };
        case "live_transcript_get": return { segments: [], text: "", silent: false, silenceRatio: 0, micSilenceRatio: 0, audioSeconds: 0, durationMs: 1 };
        case "local_stt_list_models": return models;
        case "speaker_model_status": return { supported: true, downloaded: true, downloading: false, sizeMb: 26 };
        case "mic_audio_start": return "MacBook Pro Microphone";
        case "plugin:sql|load": return "sqlite:runningbord.db";
        case "plugin:sql|select": return [];
        case "plugin:sql|execute": return [1, 0];
      }
      if (cmd.startsWith("plugin:event|")) return 1;
      if (cmd.startsWith("plugin:macos-permissions|")) return true;
      return null;
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__docs = {
    wait,
    /** Poll until `fn` returns something truthy (up to 10 s). */
    async until(fn) {
      for (let i = 0; i < 400 && !fn(); i++) await wait(25);
      return fn();
    },
    /** Set a React-controlled input or textarea's value. */
    type(el, value) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
      Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    /** Tell frame.html the page is ready, with the size to capture. */
    ready(el) {
      const rect = el ? el.getBoundingClientRect() : null;
      document.documentElement.dataset.ready = "true";
      parent.postMessage({ docsReady: true, height: rect ? Math.ceil(rect.height) : null }, "*");
    },
  };
})();
