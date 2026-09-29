#!/usr/bin/env node
// Wrapper for the Tauri CLI (`npm run tauri ...`). Every command is passed
// through unchanged, except that macOS builds are always signed with the same
// self-signed certificate, so macOS keeps Screen Recording / Microphone /
// System Audio permissions across rebuilds. The certificate is created on the
// first build.
//
// Opt out for one build:   RUNNINGBORD_UNSIGNED=1 npm run tauri build
// Use another identity:    APPLE_SIGNING_IDENTITY="..." npm run tauri build
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const env = { ...process.env };

const IDENTITY = env.RUNNINGBORD_SIGNING_IDENTITY || "Runningbord Dev";
// The certificate and its password are kept here so CI can sign with the same one.
const EXPORT_DIR = join(homedir(), ".runningbord-signing");

const isMacBuild = process.platform === "darwin" && args[0] === "build";

function run(cmd, cmdArgs, options = {}) {
  return spawnSync(cmd, cmdArgs, { stdio: "inherit", ...options });
}

function hasIdentity(name) {
  return spawnSync("security", ["find-certificate", "-c", name], { stdio: "ignore" }).status === 0;
}

function ensureSigning() {
  if (env.APPLE_SIGNING_IDENTITY) {
    console.log(`[build] Signing with APPLE_SIGNING_IDENTITY="${env.APPLE_SIGNING_IDENTITY}".`);
    return;
  }
  if (env.RUNNINGBORD_UNSIGNED === "1") {
    console.log("[build] RUNNINGBORD_UNSIGNED=1: building ad-hoc signed.");
    return;
  }
  if (env.CI) {
    // A throwaway certificate per CI run would be as bad as none: signing in CI
    // only happens with the secrets from .github/workflows/publish.yml.
    console.log("[build] CI without signing secrets: building ad-hoc signed.");
    return;
  }
  if (!hasIdentity(IDENTITY)) {
    console.log(`[build] First signed build: creating code-signing identity "${IDENTITY}".`);
    const created = run("bash", [join(root, "scripts/macos-signing-cert.sh"), "--export-ci", EXPORT_DIR], {
      env: { ...env, CERT_NAME: IDENTITY },
    });
    if (created.status !== 0) {
      console.error("[build] Could not create the signing identity; see above.");
      process.exit(created.status ?? 1);
    }
    console.log(`[build] CI secrets for the same certificate: ${join(EXPORT_DIR, "secrets.txt")}`);
  }
  env.APPLE_SIGNING_IDENTITY = IDENTITY;
  console.log(`[build] Signing with "${IDENTITY}".`);
}

function newestApp(dir, found = []) {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry.endsWith(".app")) found.push(path);
    else if (statSync(path).isDirectory() && !entry.startsWith(".") && entry !== "deps" && entry !== "build")
      newestApp(path, found);
  }
  return found;
}

function reportSignature() {
  const targetDir = env.CARGO_TARGET_DIR || join(root, "src-tauri/target");
  const apps = newestApp(targetDir).sort(
    (a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs
  );
  if (apps.length === 0) return;
  const info = spawnSync("codesign", ["-dvv", apps[0]], { encoding: "utf8" });
  const details = `${info.stdout}${info.stderr}`;
  const authority = details.match(/^Authority=(.*)$/m)?.[1];
  const runtime = /flags=.*runtime/.test(details);
  console.log(
    `[build] ${apps[0]}\n[build] signature: ${authority ?? "ad-hoc"}${runtime ? ", hardened runtime" : ""}`
  );
}

/**
 * Update files (.sig + latest.json) need the updater private key. Use ours from
 * EXPORT_DIR when present; otherwise build without them so builds still work.
 */
function ensureUpdaterKey() {
  if (env.TAURI_SIGNING_PRIVATE_KEY) return;
  const secretsFile = join(EXPORT_DIR, "updater-secrets.txt");
  if (existsSync(secretsFile)) {
    for (const line of readFileSync(secretsFile, "utf8").split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
    }
    console.log("[build] Signing update files with the key in ~/.runningbord-signing.");
    return;
  }
  console.log("[build] No updater key: building without update files.");
  args.push("--config", JSON.stringify({ bundle: { createUpdaterArtifacts: false } }));
}

if (isMacBuild) ensureSigning();
if (args[0] === "build") ensureUpdaterKey();

const result = run("tauri", args, { env, shell: process.platform === "win32" });
if (isMacBuild && result.status === 0) reportSignature();
process.exit(result.status ?? 1);
