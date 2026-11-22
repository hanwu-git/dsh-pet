// Host side of the border-collie pet: a function-plugin (plain `apply(ctx)`), same shape as the
// prompt-polish plugin. NO bare imports of @deepseek-ai/* packages — a linked plugin's real file
// location (D:\obj\dsh-pet) has no node_modules carrying host internals, so those imports fail at
// activation (ERR_MODULE_NOT_FOUND). Instead we register ONE webServer route
// `/border-collie-pet/rpc` and dispatch actions ourselves; the client module calls it with
// fetch() through the DSH origin (cookie-authenticated via the connection trust fence).
// Task signals: ctx.on("agent/status"|"agent/error"|"session/event") — cordis function plugins
// receive the raw ctx, so these subscriptions need no imports either.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(fileURLToPath(import.meta.url));

export const name = "border-collie-pet-host";
/** Service fields the function plugin touches: webServer for the RPC route, connection for the
 * trust fence. Task signals arrive as plain ctx.on emissions, so no other fields are needed. */
export const inject = ["webServer", "connection"];
export const BUILD = "v1-pin-2026-11-22";

const stateDir = join(packageDir, ".companion");
const stateFile = join(stateDir, "state.json");
const cmdFile = join(stateDir, "cmd.json");
const PIN_FILE = join(stateDir, "pinned.json");
const SETTINGS_FILE = join(stateDir, "settings.json");

const DEFAULT_SETTINGS = { size: "large", sound: true };
const VALID_SIZES = ["large", "medium", "small"];

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

function writeState(patch) {
  try {
    mkdirSync(stateDir, { recursive: true });
    stateSeq += 1;
    // Preserve the owner field: the companion's orphan guard reads it on every poll.
    writeFileSync(stateFile, JSON.stringify({ ...patch, ...(ownerPid ? { owner: ownerPid } : {}), t: stateSeq }));
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
    return { size, sound };
  } catch { return { ...DEFAULT_SETTINGS }; }
}

/** Merge a partial patch, validate values, persist, and log. Returns the effective settings. */
function writeSettings(patch) {
  const current = readSettings();
  const next = {
    size: patch && VALID_SIZES.includes(patch.size) ? patch.size : current.size,
    sound: patch && typeof patch.sound === "boolean" ? patch.sound : current.sound,
  };
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(SETTINGS_FILE, JSON.stringify(next));
    logLine("settings", { size: next.size, sound: next.sound });
  } catch { /* ignore */ }
  return next;
}

function startCompanion() {
  if (companion && companion.exitCode === null && !companion.killed) return true;
  const python = resolvePython();
  if (!python) return false;
  try {
    mkdirSync(stateDir, { recursive: true });
    stateSeq = 0;
    // owner pid lets the companion detect an orphaned self: when the writing process dies,
    // the window closes itself instead of lingering as a ghost duplicate.
    ownerPid = process.pid;
    writeFileSync(stateFile, JSON.stringify({ t: 0, owner: ownerPid }));
    // Clear any stale command (e.g. a leftover quit from a previous run) BEFORE spawning:
    // the companion reads cmd.json on its first poll and would exit immediately otherwise.
    try { writeFileSync(cmdFile, ""); } catch { /* ignore */ }
    companion = spawn(python, [COMPANION, stateFile, cmdFile, PET_PNG], {
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

function readBoundedBody(req, max = 64 * 1024) {
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

  // Restore pin state from the previous run: if the user had pinned the pet, relaunch the
  // companion window when DSH starts (and again after every DSH restart).
  if (readPinnedFile()) {
    const result = setPinned(true);
    if (result.ok) logLine("auto-pin-restored", {});
  }

  // Task signals → companion window bubbles (only meaningful while pinned).
  ctx.on("agent/status", ({ agent, status }) => {
    if (!pinned) return;
    if (status === "running") {
      writeState({ run: { id: agent && agent.id, running: true } });
    } else {
      writeState({ runningEnd: { id: agent && agent.id } });
    }
  });
  ctx.on("agent/error", ({ agent, error }) => {
    if (!pinned) return;
    const message = String((error && error.message) || "执行出错").slice(0, 60);
    writeState({ fail: { id: agent && agent.id, message } });
  });
  ctx.on("session/event", (session, event) => {
    if (!pinned) return;
    if (event.type === "tool/call" && event.data && event.data.name === "ask_user_question") {
      writeState({ ask: { id: session.id } });
    } else if (event.type === "approval/asked") {
      writeState({ ask: { id: session.id, tool: String((event.data && event.data.toolName) || "") } });
    } else if (event.type === "approval/decided") {
      writeState({ askDone: { id: session.id } });
    }
  }, { global: true });

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
          size: s.size, sound: s.sound,
          // The settings UI and the pin tooltip explain a failed launch with this flag.
          python: !!resolvePython(),
          platform: process.platform,
        });
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
        sendJson(res, 200, { ok: true, ...writeSettings(value) });
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
