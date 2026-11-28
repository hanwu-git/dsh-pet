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
import { execFileSync, spawn } from "node:child_process";
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

/** Apply a settings patch coming from the host (validated there). Legacy kurocat* keys are
 *  still accepted so an older host build keeps working during upgrades. */
export function configure(patch) {
  if (!patch || typeof patch !== "object") return { ...state };
  const enabled = typeof patch.petBridge === "boolean" ? patch.petBridge : patch.kurocat;
  if (typeof enabled === "boolean") state.enabled = enabled;
  const port = Number.isInteger(patch.petPort) ? patch.petPort : patch.kurocatPort;
  if (Number.isInteger(port) && port > 0 && port < 65536) state.port = port;
  const autostart = typeof patch.petAutostart === "boolean" ? patch.petAutostart : patch.kurocatAutostart;
  if (typeof autostart === "boolean") state.autostart = autostart;
  if (typeof patch.dataDir === "string" && patch.dataDir) state.dataDir = patch.dataDir;
  if (typeof patch.onLog === "function") state.onLog = patch.onLog;
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
    // Completion/failure notices are the ones the user must actually SEE, so they linger
    // longer than the upstream defaults (6.5s/8.5s were easy to miss while reading the chat).
    runningEnd:   { status: "done",    source: "DSH", text: detail.text || "执行完成", ttlMs: 20_000, sound: true },
    fail:         { status: "error",   source: "DSH", text: ("执行失败：" + (detail.message || "")).slice(0, 72), ttlMs: 20_000, sound: true },
    ask:          { status: "waiting", source: "DSH", text: detail.text || "等你确认", ttlMs: 90_000, sound: true },
  };
  const payload = map[kind];
  if (!payload) return false;
  // Carry the session id so the pet's bubble can jump back to that conversation on click.
  if (detail.sessionId) payload.sessionId = String(detail.sessionId);
  if (kind === "runningStart") running = true;
  if (kind === "runningEnd" || kind === "fail") running = false;
  pending.set(kind, payload);
  if (!flushTimer) flushTimer = setTimeout(flush, 500);
  return true;
}

// ---- persistent "working" state -------------------------------------------------
// Requirement: while DSH has ANY running task, the cat keeps a bubble on screen — and
// after a newer notice (done/error/waiting) is dismissed, the working bubble comes BACK
// if the task is still running. The DSH host therefore (a) sends runningStart once, and
// (b) re-asserts the state whenever the pet asks (GET /dsh/state) or periodically via
// this heartbeat, so the pet can restore the bubble after a dismissal or a restart.
let running = false;
/** True while at least one DSH agent is running (bridge's own view). */
export function isRunning() {
  return running;
}
/** Snapshot for the pet: what should the bubble say right now, if anything? */
export function stateSnapshot() {
  if (!running) return { running: false };
  return {
    running: true,
    status: "working",
    source: "DSH",
    text: "任务执行中…",
    autoType: true,
    ttlMs: 45_000,
    sound: false,
  };
}

// ---- pet → host callback listener ------------------------------------------------
// The pet posts to /dsh/notify when the user dismisses a notice bubble, or when it wants
// the current state. The host keeps a polled queue (same pattern as take-navigation)
// so the web client can act on it.
let petStateQuery = false;
export function takePetStateQuery() {
  const v = petStateQuery;
  petStateQuery = false;
  return v;
}

/** Handle a POST body from the pet's /dsh/notify endpoint. Fire-and-forget. */
export function handlePetNotify(body) {
  if (!body || typeof body !== "object") return false;
  if (body.kind === "dismissed" || body.kind === "state-query") {
    petStateQuery = true;
    return true;
  }
  return false;
}

/** Session id queued by a bubble click inside the pet, if any. The pet's own loopback server
 *  exposes GET /dsh/pending-nav which it clears on read (one delivery per click). */
export async function takePendingNavigation() {
  if (!(await probe(state.port))) return null;
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port: state.port, path: "/dsh/pending-nav", timeout: 400 },
      (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          try {
            const v = JSON.parse(body);
            resolve(v && typeof v.sessionId === "string" && v.sessionId ? v.sessionId : null);
          } catch { resolve(null); }
        });
      },
    );
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

async function flush() {
  flushTimer = null;
  const batch = [...pending.values()];
  pending.clear();
  if (batch.length === 0) return;
  if (!(await probe(state.port))) {
    // Pet not reachable: drop the batch (it would be stale by the time it comes back) but
    // leave a trace — otherwise "no bubble appeared" is indistinguishable from "never sent".
    if (state.onLog) state.onLog("bridge-skip-offline", { events: batch.map((b) => b.status).join(",") });
    return;
  }
  // Only the LAST event of the batch matters for the cat (its UI is single-bubble);
  // but all of them are cheap to send, so forward the last one only to avoid flicker.
  const last = batch[batch.length - 1];
  const ok = await post(state.port, "/hook", last);
  if (state.onLog) {
    state.onLog("bridge-forward", {
      status: last.status, text: last.text, ttlMs: last.ttlMs, ok: !!ok,
      coalesced: batch.length,
    });
  }
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

/** Terminate the pet process. Two cases:
 * - A pet WE spawned: kill the tracked handle directly.
 * - An ADOPTED instance (already running when we attached, or started standalone): we hold
 *   no handle, so on Windows resolve the PID that owns the pet port and terminate its tree.
 *   Called only for explicit stop actions — pet-mode switch back to collie, the settings
 *   page stop button, and the DSH-exit "close" choice — never on a mere re-attach. */
export function stopSidecar() {
  if (sidecarProc && sidecarProc.exitCode === null) {
    try { sidecarProc.kill(); } catch { /* ignore */ }
    sidecarProc = null;
  }
  // Adopted instance: no handle to kill, so stop whatever answers on the pet port.
  killByPort(state.port);
}

/** Best-effort Windows helper: find the PID LISTENING on `port` and terminate its tree.
 *  Uses `netstat -ano` (always present on Windows) plus `taskkill /T /F`; every step is
 *  guarded so a missing tool or an already-gone process never throws. No-op off Windows. */
function killByPort(port) {
  if (process.platform !== "win32") return false;
  try {
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    const lines = out.split(/\r?\n/);
    for (const line of lines) {
      // TCP    127.0.0.1:27430    0.0.0.0:0    LISTENING    6080
      const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/.exec(line.trim());
      if (!m || Number(m[1]) !== port) continue;
      const pid = Number(m[2]);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try {
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5000, stdio: "ignore" });
        return true;
      } catch { /* process may have exited between netstat and taskkill */ }
    }
  } catch { /* netstat unavailable or timed out — nothing we can do */ }
  return false;
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
