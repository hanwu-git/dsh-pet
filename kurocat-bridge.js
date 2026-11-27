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
import { existsSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_PORT = 27420;
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
};

let sidecarProc = null;
// Event coalescing: the latest payload per kind wins; a single timer flushes them together.
const pending = new Map();
let flushTimer = null;

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

/** Start KuroCat.exe if configured and not already running. Returns {ok, reason?}. */
export async function startSidecar() {
  if (!state.enabled) return { ok: false, reason: "bridge disabled" };
  if (sidecarProc && sidecarProc.exitCode === null) return { ok: true };
  const exe = kuroExe();
  if (!exe) return { ok: false, reason: "KuroCat.exe not found" };
  if (await probe(state.port)) return { ok: true }; // already running independently
  try {
    sidecarProc = spawn(exe, [], { detached: true, windowsHide: false, stdio: "ignore" });
    sidecarProc.unref();
    // Give it a moment to bind the port before the first event arrives.
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 400));
      if (await probe(state.port)) return { ok: true };
    }
    return { ok: false, reason: "started but port not ready" };
  } catch {
    sidecarProc = null;
    return { ok: false, reason: "spawn failed" };
  }
}

/** Ask a locally running KuroCat to quit via taskkill (it has no documented quit endpoint). */
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
  };
}
