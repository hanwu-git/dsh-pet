// Host side of the border-collie pet: a function-plugin (plain `apply(ctx)`), same shape as the
// prompt-polish plugin. NO bare imports of @deepseek-ai/* packages — a linked plugin's real file
// location (D:\obj\dsh-pet) has no node_modules carrying host internals, so those imports fail at
// activation (ERR_MODULE_NOT_FOUND). Instead we register ONE webServer route
// `/border-collie-pet/rpc` and dispatch actions ourselves; the client module calls it with
// fetch() through the DSH origin (cookie-authenticated via the connection trust fence).
// Task signals: ctx.on("agent/status"|"agent/error"|"session/event") — cordis function plugins
// receive the raw ctx, so these subscriptions need no imports either.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as kuroBridge from "./kurocat-bridge.js";

const packageDir = dirname(fileURLToPath(import.meta.url));

// Plugin version, read once from package.json and surfaced through the status RPC so the
// settings page can display it without duplicating the number in two places.
let PLUGIN_VERSION = "0.0.0";
try {
  PLUGIN_VERSION = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version || PLUGIN_VERSION;
} catch { /* keep fallback */ }

export const name = "border-collie-pet-host";
/** Service fields the function plugin touches: webServer for the RPC route, connection for the
 * trust fence. Task signals arrive as plain ctx.on emissions, so no other fields are needed. */
export const inject = ["webServer", "connection"];
export const BUILD = "v3-kurocat-bridge-2026-11-27";

const stateDir = join(packageDir, ".companion");
const stateFile = join(stateDir, "state.json");
const cmdFile = join(stateDir, "cmd.json");
const PIN_FILE = join(stateDir, "pinned.json");
const SETTINGS_FILE = join(stateDir, "settings.json");
// User-selected pet artwork (written via the set-image RPC). When present it replaces the
// bundled border-collie art in BOTH the in-page pet and the desktop companion window.
const CUSTOM_PET_FILE = join(stateDir, "pet-custom.png");
// 上传上限：base64 数据 URL 解码后 8 MiB——足够任何合理图片，同时防止恶意超包。
const CUSTOM_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

const DEFAULT_SETTINGS = {
  size: "large", sound: true, image: "default",
  // Pet mode: "collie" = built-in border collie (in-page + tkinter desktop window);
  // "kurocat" = delegate the pet role to a locally running KuroCat (bridge forwards events).
  petMode: "collie",
  // KuroCat bridge: on by default (zero cost when KuroCat is not running), port 27420.
  kurocat: true, kurocatPort: 27420, kurocatAutostart: false,
};
const VALID_SIZES = ["large", "medium", "small"];
const VALID_PET_MODES = ["collie", "kurocat"];

// Python discovery, in priority order. pythonw.exe first (no console flash), then python.exe.
// Candidates cover: DSH's own bundled runtime (our primary case), PATH lookups, and the common
// per-user / system-wide CPython install locations so a fresh machine can still run the window.
const USERPROFILE = process.env.USERPROFILE ?? "";
const PYTHON_CANDIDATES = [
  join(USERPROFILE, ".dsh", "dsh-runtimes", "dsh-primary-runtime", "dependencies", "python", "pythonw.exe"),
  join(USERPROFILE, ".dsh", "dsh-runtimes", "dsh-primary-runtime", "dependencies", "python", "python.exe"),
  join(USERPROFILE, "AppData", "Local", "Programs", "Python", "Python313", "pythonw.exe"),
  join(USERPROFILE, "AppData", "Local", "Programs", "Python", "Python312", "pythonw.exe"),
  join(USERPROFILE, "AppData", "Local", "Programs", "Python", "Python311", "pythonw.exe"),
  join(USERPROFILE, "AppData", "Local", "Programs", "Python", "Python310", "pythonw.exe"),
  "C:\\Python313\\pythonw.exe",
  "C:\\Python312\\pythonw.exe",
  "C:\\Python311\\pythonw.exe",
  "pythonw.exe",
  "python.exe",
];

