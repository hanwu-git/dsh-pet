// KuroCat bridge: forwards DSH task-state events to a locally running KuroCat desktop cat
// (https://github.com/qianyiai/KuroCat). KuroCat exposes POST /hook on 127.0.0.1 (default
// port 27420) and turns {"status": "...", "text": "..."} payloads into cat animations and
// bubbles — working = typing, done = happy, error = angry, waiting = waiting bubble.
//
// Design rules:
// - Zero cost when KuroCat is absent: every forward probes /health with a 250ms timeout
//   first; a failed probe just skips and the caller never notices.
// - Never blocks the host event loop longer than ~500ms: fire-and-forget POSTs.
// - Coalesces bursts: multiple agents finishing in the same 500ms window produce ONE
//   bubble instead of a flicker storm.
// - Optional sidecar lifecycle: when settings.kurocatAutostart is set and the user picks
//   the KuroCat pet mode, the bridge can spawn/stop the KuroCat.exe process itself.

import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_PORT = 27420;
// dsh-pet v2.0: the vendored pet uses the 27430+ range so a user-installed official
// KuroCat (27420) can coexist. `dataDir` is injected by the host for persistence.
const EMBEDDED_PORT_BASE = 27430;
// KuroCat NSIS install location (per-user first, then system-wide). Only used for the
// optional sidecar autostart; plain forwarding does not need the exe at all.
const KURO_EXE_CANDIDATES = [
  join(process.env.LOCALAPPDATA ?? "", "KuroCat", "KuroCat.exe"),
  join(process.env["ProgramFiles"] ?? "", "KuroCat", "KuroCat.exe"),
];

let state = {
  enabled: true,
  port: DEFAULT_PORT,
  autostart: false,
  dataDir: null,
};

let sidecarProc = null;
// Event coalescing: the latest payload per kind wins; a single timer flushes them together.
const pending = new Map();
let flushTimer = null;

/** Find a free port starting at `base` (TCP bind probe, immediately released). */
function findFreePort(base) {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.once("error", () => resolve(findFreePort(base + 1)));
    srv.once("listening", () => { const port = srv.address().port; srv.close(() => resolve(port)); });
    srv.listen(base, "127.0.0.1");
  });
}

function kuroExe() {
  for (const p of KURO_EXE_CANDIDATES) {
    try { if (p && existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

function probe(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/health", timeout: 250 },
      (res) => { res.resume(); resolve(res.statusCode === 200); },
    );
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  });
}

/** Fire-and-forget POST. Resolves true when the request was dispatched (not necessarily 2xx). */
function post(port, path, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        host: "127.0.0.1", port, path, method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        timeout: 500,
      },
      (res) => { res.resume(); resolve(true); },
    );
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
    req.end(body);
  });
}

/** Apply a settings patch coming from the host (validated there). */
export function configure(patch) {
  if (!patch || typeof patch !== "object") return { ...state };
  if (typeof patch.kurocat === "boolean") state.enabled = patch.kurocat;
  if (Number.isInteger(patch.kurocatPort) && patch.kurocatPort > 0 && patch.kurocatPort < 65536) {
    state.port = patch.kurocatPort;
  }
  if (typeof patch.kurocatAutostart === "boolean") state.autostart = patch.kurocatAutostart;
  if (typeof patch.dataDir === "string" && patch.dataDir) state.dataDir = patch.dataDir;
  if (typeof patch.embeddedExe === "string" && patch.embeddedExe && existsSync(patch.embeddedExe)) {
    state.embeddedExe = patch.embeddedExe;
  }
  return { ...state };
}

export function getState() {
  return { ...state, exeFound: !!kuroExe() };
}

/** dsh-pet task event → KuroCat /hook payload. kind ∈ runningStart|runningEnd|fail|ask */
export function bridgeEvent(kind, detail = {}) {
  if (!state.enabled) return false;
  const map = {
    runningStart: { status: "working", source: "DSH", text: detail.text || "任务执行中…", autoType: true, ttlMs: 45_000, sound: false },
    runningEnd:   { status: "done",    source: "DSH", text: detail.text || "执行完成", ttlMs: 6_500, sound: true },
    fail:         { status: "error",   source: "DSH", text: ("执行失败：" + (detail.message || "")).slice(0, 72), ttlMs: 8_500, sound: true },
    ask:          { status: "waiting", source: "DSH", text: detail.text || "等你确认", ttlMs: 90_000, sound: true },
  };
  const payload = map[kind];
  if (!payload) return false;
  pending.set(kind, payload);
  if (!flushTimer) flushTimer = setTimeout(flush, 500);
  return true;
}

