"""Border collie desktop companion: always-on-top pet window with task bubbles.

Usage: python companion.py <state.json> <cmd.json> <pet.png> [ownerPid]

The DSH host plugin writes task-state JSON; this window polls it and pops
colored bubbles over the dog's head:
  done = light green, fail = light red, ask (waiting for you) = light yellow.

Bubbles PERSIST until dismissed: clicking the dog calls the DSH main window to
the foreground and clears the bubble. A newer result replaces the previous
bubble's content (newest wins, one bubble at a time).

Size (large/medium/small) and bubble sound come from <state.json dir>/settings.json,
written by the host RPC and polled here so changes take effect immediately.

The optional 5th argument is the host process pid that spawned this window. The orphan
guard checks THAT pid, not state.json's `owner` (which a newer host overwrites).
"""
import json
import os
import sys
import tkinter as tk
from pathlib import Path

STATE_FILE = Path(sys.argv[1]) if len(sys.argv) > 1 else None
CMD_FILE = Path(sys.argv[2]) if len(sys.argv) > 2 else None
PET_FILE = Path(sys.argv[3]) if len(sys.argv) > 3 else None

# The pid of the DSH host that spawned THIS window, passed as the 5th argument. Remembered at
# launch time: a newer host overwrites state.json's `owner` with its own pid, so a stale window
# that re-reads state.json would see a live pid and wrongly believe it still has a host.
OWNER_PID = int(sys.argv[4]) if len(sys.argv) > 4 and str(sys.argv[4]).isdigit() else 0

POLL_MS = 400

KINDS = {
    "done": {"bg": "#e6f7e9", "border": "#5cb85c", "fg": "#1e6b2f", "label": "执行完成"},
    "fail": {"bg": "#fdeaea", "border": "#d9534f", "fg": "#8b1d1a", "label": "执行失败"},
    "ask": {"bg": "#fff8dc", "border": "#d4a017", "fg": "#7a5c00", "label": "等你确定"},
}

# Size -> PhotoImage.subsample factor. medium = 1/2 side (1/4 area), small = 1/3 side (1/9 area).
SIZE_TO_K = {"large": 1, "medium": 2, "small": 3}

# Per-scale geometry of the bubble and the head room reserved above the dog.
SCALES = {
    1: {"head": 64, "font": 11, "bw_min": 120, "bw_max": 320, "bw_char": 13,
        "bw_pad": 44, "bh": 36, "tail": 12, "corner": 7, "outline": 2},
    2: {"head": 32, "font": 9, "bw_min": 80, "bw_max": 220, "bw_char": 8,
        "bw_pad": 30, "bh": 24, "tail": 8, "corner": 5, "outline": 1},
    3: {"head": 21, "font": 8, "bw_min": 60, "bw_max": 160, "bw_char": 6,
        "bw_pad": 24, "bh": 20, "tail": 6, "corner": 4, "outline": 1},
}

# Bubble tone source. Prefer an explicit wav: the MB_ICONQUESTION "system question" event is
# UNBOUND on some Windows setups (HKCU AppEvents SystemQuestion .Current = ""), so
# MessageBeep(MB_ICONQUESTION) plays silence there while the other two tones still work.
# Each kind lists candidate wavs in priority order, then a MessageBeep fallback tone.
# NOTE on duration: ding.wav is only 0.40s and easy to miss at low volume, so the done tone
# leads with the 1.09s "Windows Ding" instead. fail/ask are already 0.90s / 1.29s.
SOUND_WAVS = {
    "done": ["C:/Windows/Media/Windows Ding.wav", "C:/Windows/Media/tada.wav",
             "C:/Windows/Media/chimes.wav", "C:/Windows/Media/ding.wav"],
    "fail": ["C:/Windows/Media/Windows Critical Stop.wav", "C:/Windows/Media/Windows Error.wav",
             "C:/Windows/Media/Windows Exclamation.wav"],
    "ask": ["C:/Windows/Media/Windows Notify.wav", "C:/Windows/Media/notify.wav",
            "C:/Windows/Media/Windows Notify System Generic.wav",
            "C:/Windows/Media/Windows Ding.wav"],
}
WINSOUND_KIND = {"done": "MB_OK", "fail": "MB_ICONERROR", "ask": "MB_ICONQUESTION"}