const COMPANION = join(packageDir, "companion.py");
// Pre-flattened against the #FF00FF key color (Pillow alpha_composite at build time): avoids the
// purple fringe that tkinter's -transparentcolor live blending produces on semi-transparent edges.
const PET_PNG = join(packageDir, "pet-flat.png");

/** The artwork file to show RIGHT NOW: the user's custom image when settings say so and the
 * file exists, otherwise the bundled (key-color-flattened) border collie. Re-evaluated on every
 * companion launch, so a settings change + re-pin picks up the new art automatically. */
function petArtFile() {
  try {
    if (readSettings().image === "custom" && existsSync(CUSTOM_PET_FILE)) return CUSTOM_PET_FILE;
  } catch { /* ignore */ }
  return PET_PNG;
}

/** Absolute first-hit, then bare names handed to the OS/PATH. Returns null when none exist. */
function resolvePython() {
  for (const p of PYTHON_CANDIDATES) {
    try { if (p && existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

let companion = null;
let pinned = false;
let stateSeq = 0;

let ownerPid = null;

// Session ids currently in the "running" state. The status light is on iff this set is non-empty:
// one agent ending must not turn the light off while other agents are still working.
const runningSet = new Set();
// Most recent "navigate to this session" request, handed from the desktop window (via cmd.json)
// to the web client (via the take-navigation RPC). Overwrite semantics are fine: latest wins.
let pendingNavigation = null;

function writeState(patch) {
  try {
    mkdirSync(stateDir, { recursive: true });
    stateSeq += 1;
    // writeState replaces the whole file, so always include the fields the companion needs to
    // persist across unrelated events: owner (orphan guard) and active (status light). Without
    // this, a fail/ask event would silently drop the current light state.
    writeFileSync(stateFile, JSON.stringify({
      active: runningSet.size > 0,
      ...patch,
      ...(ownerPid ? { owner: ownerPid } : {}),
      t: stateSeq,
    }));
    logLine("state", { patch: Object.keys(patch).join(","), t: stateSeq });
  } catch { /* ignore */ }
}

function writeCmd(cmd) {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(cmdFile, JSON.stringify({ ...cmd, t: Date.now() }));
  } catch { /* ignore */ }
}

function writePinnedFile(v) {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(PIN_FILE, JSON.stringify({ pinned: v, t: Date.now() }));
  } catch { /* ignore */ }
}

function readPinnedFile() {
  try {
    return JSON.parse(readFileSync(PIN_FILE, "utf8")).pinned === true;
  } catch { return false; }
}

/** Read persisted pet settings; fall back to defaults on any corruption. */
function readSettings() {
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
    const size = VALID_SIZES.includes(raw && raw.size) ? raw.size : DEFAULT_SETTINGS.size;
    const sound = typeof (raw && raw.sound) === "boolean" ? raw.sound : DEFAULT_SETTINGS.sound;
    // image: "default" (bundled border collie) or "custom" (user-uploaded pet-custom.png).
    // If "custom" is set but the file is gone, fall back to "default" so nothing breaks.
    let image = raw && raw.image === "custom" ? "custom" : "default";
    if (image === "custom" && !existsSync(CUSTOM_PET_FILE)) image = "default";
    const petMode = VALID_PET_MODES.includes(raw && raw.petMode) ? raw.petMode : DEFAULT_SETTINGS.petMode;
    const kurocat = typeof (raw && raw.kurocat) === "boolean" ? raw.kurocat : DEFAULT_SETTINGS.kurocat;
    const kurocatPort = Number.isInteger(raw && raw.kurocatPort) && raw.kurocatPort > 0 && raw.kurocatPort < 65536
      ? raw.kurocatPort : DEFAULT_SETTINGS.kurocatPort;
    const kurocatAutostart = typeof (raw && raw.kurocatAutostart) === "boolean"
      ? raw.kurocatAutostart : DEFAULT_SETTINGS.kurocatAutostart;
    return { size, sound, image, petMode, kurocat, kurocatPort, kurocatAutostart };
  } catch { return { ...DEFAULT_SETTINGS }; }
}

/** Merge a partial patch, validate values, persist, and log. Returns the effective settings. */
function writeSettings(patch) {
  const current = readSettings();
  const next = {
    size: patch && VALID_SIZES.includes(patch.size) ? patch.size : current.size,
    sound: patch && typeof patch.sound === "boolean" ? patch.sound : current.sound,
    image: patch && (patch.image === "custom" || patch.image === "default")
      ? (patch.image === "custom" && !existsSync(CUSTOM_PET_FILE) ? "default" : patch.image)
      : current.image,
    petMode: patch && VALID_PET_MODES.includes(patch.petMode) ? patch.petMode : current.petMode,
    kurocat: patch && typeof patch.kurocat === "boolean" ? patch.kurocat : current.kurocat,
    kurocatPort: patch && Number.isInteger(patch.kurocatPort) && patch.kurocatPort > 0 && patch.kurocatPort < 65536
      ? patch.kurocatPort : current.kurocatPort,
    kurocatAutostart: patch && typeof patch.kurocatAutostart === "boolean"
      ? patch.kurocatAutostart : current.kurocatAutostart,
  };
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(SETTINGS_FILE, JSON.stringify(next));
    logLine("settings", { size: next.size, sound: next.sound, image: next.image, petMode: next.petMode, kurocat: next.kurocat, kurocatPort: next.kurocatPort });
  } catch { /* ignore */ }
  // Keep the bridge in sync with persisted settings (enabled flag, port, autostart).
  kuroBridge.configure({
    kurocat: next.kurocat,
    kurocatPort: next.kurocatPort,
    kurocatAutostart: next.kurocatAutostart,
  });
  return next;
}