async function flush() {
  flushTimer = null;
  const batch = [...pending.values()];
  pending.clear();
  if (batch.length === 0) return;
  if (!(await probe(state.port))) return;
  // Only the LAST event of the batch matters for the cat (its UI is single-bubble);
  // but all of them are cheap to send, so forward the last one only to avoid flicker.
  await post(state.port, "/hook", batch[batch.length - 1]);
}

// ---- optional sidecar lifecycle ---------------------------------------------

/** Start the pet exactly ONCE per machine. Order of preference:
 * 1. Anything already answering on the configured port (official OR embedded) → adopt it.
 * 2. The vendored embedded exe (state.embeddedExe) on a free 27430+ port.
 * 3. The user-installed official KuroCat.exe.
 * The spawned process is detached: it can outlive DSH (standalone mode) — termination is
 * the user's explicit choice at DSH exit, not an automatic kill. */
export async function startSidecar() {
  if (!state.enabled) return { ok: false, reason: "bridge disabled" };
  if (sidecarProc && sidecarProc.exitCode === null) return { ok: true, adopted: false };
  // Single-instance: adopt anything already listening on our port.
  if (await probe(state.port)) return { ok: true, adopted: true };
  const candidates = [];
  if (state.embeddedExe) candidates.push(state.embeddedExe);
  const official = kuroExe();
  if (official) candidates.push(official);
  if (candidates.length === 0) return { ok: false, reason: "no pet exe found" };
  const port = await findFreePort(EMBEDDED_PORT_BASE);
  for (const exe of candidates) {
    try {
      sidecarProc = spawn(exe, ["--dsh-port", String(port)], {
        detached: true,
        windowsHide: false,
        stdio: "ignore",
      });
      sidecarProc.unref();
      state.port = port;
      // Wait up to 6s for the pet to bind its port.
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 400));
        if (await probe(state.port)) return { ok: true, adopted: false, exe, port };
      }
    } catch { /* try next candidate */ }
  }
  sidecarProc = null;
  return { ok: false, reason: "spawn failed or port never became ready" };
}

/** Terminate the pet process we spawned (only when the user chose "close" at DSH exit,
 * or an explicit stop is requested). An adopted instance is never killed from here. */
export function stopSidecar() {
  if (sidecarProc && sidecarProc.exitCode === null) {
    try { sidecarProc.kill(); } catch { /* ignore */ }
    sidecarProc = null;
  }
}

/** Probe + state for the settings page status display. */
export async function status() {
  const online = state.enabled ? await probe(state.port) : false;
  return {
    enabled: state.enabled,
    port: state.port,
    autostart: state.autostart,
    online,
    exeFound: !!kuroExe(),
    // True when the running instance was spawned by THIS plugin (we own its lifecycle
    // and may terminate it on DSH exit, subject to the user's exit-choice prompt).
    spawnedByUs: online && sidecarProc !== null && sidecarProc.exitCode === null,
  };
}

// ---------------------------------------------------------------------------
// Single-instance + exit coordination (dsh-pet v2.0 requirements):
// - The pet may run fully standalone; DSH attaches to an already-running instance.
// - Only ONE pet process per machine: spawn is skipped when a probe already answers.
// - On DSH exit the pet is NOT force-killed: the client asks the user, and the
//   choice ("close" / "keep running") is persisted so future exits skip the prompt.
// ---------------------------------------------------------------------------

const EXIT_CHOICE_FILE = () => join(state.dataDir ?? "", "kurocat-exit-choice.json");

function readExitChoice() {
  try {
    const raw = JSON.parse(readFileSync(EXIT_CHOICE_FILE(), "utf8"));
    return raw.choice === "close" || raw.choice === "keep" ? raw.choice : null;
  } catch { return null; }
}

export function rememberExitChoice(choice) {
  try {
    mkdirSync(state.dataDir, { recursive: true });
    writeFileSync(EXIT_CHOICE_FILE(), JSON.stringify({ choice: choice || null, t: Date.now() }));
  } catch { /* ignore */ }
}

export function getExitChoice() {
  return readExitChoice();
}