def read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def activate_dsh_window():
    """Bring the DSH main window to the foreground (best effort, never raises)."""
    try:
        import ctypes
        user32 = ctypes.windll.user32
        target = None

        def on_window(hwnd, _lparam):
            nonlocal target
            if user32.IsWindowVisible(hwnd):
                length = user32.GetWindowTextLengthW(hwnd)
                if length:
                    buf = ctypes.create_unicode_buffer(length + 1)
                    user32.GetWindowTextW(hwnd, buf, length + 1)
                    title = buf.value
                    if title.endswith("DeepSeek Harness"):
                        target = hwnd
                        return False
            return True

        WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
        user32.EnumWindows(WNDENUMPROC(on_window), 0)
        if target:
            # A background process cannot always SetForegroundWindow directly; the
            # standard dance: send an Alt key poke, restore if minimized, then set foreground.
            user32.keybd_event(0x12, 0, 0, 0)  # Alt down (unlocks SetForegroundWindow)
            try:
                if user32.IsIconic(target):
                    user32.ShowWindow(target, 9)  # SW_RESTORE
                user32.SetForegroundWindow(target)
            finally:
                user32.keybd_event(0x12, 0, 2, 0)  # Alt up (KEYEVENTF_KEYUP)
    except Exception:
        # Foreground focus is best-effort only; bubble still clears.
        pass


def play_bubble_sound(kind):
    """Play a bubble tone: an explicit wav first, MessageBeep as the fallback.

    The wav path matters for "ask": on setups where the Windows "system question" event has no
    wav bound, MessageBeep(MB_ICONQUESTION) is silent while MB_OK/MB_ICONERROR still beep.
    winsound.PlaySound is asynchronous (SND_ASYNC) so the 400ms poll loop is never blocked.
    """
    try:
        import winsound
    except Exception:
        return
    for path in SOUND_WAVS.get(kind, ()):
        try:
            if os.path.exists(path):
                winsound.PlaySound(path, winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_NODEFAULT)
                return
        except Exception:
            continue
    try:
        tone = getattr(winsound, WINSOUND_KIND.get(kind, "MB_OK"), winsound.MB_OK)
        winsound.MessageBeep(tone)
    except Exception:
        pass


