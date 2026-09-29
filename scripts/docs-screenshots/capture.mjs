#!/usr/bin/env node
// Screenshots of the real app UI for docs/USER_GUIDE.md.
//
// The overlay window is excluded from screen capture, so this renders the
// same React components in headless Chrome with Tauri and the AI provider
// faked (mocks.js), drives them like a user, and saves 2x PNGs to docs/images/.
// Chrome is controlled over the DevTools protocol so each shot waits until the
// page says it's ready and is cropped to the part being documented.
//
//   npm run docs:screenshots
//
// Needs Node 22+ and Google Chrome (set CHROME=/path/to/chrome elsewhere).
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const out = resolve(root, "docs/images");
const vitePort = 1498;
const debugPort = 9333;
const chromePath =
  process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const theme = process.env.THEME ?? "dark";

// frame.html puts the overlay on a desktop-like background at its real size;
// dashboard sections are captured on their own.
const shots = [
  { name: "overlay-bar", path: "frame.html?page=app&scene=bar", clip: "body", width: 680, height: 110 },
  { name: "overlay-panel", path: "frame.html?page=app&scene=panel", clip: "body", width: 680, height: 656 },
  ...["meeting-prep", "pinned-facts", "auto-answer", "people", "talk-time", "meeting-notes"].map((section) => ({
    name: `meeting-${section.replace(/^meeting-/, "")}`,
    path: `dashboard.html?section=${section}`,
    clip: "#docs-shot",
    width: 680,
    height: 1600,
  })),
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = [];
const stopAll = () => started.forEach((p) => p.kill());
process.on("exit", stopAll);

async function waitFor(check, what, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// Dev server and headless Chrome.
const vite = spawn("npx", ["vite", "--port", String(vitePort), "--strictPort"], {
  cwd: root,
  stdio: ["ignore", "pipe", "inherit"],
});
started.push(vite);
await new Promise((ok, fail) => {
  vite.stdout.on("data", (d) => String(d).includes("Local:") && ok());
  vite.on("exit", (code) => fail(new Error(`vite exited with ${code}`)));
});
const chrome = spawn(chromePath, [
  "--headless=new",
  `--remote-debugging-port=${debugPort}`,
  "--hide-scrollbars",
  "--no-first-run",
  // Tabs opened over the protocol count as background tabs; don't slow them down.
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  `--user-data-dir=${resolve(root, "node_modules/.cache/docs-screenshots-chrome")}`,
  "about:blank",
], { stdio: "ignore" });
started.push(chrome);
// Use the tab Chrome opened: tabs created over the protocol are background
// tabs, whose timers Chrome slows down.
const pageTarget = await waitFor(
  () =>
    fetch(`http://127.0.0.1:${debugPort}/json/list`)
      .then((r) => r.json())
      .then((targets) => targets.find((t) => t.type === "page")),
  "Chrome"
);
const { webSocketDebuggerUrl } = await waitFor(
  () => fetch(`http://127.0.0.1:${debugPort}/json/version`).then((r) => r.json()),
  "Chrome"
);

// Minimal DevTools protocol client.
const socket = new WebSocket(webSocketDebuggerUrl);
await new Promise((ok) => socket.addEventListener("open", ok, { once: true }));
let nextId = 0;
const pending = new Map();
socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  const handler = pending.get(message.id);
  if (!handler) return;
  pending.delete(message.id);
  message.error ? handler.reject(new Error(message.error.message)) : handler.resolve(message.result);
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolveResult, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve: resolveResult, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });

mkdirSync(out, { recursive: true });
try {
  for (const shot of shots) {
    const { sessionId } = await send("Target.attachToTarget", { targetId: pageTarget.id, flatten: true });
    const run = (method, params) => send(method, params, sessionId);
    await run("Page.enable");
    await run("Page.bringToFront");
    await run("Emulation.setDeviceMetricsOverride", {
      width: shot.width,
      height: shot.height,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await run("Page.navigate", {
      url: `http://localhost:${vitePort}/scripts/docs-screenshots/${shot.path}&theme=${theme}`,
    });
    const evaluate = async (expression) =>
      (await run("Runtime.evaluate", { expression, returnByValue: true })).result.value;

    // frame.html marks itself ready once the page inside it is.
    try {
      await waitFor(
        () => evaluate(`document.documentElement.dataset.ready === "true" || document.body?.dataset.shotHeight !== undefined`),
        `${shot.name} to be ready`
      );
    } catch (error) {
      const state = await evaluate(`(() => {
        const inner = document.querySelector("iframe")?.contentDocument ?? document;
        return JSON.stringify({ url: location.href, text: inner.body?.innerText?.slice(0, 300) });
      })()`).catch(() => "unavailable");
      throw new Error(`${error.message}. Page state: ${state}`);
    }
    await sleep(300);
    const rect = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(shot.clip)});
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`);
    const { data } = await run("Page.captureScreenshot", {
      format: "png",
      clip: { ...rect, scale: 1 },
      captureBeyondViewport: true,
    });
    const file = resolve(out, `${shot.name}.png`);
    writeFileSync(file, Buffer.from(data, "base64"));
    console.log(`saved ${file}`);
    await send("Target.detachFromTarget", { sessionId });
  }
} finally {
  socket.close();
  stopAll();
}