// ---- custom pet image ------------------------------------------------------

/** Persist a user-selected image as the pet artwork. Accepts a data URL
 * (data:image/png;base64,... style, as produced by the settings page's FileReader) or a bare
 * base64 string. The bytes are COPIED into .companion/pet-custom.png inside the plugin
 * directory — the original file the user picked is never referenced afterwards, so deleting
 * or moving it can never break the pet. Both surfaces (in-page <img> and the tkinter desktop
 * window) read this copied file. Non-PNG input is rejected with an explicit error instead of
 * silently breaking the pinned window. */
function setCustomImage(dataUrl) {
  const text = String(dataUrl || "");
  const match = /^data:image\/([a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(text.trim());
  let mime;
  let base64;
  if (match) {
    mime = match[1].toLowerCase();
    base64 = match[2];
  } else if (/^[A-Za-z0-9+/=\s]+$/.test(text.trim()) && text.trim().length > 0) {
    mime = "png";
    base64 = text.trim();
  } else {
    return { ok: false, error: "image must be a base64 data URL" };
  }
  // The desktop companion window (tkinter.PhotoImage) can only decode PNG (and GIF), so the
  // settings page converts whatever the user picked to PNG before uploading; reject anything
  // else here so a JPEG can never leave the pinned window silently broken.
  if (!["png", "x-png", "apng"].includes(mime)) {
    return { ok: false, error: "only PNG images are supported (the page converts before upload)" };
  }
  let buffer;
  try { buffer = Buffer.from(base64.replace(/\s+/g, ""), "base64"); } catch {
    return { ok: false, error: "invalid base64 image data" };
  }
  if (buffer.length === 0) return { ok: false, error: "image data is empty" };
  if (buffer.length > CUSTOM_IMAGE_MAX_BYTES) {
    return { ok: false, error: "image too large (max 8 MiB)" };
  }
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(CUSTOM_PET_FILE, buffer);
    const settings = writeSettings({ image: "custom" });
    logLine("set-image", { bytes: buffer.length });
    return { ok: true, image: settings.image };
  } catch (e) {
    return { ok: false, error: "failed to save image" };
  }
}

/** Remove the custom artwork and fall back to the bundled border collie. */
function resetCustomImage() {
  try {
    if (existsSync(CUSTOM_PET_FILE)) unlinkSync(CUSTOM_PET_FILE);
  } catch { /* ignore */ }
  const settings = writeSettings({ image: "default" });
  logLine("reset-image", {});
  return { ok: true, image: settings.image };
}

function startCompanion() {
  if (companion && companion.exitCode === null && !companion.killed) return true;
  const python = resolvePython();
  if (!python) return false;
  try {
    mkdirSync(stateDir, { recursive: true });
    stateSeq = 0;
    // owner pid is passed to the companion as a launch argument: the companion remembers the
    // pid of the host that spawned IT, so it can tell whether its own host died. The owner
    // field written to state.json is overwritten by any newer host, so it cannot be trusted
    // for the orphan check (a stale window would read the new host's live pid and stay alive).
    ownerPid = process.pid;
    writeFileSync(stateFile, JSON.stringify({ t: 0, owner: ownerPid }));
    // Clear any stale command (e.g. a leftover quit from a previous run) BEFORE spawning:
    // the companion reads cmd.json on its first poll and would exit immediately otherwise.
    try { writeFileSync(cmdFile, ""); } catch { /* ignore */ }
    companion = spawn(python, [COMPANION, stateFile, cmdFile, petArtFile(), String(ownerPid)], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    companion.unref();
    return true;
  } catch {
    companion = null;
    return false;
  }
}

function stopCompanion() {
  writeCmd({ kind: "quit" });
  companion = null;
}

function setPinned(v) {
  pinned = v;
  writePinnedFile(v);
  if (v) {
    const python = resolvePython();
    if (!python) {
      pinned = false;
      writePinnedFile(false);
      logLine("pin-failed", { reason: "no-python" });
      return {
        ok: false,
        error: "desktop window needs Python 3 (tkinter). Install Python, or keep using the in-page pet.",
      };
    }
    const ok = startCompanion();
    if (!ok) {
      pinned = false;
      writePinnedFile(false);
      logLine("pin-failed", { reason: "spawn-failed" });
      return { ok: false, error: "companion launch failed" };
    }
    writeState({ t: 0 });
  } else {
    stopCompanion();
  }
  return { ok: true, pinned };
}

// ---- webServer route -------------------------------------------------------

const RPC_PATH = "/border-collie-pet/rpc";

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function readBoundedBody(req, max = 12 * 1024 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > max) { failed = true; req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on("end", () => { if (!failed) resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", () => resolve(null));
  });
}

/** Function-plugin entry: register the RPC route + task-signal listeners. */
export function apply(ctx) {
  logLine("apply-ran", { build: BUILD });

  // Sync the KuroCat bridge with persisted settings on every activation (port, enabled,
  // autostart). Pet lifecycle per the v2.0 requirements:
  // - The pet may run STANDALONE: if an instance already answers on our port, we adopt it
  //   and start tracking DSH state into it (no second process is ever spawned).
  // - If not running and petMode=kurocat: autostart setting decides whether we launch it.
  // - On DSH exit we do NOT kill it: the web client asks the user (kurocat-exit-choice).
  let kuroMode = false;
  {
    const s = readSettings();
    kuroMode = s.petMode === "kurocat";
    kuroBridge.configure({
      kurocat: s.kurocat,
      kurocatPort: s.kurocatPort,
      kurocatAutostart: s.kurocatAutostart,
      dataDir: stateDir,
    });
    // Attach to a running instance OR auto-start per settings; either way tracking begins.
    if (kuroMode) {
      kuroBridge.startSidecar().then((r) => logLine("kurocat-sidecar", { ok: r.ok, adopted: !!r.adopted, reason: r.reason || "" }))
        .catch(() => {});
    }
  }

  // Restore pin state from the previous run: if the user had pinned the pet, relaunch the
  // companion window when DSH starts (and again after every DSH restart). Skipped in kurocat
  // mode — the collie desktop window must stay closed there. Also writes pinned.json=false so
  // the flag cannot silently resurrect the window on the NEXT restart either.
  if (kuroMode) {
    if (readPinnedFile()) {
      setPinned(false);
      logLine("auto-pin-suppressed-kurocat", {});
    }
  } else if (readPinnedFile()) {
    const result = setPinned(true);
    if (result.ok) logLine("auto-pin-restored", {});
  }

  // Task signals → companion window (only meaningful while pinned) + KuroCat bridge (when
  // enabled and running). Track running sessions per-agent so the status light stays on while
  // ANY agent is working, and emit a completion bubble on EVERY agent end (even while others
  // keep running). writeState replaces the whole file each call, so `active` and `runningEnd`
  // must be written in the SAME call — two calls would overwrite each other.
  // Bridge gate is read once per activation: KuroCat forwarding follows its own setting and
  // is deliberately decoupled from `pinned` — when the user delegates the pet role to
  // KuroCat, events must flow without pinning the tkinter collie window.
  const bridgeOn = readSettings().kurocat === true;

  // Task signals → companion window (only meaningful while pinned) + KuroCat bridge (when
  // enabled and running). Track running sessions per-agent so the status light stays on while
  // ANY agent is working, and emit a completion bubble on EVERY agent end (even while others
  // keep running). writeState replaces the whole file each call, so `active` and `runningEnd`
  // must be written in the SAME call — two calls would overwrite each other.
  ctx.on("agent/status", ({ agent, status }) => {
    const id = agent && agent.id;
    if (status === "running") {
      if (id) runningSet.add(id);
      if (bridgeOn && runningSet.size === 1) kuroBridge.bridgeEvent("runningStart");
      if (!pinned) return;
      writeState({ active: true });
    } else {
      if (id) runningSet.delete(id);
      if (bridgeOn && runningSet.size === 0) kuroBridge.bridgeEvent("runningEnd");
      if (!pinned) return;
      writeState({ active: runningSet.size > 0, runningEnd: { id } });
    }
  });
  ctx.on("agent/error", ({ agent, error }) => {
    const message = String((error && error.message) || "执行出错").slice(0, 60);
    if (bridgeOn) kuroBridge.bridgeEvent("fail", { message });
    if (!pinned) return;
    writeState({ fail: { id: agent && agent.id, message } });
  });
  ctx.on("session/event", (session, event) => {
    const isAsk = (event.type === "tool/call" && event.data && event.data.name === "ask_user_question")
      || event.type === "approval/asked";
    if (bridgeOn && isAsk) kuroBridge.bridgeEvent("ask");
    if (!pinned) return;
    if (event.type === "tool/call" && event.data && event.data.name === "ask_user_question") {
      writeState({ ask: { id: session.id } });
    } else if (event.type === "approval/asked") {
      writeState({ ask: { id: session.id, tool: String((event.data && event.data.toolName) || "") } });
    } else if (event.type === "approval/decided") {
      writeState({ askDone: { id: session.id } });
    }
  }, { global: true });

  // Pick up "navigate to session" commands written by the desktop window into cmd.json.
  // (The companion writes quit there too; we only react to kind === "navigate" and leave other
  // commands alone.) Take-and-clear so a command is delivered exactly once.
  const cmdTimer = setInterval(() => {
    try {
      if (!existsSync(cmdFile)) return;
      const cmd = JSON.parse(readFileSync(cmdFile, "utf8") || "{}");
      if (cmd && cmd.kind === "navigate" && cmd.sessionId) {
        pendingNavigation = { sessionId: String(cmd.sessionId), t: cmd.t || Date.now() };
        writeFileSync(cmdFile, "", "utf8");
        logLine("nav-queued", { sessionId: pendingNavigation.sessionId });
      }
    } catch { /* ignore transient read/write races */ }
  }, 800);
  ctx.effect(() => () => clearInterval(cmdTimer));

  // RPC route behind the connection trust fence (browser cookie is verified per request).
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: RPC_PATH,
    handler: (req, res) => (async () => {
      const rejection = Reflect.get(ctx, "connection") && ctx.connection.requestRejection(req);
      if (rejection !== undefined) { res.statusCode = rejection; res.end(); return; }
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("allow", "POST");
        res.end();
        return;
      }
      const essence = String(req.headers["content-type"]).split(";", 1)[0].trim().toLowerCase();
      if (essence !== "application/json") {
        sendJson(res, 415, { ok: false, error: "content-type must be application/json" });
        return;
      }
      const text = await readBoundedBody(req);
      if (text === null) {
        sendJson(res, 400, { ok: false, error: "request body unreadable" });
        return;
      }
      let body;
      try { body = JSON.parse(text); } catch {
        sendJson(res, 400, { ok: false, error: "body must be JSON" });
        return;
      }
      const action = body && body.action;
      if (action === "pin") {
        const want = body.value === true;
        if (want === pinned) { sendJson(res, 200, { ok: true, pinned }); return; }
        sendJson(res, 200, setPinned(want));
        return;
      }
      if (action === "status") {
        const s = readSettings();
        sendJson(res, 200, {
          ok: true, pinned, companion: !!(companion && companion.exitCode === null),
          size: s.size, sound: s.sound, image: s.image,
          petMode: s.petMode, kurocat: s.kurocat, kurocatPort: s.kurocatPort,
          kurocatAutostart: s.kurocatAutostart,
          // Plugin version from package.json, shown in the settings page header.
          version: PLUGIN_VERSION,
          // True when a user-uploaded artwork exists and can be restored via settings.image.
          hasCustomImage: existsSync(CUSTOM_PET_FILE),
          // The settings UI and the pin tooltip explain a failed launch with this flag.
          python: !!resolvePython(),
          platform: process.platform,
        });
        return;
      }
      if (action === "kurocat-status") {
        // Probe KuroCat's /health and report bridge state for the settings page.
        const s = readSettings();
        kuroBridge.configure({ kurocat: s.kurocat, kurocatPort: s.kurocatPort, kurocatAutostart: s.kurocatAutostart });
        const st = await kuroBridge.status();
        sendJson(res, 200, { ok: true, ...st });
        return;
      }
      if (action === "kurocat-start") {
        // Start-or-adopt: never spawns a second instance when one already answers.
        const r = await kuroBridge.startSidecar();
        sendJson(res, 200, r);
        return;
      }
      if (action === "kurocat-stop") {
        // Explicit user action only (settings page). DSH exit uses the choice flow below.
        kuroBridge.stopSidecar();
        sendJson(res, 200, { ok: true });
        return;
      }
      if (action === "kurocat-exit-choice") {
        // The client asks the user "close the pet too?" at DSH exit and reports the answer.
        // Once remembered, later exits apply it without prompting again. A cleared/null
        // choice re-enables prompting (the settings page offers "ask every time").
        const choice = body && body.choice;
        if (choice === "close" || choice === "keep" || choice === null) {
          if (choice) kuroBridge.rememberExitChoice(choice);
          else kuroBridge.rememberExitChoice(null);
          if (choice === "close") kuroBridge.stopSidecar();
          sendJson(res, 200, { ok: true, choice: kuroBridge.getExitChoice() });
        } else {
          sendJson(res, 200, { ok: true, choice: kuroBridge.getExitChoice() });
        }
        return;
      }
      if (action === "settings") {
        const value = body && body.value;
        if (!value || typeof value !== "object") {
          sendJson(res, 400, { ok: false, error: "value must be an object" });
          return;
        }
        if (Object.prototype.hasOwnProperty.call(value, "size") && !VALID_SIZES.includes(value.size)) {
          sendJson(res, 400, { ok: false, error: "bad size" });
          return;
        }
        if (Object.prototype.hasOwnProperty.call(value, "sound") && typeof value.sound !== "boolean") {
          sendJson(res, 400, { ok: false, error: "bad sound" });
          return;
        }
        if (Object.prototype.hasOwnProperty.call(value, "image")
          && !["default", "custom"].includes(value.image)) {
          sendJson(res, 400, { ok: false, error: "bad image" });
          return;
        }
        if (Object.prototype.hasOwnProperty.call(value, "petMode")
          && !VALID_PET_MODES.includes(value.petMode)) {
          sendJson(res, 400, { ok: false, error: "bad petMode" });
          return;
        }
        if (Object.prototype.hasOwnProperty.call(value, "kurocatPort")
          && !(Number.isInteger(value.kurocatPort) && value.kurocatPort > 0 && value.kurocatPort < 65536)) {
          sendJson(res, 400, { ok: false, error: "bad kurocatPort" });
          return;
        }
        sendJson(res, 200, { ok: true, ...writeSettings(value) });
        // Pet-mode switch: kurocat starts/attaches the pet; collie only stops a pet WE
        // spawned (an adopted/standalone instance is left running — the user owns it).
        if (value && value.petMode === "kurocat") {
          if (pinned) setPinned(false);
          kuroBridge.startSidecar().catch(() => {});
        } else if (value && value.petMode === "collie") {
          kuroBridge.stopSidecar();
        }
        return;
      }
      if (action === "set-image") {
        // Upload a user-selected pet artwork (PNG data URL) and switch settings.image to it.
        const value = body && body.value;
        if (!value || typeof value !== "string") {
          sendJson(res, 400, { ok: false, error: "value must be a data URL string" });
          return;
        }
        sendJson(res, 200, setCustomImage(value));
        return;
      }
      if (action === "reset-image") {
        sendJson(res, 200, resetCustomImage());
        return;
      }
      if (action === "get-image") {
        if (!existsSync(CUSTOM_PET_FILE)) {
          sendJson(res, 200, { ok: true, image: null });
          return;
        }
        try {
          const data = readFileSync(CUSTOM_PET_FILE).toString("base64");
          sendJson(res, 200, { ok: true, image: "data:image/png;base64," + data });
        } catch {
          sendJson(res, 200, { ok: true, image: null });
        }
        return;
      }
      if (action === "test") {
        if (!pinned) { sendJson(res, 200, { ok: false, error: "not pinned" }); return; }
        writeState({ test: { kind: String((body && body.kind) || "done") } });
        sendJson(res, 200, { ok: true });
        return;
      }
      if (action === "sound-test") {
        // Play a bubble tone without needing a task event, so the settings page can offer a
        // "试听" button. Routed through the companion so it uses the exact same code path
        // (and the same winsound tones) as a real bubble.
        const kind = String((body && body.kind) || "done");
        if (!["done", "fail", "ask"].includes(kind)) {
          sendJson(res, 400, { ok: false, error: "bad kind" });
          return;
        }
        if (!pinned) { sendJson(res, 200, { ok: false, error: "not pinned" }); return; }
        writeState({ test: { kind } });
        sendJson(res, 200, { ok: true, kind });
        return;
      }
      if (action === "take-navigation") {
        // The web client polls this; a queued request is handed over once, then cleared.
        const nav = pendingNavigation;
        pendingNavigation = null;
        if (nav) logLine("nav-taken", { sessionId: nav.sessionId });
        sendJson(res, 200, { ok: true, sessionId: nav ? nav.sessionId : null });
        return;
      }
      sendJson(res, 404, { ok: false, error: "unknown action" });
    })().catch(() => sendJson(res, 500, { ok: false, error: "internal error" })),
  }), "border-collie-pet-route");
}

/** Append one diagnostic line next to the companion state (never throws). */
function logLine(kind, fields) {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "host.log"), JSON.stringify({ kind, ...fields, t: Date.now() }) + "\n", { flag: "a" });
  } catch { /* ignore */ }
}
