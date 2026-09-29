#!/usr/bin/env node
// Screenshots of the real overlay UI for docs/USER_GUIDE.md.
//
// The overlay window is excluded from screen capture, so this renders the
// same React components in headless Chrome with Tauri and the AI provider
// faked (see app.html), and saves 2x PNGs to docs/images/.
//
//   node scripts/docs-screenshots/capture.mjs
//
// Needs Google Chrome (set CHROME=/path/to/chrome elsewhere).
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const out = resolve(root, "docs/images");
const port = 1498;
const chrome =
  process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const shots = [
  { name: "overlay-bar", scene: "bar", width: 680, height: 110 },
  { name: "overlay-panel", scene: "panel", width: 680, height: 656 },
];

mkdirSync(out, { recursive: true });
const vite = spawn("npx", ["vite", "--port", String(port), "--strictPort"], {
  cwd: root,
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolveReady, reject) => {
  vite.stdout.on("data", (d) => String(d).includes("Local:") && resolveReady());
  vite.on("exit", (code) => reject(new Error(`vite exited with ${code}`)));
});

try {
  for (const shot of shots) {
    const file = resolve(out, `${shot.name}.png`);
    execFileSync(chrome, [
      "--headless=new",
      "--hide-scrollbars",
      "--force-device-scale-factor=2",
      `--window-size=${shot.width},${shot.height}`,
      "--virtual-time-budget=15000",
      `--screenshot=${file}`,
      `http://localhost:${port}/scripts/docs-screenshots/frame.html?scene=${shot.scene}&theme=dark`,
    ], { stdio: "ignore" });
    console.log(`saved ${file}`);
  }
} finally {
  vite.kill();
}