class Companion(tk.Tk):
    def __init__(self):
        super().__init__()
        self.overrideredirect(True)
        self.attributes("-topmost", True)

        # Keep the full-resolution image; scaled views come from subsample() so switching
        # size is lossless and needs no extra image files.
        self.pet_full = tk.PhotoImage(file=str(PET_FILE)) if PET_FILE and PET_FILE.exists() else None
        self.scale = 1
        self.scale_cfg = SCALES[1]
        self.sound_on = True
        self.pet = None
        self.current_bubble = None  # (kind, text) kept so a size change can redraw it
        self.settings_file = STATE_FILE.parent / "settings.json" if STATE_FILE else None
        self.settings_mtime = None

        art_w = self.pet_full.width() if self.pet_full else 300
        art_h = self.pet_full.height() if self.pet_full else 272
        self.total_w = art_w
        self.total_h = art_h + self.scale_cfg["head"]

        self.geometry(f"{self.total_w}x{self.total_h}+0+0")

        # Transparent key color: pure magenta never appears in the artwork. The image file
        # (pet-flat.png) is pre-flattened against this exact color at build time, so tkinter's
        # key-color compositing never blends semi-transparent edge pixels live — no purple halo.
        key = "#FF00FF"
        self.configure(bg=key)
        self.canvas = tk.Canvas(self, width=self.total_w, height=self.total_h,
                                bg=key, highlightthickness=0)
        self.canvas.pack()
        # Without this the window paints as an opaque magenta rectangle. It must be re-applied
        # after every resize: on some Windows builds a geometry change drops the layered-window
        # color key, which showed up as a pink block around the dog at medium/small size.
        self.attributes("-transparentcolor", key)

        self.bubble_items = []
        self.bubble_kind = None
        self.last_state_t = 0
        self._press = None  # (px, py, wx, wy): pointer offset in window + window pos at press

        # Status light: a small dot at the dog's top-right corner, on iff a task is running.
        self.status_dot = None
        self.active = False

        self.build_pet_image()
        self.bind_pet_events()
        self.handle_settings()
        self.position_default()
        self.after(POLL_MS, self.poll)

    # ---- size / image --------------------------------------------------------

    def build_pet_image(self):
        k = self.scale
        self.canvas.delete("pet")
        self.pet = self.pet_full.subsample(k, k) if self.pet_full else None
        art_w = self.pet.width() if self.pet else 300 // k
        art_h = self.pet.height() if self.pet else 272 // k
        self.art_w, self.art_h = art_w, art_h
        self.total_w = art_w
        self.total_h = art_h + self.scale_cfg["head"]
        self.canvas.config(width=self.total_w, height=self.total_h)
        self.canvas.create_image(0, self.scale_cfg["head"], image=self.pet, anchor="nw", tags="pet")

    def bind_pet_events(self):
        self.canvas.tag_bind("pet", "<Button-1>", self.on_press)
        self.canvas.tag_bind("pet", "<B1-Motion>", self.on_move)
        self.canvas.tag_bind("pet", "<ButtonRelease-1>", self.on_release)

    def apply_size(self, k):
        """Resize to scale k, keeping the window's TOP-LEFT corner fixed, then redraw
        the current bubble (silently) at the new scale.

        IMPORTANT: read the SCREEN-ABSOLUTE position via winfo_rootx/rooty. For an
        overrideredirect + -topmost window winfo_x/y is the parent-relative offset and
        drifts when the WM repositions on canvas resize; root coords stay stable.
        """
        sx, sy = self.winfo_rootx(), self.winfo_rooty()
        bubble = self.current_bubble
        self.clear_bubble()
        self.scale = k
        self.scale_cfg = SCALES[k]
        self.build_pet_image()       # canvas.config changes the window size
        self.bind_pet_events()
        self.update_idletasks()      # let the WM settle the resize before re-pinning
        self.geometry(f"{self.total_w}x{self.total_h}+{sx}+{sy}")
        # Re-assert the color key after a resize: a geometry change can drop it on some
        # Windows builds, which painted the window as an opaque pink block.
        try:
            self.attributes("-transparentcolor", "#FF00FF")
            self.configure(bg="#FF00FF")
            self.canvas.configure(bg="#FF00FF")
        except Exception:
            pass
        if bubble:
            # bubble = (kind, text, session_id)
            self.show_bubble(bubble[0], bubble[1], bubble[2] if len(bubble) > 2 else None,
                             play_sound=False)
        # Redraw the status light at the new scale (its position/size depends on scale).
        self.set_active(self.active)

    def handle_settings(self):
        """Poll settings.json; apply size/sound changes as soon as the file changes."""
        if not self.settings_file or not self.settings_file.exists():
            return
        try:
            mtime = self.settings_file.stat().st_mtime_ns
        except Exception:
            return
        if mtime == self.settings_mtime:
            return
        self.settings_mtime = mtime
        s = read_json(self.settings_file)
        size = s.get("size", "large")
        sound = s.get("sound", True)
        if not isinstance(sound, bool):
            sound = True
        k = SIZE_TO_K.get(size, 1)
        if k != self.scale:
            self.apply_size(k)
        self.sound_on = sound

    def position_default(self):
        sw = self.winfo_screenwidth()
        sh = self.winfo_screenheight()
        self.geometry(f"+{sw - self.total_w - 24}+{max(48, sh - self.total_h - 120)}")

    def on_press(self, event):
        # Record the WINDOW's screen-absolute position at press + pointer offset inside
        # the window (root coords are stable for an overrideredirect window).
        self._press = (event.x, event.y, self.winfo_rootx(), self.winfo_rooty())

    def on_move(self, event):
        if not self._press:
            return
        px, py, wx, wy = self._press
        self.geometry(f"+{wx + (self.winfo_pointerx() - (wx + px))}+{wy + (self.winfo_pointery() - (wy + py))}")

    def on_release(self, event):
        if not self._press:
            return
        px, py, wx, wy = self._press
        self._press = None
        dx = abs(self.winfo_pointerx() - (wx + px))
        dy = abs(self.winfo_pointery() - (wy + py))
        if dx + dy <= 6:
            # Click (not drag): if a bubble with a session id is showing, queue a navigation
            # to that conversation via cmd.json; always call DSH to the front, then clear bubble.
            if self.bubble_items:
                sid = self.current_bubble[2] if self.current_bubble and len(self.current_bubble) > 2 else None
                if sid:
                    self.queue_navigation(sid)
                self.clear_bubble()
                self.current_bubble = None
            activate_dsh_window()

    def queue_navigation(self, session_id):
        """Ask the host (via cmd.json) to have the web client open this conversation."""
        try:
            import time
            CMD_FILE.write_text(json.dumps({
                "kind": "navigate", "sessionId": str(session_id), "t": int(time.time() * 1000),
            }), encoding="utf-8")
        except Exception:
            pass

    # ---- status light --------------------------------------------------------

    def set_active(self, active):
        """Show/hide a small green dot at the dog's top-right corner. On iff a task is running.
        The dot is a canvas item inside the window, so it never affects dragging or the color key."""
        self.active = bool(active)
        if self.status_dot is not None:
            try:
                self.canvas.delete(self.status_dot)
            except Exception:
                pass
            self.status_dot = None
        if not self.active:
            return
        r = {1: 6, 2: 4, 3: 3}.get(self.scale, 6)
        # Place just inside the top-right corner of the artwork.
        x = self.total_w - r - 4
        y = self.scale_cfg["head"] + r + 4
        self.status_dot = self.canvas.create_oval(
            x - r, y - r, x + r, y + r,
            fill="#5cb85c", outline="#1e6b2f", width=1, tags="statusdot")

    # ---- bubbles -------------------------------------------------------------

    def clear_bubble(self):
        for item in self.bubble_items:
            self.canvas.delete(item)
        self.bubble_items = []
        self.bubble_kind = None

    def show_bubble(self, kind, text, session_id=None, play_sound=True):
        # Newer results REPLACE the previous bubble's content (no auto-dismiss).
        # session_id is remembered so a click can navigate DSH to this conversation.
        self.clear_bubble()
        cfg = self.scale_cfg
        colors = KINDS[kind]
        cx = self.total_w // 2
        bubble_w = max(cfg["bw_min"], min(cfg["bw_max"], cfg["bw_char"] * len(text) + cfg["bw_pad"]))
        bh = cfg["bh"]
        x0 = cx - bubble_w // 2
        y0 = 6
        x1 = x0 + bubble_w
        y1 = y0 + bh
        tail_y = y1 + cfg["tail"]
        corner = cfg["corner"]

        self.bubble_items.append(self.canvas.create_rectangle(
            x0, y0, x1, y1, fill=colors["bg"], outline=colors["border"], width=cfg["outline"]))
        self.bubble_items.append(self.canvas.create_polygon(
            cx - corner, y1 - 1, cx + corner, y1 - 1, cx, tail_y,
            fill=colors["bg"], outline=colors["border"]))
        self.bubble_items.append(self.canvas.create_text(
            cx, (y0 + y1) // 2, text=text, fill=colors["fg"],
            font=("Microsoft YaHei UI", cfg["font"], "bold")))
        self.bubble_kind = kind
        self.current_bubble = (kind, text, session_id)
        if play_sound and self.sound_on:
            play_bubble_sound(kind)

    # ---- polling -------------------------------------------------------------

    def poll(self):
        self.handle_cmds()
        self.handle_settings()
        self.handle_state()
        self.check_owner()
        self.after(POLL_MS, self.poll)

    def check_owner(self):
        """Orphan guard: if the DSH host that spawned THIS window has died, close quietly.

        Uses the pid captured at launch (OWNER_PID) rather than state.json's `owner` field:
        a newer host overwrites that field, which would leave a stale window alive.
        """
        owner = OWNER_PID
        if not owner:
            return
        try:
            import ctypes
            k32 = ctypes.windll.kernel32
            handle = k32.OpenProcess(0x1000, False, int(owner))  # PROCESS_QUERY_LIMITED_INFORMATION
            if not handle:
                self.destroy()
                os._exit(0)
            k32.CloseHandle(handle)
        except Exception:
            pass

    def handle_cmds(self):
        if not CMD_FILE or not CMD_FILE.exists():
            return
        cmd = read_json(CMD_FILE)
        if cmd.get("kind") == "quit":
            self.destroy()
            os._exit(0)
        if cmd.get("kind") == "navigate":
            # This command is for the HOST (it forwards to the web client). Do NOT clear it —
            # the companion itself writes it and the host polls/clears it.
            return
        # Empty / unknown command: clear so a stale quit cannot replay after a restart.
        try:
            CMD_FILE.write_text("", encoding="utf-8")
        except Exception:
            pass

    def handle_state(self):
        if not STATE_FILE or not STATE_FILE.exists():
            return
        state = read_json(STATE_FILE)
        t = state.get("t", 0)
        if t == self.last_state_t:
            return
        self.last_state_t = t

        # Status light reflects the authoritative `active` flag written by the host
        # (true iff any session is running). It is present on every write now.
        if "active" in state:
            self.set_active(state["active"])

        # Result bubbles (each carries a session id so a click can navigate there).
        if "test" in state:
            kind = state["test"].get("kind", "done")
            self.show_bubble(kind, KINDS[kind]["label"])
            return
        if "fail" in state:
            msg = state["fail"].get("message", "")
            text = "执行失败：" + msg[:24] if msg else "执行失败"
            self.show_bubble("fail", text, state["fail"].get("id"))
            return
        if "ask" in state:
            self.show_bubble("ask", "等你确定", state["ask"].get("id"))
            return
        if "runningEnd" in state:
            self.show_bubble("done", "执行完成", state["runningEnd"].get("id"))


def main():
    if not PET_FILE or not PET_FILE.exists():
        print("pet image missing", file=sys.stderr)
        return 1
    app = Companion()
    app.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
