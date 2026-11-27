// Client: page widget + pin toggle. The pin toggle now calls the Host HTTP route
// /border-collie-pet/rpc (fetch, same-origin, cookie-authenticated) instead of the
// typert remote namespace — see pet-service.js for the host side.
window.__ModuleLoader__.load({
  id: 'dsh-border-collie-pet',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // The pet artwork, embedded at build time from pet.png. Used when the user has not
    // uploaded a custom image (settings.image === 'default').
    const PET_IMG = '%PET_IMG%';

    const RPC_PATH = '/border-collie-pet/rpc';
    const PIN_KEY = 'border-collie-pet:pinned';
    // Mirrors settings.image from the host; updated by the Pet widget polling the status RPC.
    let currentImageMode = 'default';
    let customImageUrl = null; // data URL of the uploaded image, fetched on demand

    async function loadCustomImageUrl() {
      if (customImageUrl) return customImageUrl;
      const r = await rpc('get-image');
      customImageUrl = (r && r.image) || null;
      return customImageUrl;
    }

    async function resolvePetImage() {
      if (currentImageMode !== 'custom') return PET_IMG;
      return (await loadCustomImageUrl()) || PET_IMG;
    }

    async function rpc(action, extra) {
      const res = await fetch(RPC_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...(extra || {}) }),
        credentials: 'same-origin',
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
      return data;
    }

    function readPinned() {
      try { return localStorage.getItem(PIN_KEY) === '1'; } catch (e) { return false; }
    }
    function savePinned(v) {
      try { localStorage.setItem(PIN_KEY, v ? '1' : '0'); } catch (e) { /* ignore */ }
    }

    const ART_W = 300;
    const ART_H = 272;
    const HEAD_ROOM = 64;

    /** Fit an image into the ART_W × ART_H box, preserving aspect ratio, without upscaling. */
    function fitDimensions(w, hh) {
      const scale = Math.min(1, ART_W / w, ART_H / hh);
      return { w: Math.max(1, Math.round(w * scale)), hh: Math.max(1, Math.round(hh * scale)) };
    }

    function PinButton({ pinned, busy, onClick }) {
      const colors = pinned
        ? { bg: '#d4a017', fg: '#ffffff', border: '#a87f0e' }
        : { bg: 'rgba(255,255,255,0.92)', fg: '#5a5a5a', border: '#c9c9c9' };
      return h('button', {
        title: pinned ? '取消固定桌面（恢复页内宠物）' : '固定到桌面：DSH 最小化后宠物仍显示在最前面',
        onClick,
        disabled: busy,
        style: {
          position: 'absolute',
          right: 2,
          top: 2,
          width: 26,
          height: 26,
          borderRadius: '50%',
          border: '1px solid ' + colors.border,
          background: colors.bg,
          color: colors.fg,
          font: 'bold 13px/1 sans-serif',
          cursor: busy ? 'wait' : 'pointer',
          zIndex: 5,
          boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
          padding: 0,
          lineHeight: '24px',
          textAlign: 'center',
        },
      }, busy ? '…' : '\u{1F4CC}');
    }

    function Pet({ ctxRemote }) {
      const [pinned, setPinned] = React.useState(readPinned);
      const [busy, setBusy] = React.useState(false);
      const [err, setErr] = React.useState('');

      // Pet artwork: 'default' shows the embedded border collie; 'custom' shows the
      // user-uploaded image. Poll status for changes made in the settings page.
      const [petSrc, setPetSrc] = React.useState(PET_IMG);
      const [petDim, setPetDim] = React.useState({ w: ART_W, hh: ART_H });
      const imageModeRef = React.useRef('default');

      React.useEffect(() => {
        let stopped = false;
        const check = async () => {
          try {
            const r = await rpc('status');
            if (stopped || !r || r.ok === false) return;
            const mode = r.image === 'custom' && r.hasCustomImage ? 'custom' : 'default';
            if (mode !== imageModeRef.current) {
              imageModeRef.current = mode;
              currentImageMode = mode;
              const src = await resolvePetImage();
              if (stopped) return;
              if (src === PET_IMG) {
                setPetSrc(PET_IMG);
                setPetDim({ w: ART_W, hh: ART_H });
              } else {
                // Measure the uploaded image so it fits the box without distortion.
                const probe = new Image();
                probe.onload = () => {
                  if (!stopped) setPetDim(fitDimensions(probe.naturalWidth, probe.naturalHeight));
                };
                probe.src = src;
                setPetSrc(src);
              }
            }
          } catch (e) { /* transient RPC failure; retry next tick */ }
        };
        check();
        const timer = setInterval(check, 2000);
        return () => { stopped = true; clearInterval(timer); };
      }, []);

      // Session labels for friendlier bubbles (page mode) via forwarded remote events.
      const [notice, setNotice] = React.useState(null);
      const hideTimer = React.useRef(null);
      const sessionLabel = React.useRef(new Map());

      const showNotice = React.useCallback((kind, text) => {
        setNotice({ kind, text });
        if (hideTimer.current) clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(() => setNotice(null), 6000);
      }, []);

      React.useEffect(() => {
        if (!ctxRemote) return undefined;
        const disposers = [];
        try {
          disposers.push(ctxRemote.$on('api-session/status', (sessionId, running) => {
            if (running) return;
            const t = sessionLabel.current.get(String(sessionId));
            showNotice('done', (t ? t + ' ' : '') + '执行完成');
          }));
        } catch (e) { /* remote events unavailable */ }
        try {
          disposers.push(ctxRemote.$on('api-session/error', (sessionId, message) => {
            const t = sessionLabel.current.get(String(sessionId));
            showNotice('fail', (t ? t + ' ' : '') + '执行失败' + (message ? '：' + String(message).slice(0, 40) : ''));
          }));
        } catch (e) { /* remote events unavailable */ }
        try {
          disposers.push(ctxRemote.$on('user-questions/request', function (request, next) {
            const t = sessionLabel.current.get(String(request && request.sessionId || ''));
            showNotice('ask', (t ? t + ' ' : '') + '等你确定');
            return next();
          }));
        } catch (e) { /* remote events unavailable */ }
        try {
          disposers.push(ctxRemote.$on('api-session/added', (summary) => {
            if (!summary || !summary.sessionId) return;
            const cwd = summary.cwd;
            const label = cwd ? String(cwd).split(/[\\/]/).filter(Boolean).pop() : '';
            sessionLabel.current.set(String(summary.sessionId), label || '任务');
          }));
        } catch (e) { /* ignore */ }
        return () => { disposers.forEach(d => { try { d(); } catch (e) { /* ignore */ } }); };
      }, [ctxRemote, showNotice]);

      React.useEffect(() => {
        if (!err) return;
        const t = setTimeout(() => setErr(''), 4000);
        return () => clearTimeout(t);
      }, [err]);

      const togglePin = React.useCallback(async () => {
        if (busy) return;
        setBusy(true);
        setErr('');
        const target = !pinned;
        try {
          const result = await rpc('pin', { value: target });
          if (result.ok === false) {
            setErr(String(result.error || '固定失败'));
          } else {
            setPinned(target);
            savePinned(target);
          }
        } catch (e) {
          setErr('固定失败：' + (e && e.message ? e.message : '请求不可用'));
        } finally {
          setBusy(false);
        }
      }, [pinned, busy]);

      if (pinned) {
        // Desktop companion is active; the in-page pet hides to avoid duplication.
        // Keep the pin button visible so the user can un-pin.
        return h('div', {
          id: 'border-collie-pet-widget',
          style: {
            position: 'fixed',
            right: 24,
            bottom: 24,
            width: 32,
            height: 32,
            zIndex: 2147483000,
            pointerEvents: 'auto',
          },
        },
          h(PinButton, { pinned, busy, onClick: togglePin }),
          err ? h('div', {
            style: {
              position: 'fixed',
              right: 8,
              bottom: 64,
              background: '#fdeaea',
              border: '1px solid #d9534f',
              color: '#8b1d1a',
              font: '12px/1.4 sans-serif',
              padding: '4px 10px',
              borderRadius: 8,
              whiteSpace: 'nowrap',
            },
          }, err) : null,
        );
      }

      return h('div', {
        id: 'border-collie-pet-widget',
        style: {
          position: 'fixed',
          right: 24,
          bottom: 24,
          width: petDim.w,
          height: petDim.hh + HEAD_ROOM,
          zIndex: 2147483000,
          userSelect: 'none',
          pointerEvents: 'auto',
        },
      },
        h('img', {
          src: petSrc,
          alt: 'pet',
          draggable: false,
          style: {
            position: 'absolute',
            left: 0,
            top: HEAD_ROOM,
            width: petDim.w,
            height: petDim.hh,
            objectFit: 'contain',
            pointerEvents: 'none',
            userSelect: 'none',
          },
        }),
        h(PinButton, { pinned, busy, onClick: togglePin }),
        h('div', {
          style: {
            position: 'absolute',
            left: '50%',
            top: 0,
            transform: 'translateX(-50%)',
            maxWidth: 260,
            background: '#ffffff',
            borderRadius: '10px',
            boxShadow: '0 3px 12px rgba(0,0,0,0.35)',
            padding: 2,
            pointerEvents: 'none',
            opacity: notice && notice.text ? 1 : 0,
            transition: 'opacity 0.2s ease-out',
            zIndex: 3,
          },
        },
          h('div', {
            style: {
              background: notice && (notice.kind === 'fail' ? '#fdeaea' : notice.kind === 'ask' ? '#fff8dc' : '#e6f7e9'),
              border: '1px solid ' + (notice && notice.kind === 'fail' ? '#d9534f' : notice && notice.kind === 'ask' ? '#d4a017' : '#5cb85c'),
              color: notice && notice.kind === 'fail' ? '#8b1d1a' : notice && notice.kind === 'ask' ? '#7a5c00' : '#1e6b2f',
              font: 'bold 12px/1.4 sans-serif',
              padding: '4px 10px',
              borderRadius: '8px',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            },
          }, notice && notice.text ? notice.text : ''),
        ),
        err ? h('div', {
          style: {
            position: 'absolute',
            right: 0,
            top: HEAD_ROOM - 24,
            background: '#fdeaea',
            border: '1px solid #d9534f',
            color: '#8b1d1a',
            font: '12px/1.4 sans-serif',
            padding: '3px 8px',
            borderRadius: 8,
            whiteSpace: 'nowrap',
          },
        }, err) : null,
      );
    }

    // ---- settings tab (设置 → 插件 → 桌面宠物) ----------------------------
    const SIZE_OPTIONS = [
      { value: 'large', label: '大', desc: '300 × 272（默认，最大）' },
      { value: 'medium', label: '中', desc: '150 × 136（约 1/4 面积）' },
      { value: 'small', label: '小', desc: '100 × 91（约 1/9 面积）' },
    ];

    function SettingsTab() {
      const [size, setSize] = React.useState('large');
      const [sound, setSound] = React.useState(true);
      const [busy, setBusy] = React.useState(false);
      const [err, setErr] = React.useState('');
      const [previewing, setPreviewing] = React.useState(null);
      const [previewMsg, setPreviewMsg] = React.useState(null);
      // Pet image state: current mode from the host, preview of the picked file, upload msg.
      const [imageMode, setImageMode] = React.useState('default');
      const [hasCustom, setHasCustom] = React.useState(false);
      const [uploading, setUploading] = React.useState(false);
      const [imageMsg, setImageMsg] = React.useState(null); // {ok, text}
      const [pickedPreview, setPickedPreview] = React.useState(null); // data URL being uploaded
      const [version, setVersion] = React.useState('');

      React.useEffect(() => {
        let cancelled = false;
        rpc('status').then((r) => {
          if (cancelled || !r || r.ok === false) return;
          setSize(r.size || 'large');
          setSound(r.sound !== false);
          setImageMode(r.image === 'custom' && r.hasCustomImage ? 'custom' : 'default');
          setHasCustom(!!r.hasCustomImage);
          setVersion(r.version || '');
        }).catch(() => {});
        return () => { cancelled = true; };
      }, []);

      const save = React.useCallback(async (patch) => {
        if (busy) return;
        setBusy(true);
        setErr('');
        try {
          const r = await rpc('settings', { value: patch });
          if (r && r.ok === false) setErr(String(r.error || '保存失败'));
          else if (patch.size) setSize(patch.size);
          else if (typeof patch.sound === 'boolean') setSound(patch.sound);
        } catch (e) {
          setErr('保存失败：' + (e && e.message ? e.message : '请求不可用'));
        } finally {
          setBusy(false);
        }
      }, [busy]);

      // ---- pet image upload ----------------------------------------------------
      // The desktop window (tkinter.PhotoImage) only decodes PNG/GIF, so ANY picked image is
      // re-encoded to PNG here via a canvas before upload — JPEG/WebP uploads would break the
      // pinned window. Large images are downscaled to at most 600px on the long side, which is
      // far above the display size (300×272) and keeps the payload small.
      const pickImage = React.useCallback(() => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = () => {
          const file = input.files && input.files[0];
          if (!file) return;
          setImageMsg(null);
          const reader = new FileReader();
          reader.onload = () => {
            const img = new Image();
            img.onload = () => {
              const maxSide = 600;
              const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
              const w = Math.max(1, Math.round(img.naturalWidth * scale));
              const hh = Math.max(1, Math.round(img.naturalHeight * scale));
              const canvas = document.createElement('canvas');
              canvas.width = w;
              canvas.height = hh;
              canvas.getContext('2d').drawImage(img, 0, 0, w, hh);
              const dataUrl = canvas.toDataURL('image/png');
              setPickedPreview(dataUrl);
            };
            img.onerror = () => setImageMsg({ ok: false, text: '图片读取失败，请换一张试试' });
            img.src = String(reader.result);
          };
          reader.onerror = () => setImageMsg({ ok: false, text: '文件读取失败' });
          reader.readAsDataURL(file);
        };
        input.click();
      }, []);

      const uploadImage = React.useCallback(async () => {
        if (!pickedPreview || uploading) return;
        setUploading(true);
        setImageMsg(null);
        try {
          const r = await rpc('set-image', { value: pickedPreview });
          if (r && r.ok === false) {
            setImageMsg({ ok: false, text: String(r.error || '上传失败') });
          } else {
            setImageMode('custom');
            setHasCustom(true);
            currentImageMode = 'custom';
            customImageUrl = null; // refetch on next resolve
            setImageMsg({ ok: true, text: '已更新宠物图片（已复制到插件目录），页内宠物与桌面小窗都会切换' });
            setPickedPreview(null);
          }
        } catch (e) {
          setImageMsg({ ok: false, text: '上传失败：' + (e && e.message ? e.message : '请求不可用') });
        } finally {
          setUploading(false);
        }
      }, [pickedPreview, uploading]);

      const resetImage = React.useCallback(async () => {
        if (uploading) return;
        setUploading(true);
        setImageMsg(null);
        try {
          const r = await rpc('reset-image');
          if (r && r.ok === false) {
            setImageMsg({ ok: false, text: String(r.error || '恢复失败') });
          } else {
            setImageMode('default');
            setHasCustom(false);
            currentImageMode = 'default';
            customImageUrl = null;
            setImageMsg({ ok: true, text: '已恢复默认的边牧小狗' });
            setPickedPreview(null);
          }
        } catch (e) {
          setImageMsg({ ok: false, text: '恢复失败：' + (e && e.message ? e.message : '请求不可用') });
        } finally {
          setUploading(false);
        }
      }, [uploading]);

      // Audition a tone through the same path a real bubble uses, so what you hear here
      // is exactly what a task event will play.
      const preview = React.useCallback(async (kind) => {
        if (previewing !== null) return;
        setPreviewing(kind);
        setPreviewMsg(null);
        try {
          const r = await rpc('sound-test', { kind });
          if (r && r.ok === false) {
            setPreviewMsg({
              ok: false,
              text: r.error === 'not pinned'
                ? '桌面宠物未固定，无法试听（先在页面右下角点 📌 固定）'
                : String(r.error || '试听失败'),
            });
          } else {
            setPreviewMsg({ ok: true, text: '已播放：' + (kind === 'done' ? '执行完成（叮）' : kind === 'fail' ? '执行失败（警告音）' : '等你确定（疑问音）') });
            setTimeout(() => { try { setPreviewMsg(null); } catch (e) {} }, 4000);
          }
        } catch (e) {
          setPreviewMsg({ ok: false, text: '试听失败：' + (e && e.message ? e.message : '请求不可用') });
        } finally {
          setPreviewing(null);
        }
      }, [previewing]);

      return h('div', {
        style: { maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 18, padding: '8px 0' },
      },
        h('div', null,
          h('h3', { style: { margin: '0 0 6px', fontSize: 16, display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', null, '桌面宠物'),
            version ? h('span', {
              style: {
                fontSize: 11, fontWeight: 500, opacity: 0.65,
                padding: '2px 8px', borderRadius: 10,
                border: '1px solid rgba(128,128,128,0.4)',
              },
            }, 'v' + version) : null,
          ),
          h('p', { style: { margin: 0, fontSize: 13, opacity: 0.72 } },
            '设置桌面宠物的图片、显示尺寸与气泡提示音。修改后立即生效并自动保存。'),
        ),
        h('div', null,
          h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 8 } }, '宠物图片'),
          h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' } },
            h('div', {
              style: {
                width: 72, height: 72, borderRadius: 10,
                border: '1px solid rgba(128,128,128,0.4)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                overflow: 'hidden', flexShrink: 0,
              },
            },
              pickedPreview
                ? h('img', { src: pickedPreview, style: { maxWidth: '100%', maxHeight: '100%' }, alt: '预览' })
                : h('span', { style: { fontSize: 34 } }, '\u{1F415}'),
            ),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                h('button', {
                  type: 'button', onClick: pickImage, disabled: uploading,
                  style: {
                    cursor: uploading ? 'wait' : 'pointer', padding: '6px 14px', borderRadius: 6,
                    fontSize: 13, border: '1px solid rgba(128,128,128,0.45)',
                    background: 'transparent', color: 'inherit',
                  },
                }, uploading ? '处理中…' : '选择图片…'),
                imageMode === 'custom' || hasCustom ? h('button', {
                  type: 'button', onClick: resetImage, disabled: uploading,
                  style: {
                    cursor: uploading ? 'wait' : 'pointer', padding: '6px 14px', borderRadius: 6,
                    fontSize: 13, border: '1px solid rgba(128,128,128,0.45)',
                    background: 'transparent', color: 'inherit',
                  },
                }, '恢复默认') : null,
              ),
              h('div', { style: { fontSize: 12, opacity: 0.7 } },
                imageMode === 'custom'
                  ? '当前使用自定义图片。图片已复制到插件目录，删除或移动原文件不影响显示。'
                  : '当前使用默认的边牧小狗。选择你喜欢的图片（猫、狗、章鱼都可以），图片会复制进插件目录，之后删原文件也不影响。'),
              pickedPreview ? h('button', {
                type: 'button', onClick: uploadImage, disabled: uploading,
                style: {
                  cursor: uploading ? 'wait' : 'pointer', padding: '6px 14px', borderRadius: 6,
                  fontSize: 13, alignSelf: 'flex-start',
                  border: '1px solid #4f8ef7', background: 'rgba(79,142,247,0.12)', color: 'inherit',
                },
              }, uploading ? '上传中…' : '应用这张图片') : null,
              imageMsg ? h('div', {
                style: { fontSize: 12, color: imageMsg.ok ? '#1e6b2f' : '#d9534f' },
              }, imageMsg.text) : null,
            ),
          ),
        ),
        h('div', null,
          h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 8 } }, '显示尺寸'),
          h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
            SIZE_OPTIONS.map(o => h('button', {
              key: o.value,
              type: 'button',
              onClick: () => save({ size: o.value }),
              disabled: busy,
              style: {
                minWidth: 140, textAlign: 'left', cursor: busy ? 'wait' : 'pointer',
                padding: '10px 12px', borderRadius: 8,
                border: '1px solid ' + (size === o.value ? '#4f8ef7' : 'rgba(128,128,128,0.4)'),
                background: size === o.value ? 'rgba(79,142,247,0.12)' : 'transparent',
                color: 'inherit',
              },
            },
              h('div', { style: { fontWeight: 600, fontSize: 14, marginBottom: 4 } },
                (size === o.value ? '\u2713 ' : '') + o.label),
              h('div', { style: { fontSize: 12, opacity: 0.7 } }, o.desc),
            )),
          ),
        ),
        h('div', null,
          h('label', {
            style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14 },
          },
            h('input', {
              type: 'checkbox',
              checked: sound,
              disabled: busy,
              onChange: (e) => save({ sound: e.target.checked }),
            }),
            h('span', null, '气泡提示音'),
            h('span', { style: { opacity: 0.7, fontSize: 12 } },
              '（完成=叮、失败=警告、等你确定=疑问）'),
          ),
          h('div', { style: { marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('span', { style: { fontSize: 12, opacity: 0.7 } }, '试听：'),
            [
              { kind: 'done', text: '完成' },
              { kind: 'fail', text: '失败' },
              { kind: 'ask', text: '等你确定' },
            ].map(o => h('button', {
              key: o.kind,
              type: 'button',
              disabled: previewing !== null,
              onClick: () => preview(o.kind),
              style: {
                cursor: previewing !== null ? 'wait' : 'pointer',
                padding: '4px 12px', borderRadius: 6, fontSize: 13,
                border: '1px solid rgba(128,128,128,0.45)',
                background: 'transparent', color: 'inherit',
              },
            }, previewing === o.kind ? '…' : o.text)),
          ),
          err ? null : previewMsg ? h('div', {
            style: { marginTop: 6, fontSize: 12, color: previewMsg.ok ? '#1e6b2f' : '#d9534f' },
          }, previewMsg.text) : null,
        ),
        err ? h('div', { style: { color: '#d9534f', fontSize: 13 } }, err) : null,
      );
    }

    // Left-nav glyph for our settings section (the shell owns the button; this is
    // only the icon cell addressed by the matching settings.section id).
    function PetIcon({ size }) {
      const s = size || 16;
      return h('span', {
        style: {
          width: s, height: s, lineHeight: s + 'px', fontSize: Math.max(11, s - 2),
          textAlign: 'center', display: 'inline-block',
        },
      }, '\u{1F415}');
    }

    let ctxRemote = null;

    // Poll the host for "navigate to session" requests queued by the desktop window.
    // Host cannot emit a custom forwarded event (DSH's remote-event allowlist is closed to
    // plugins), so the client pulls instead. A request is delivered once then cleared host-side.
    function startNavigationPoller(ctx) {
      let stopped = false;
      let inFlight = false;
      const tick = async () => {
        if (stopped || inFlight) return;
        inFlight = true;
        try {
          const r = await rpc('take-navigation');
          if (r && r.sessionId && ctx.uiWorkspace && typeof ctx.uiWorkspace.openSession === 'function') {
            try { ctx.uiWorkspace.openSession(r.sessionId); } catch (e) { /* session gone / no access */ }
          }
        } catch (e) { /* transient RPC failure; retry next tick */ }
        finally { inFlight = false; }
      };
      const timer = setInterval(tick, 1000);
      ctx.effect(() => () => { stopped = true; clearInterval(timer); });
    }

    return {
      inject: ['slots', 'remote', 'uiWorkspace'],
      apply(ctx) {
        ctxRemote = ctx.remote;
        startNavigationPoller(ctx);
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'border-collie-pet', order: 10,
        }, () => Pet({ ctxRemote })));
        // A full "桌面宠物" page in the Settings left nav (not a tab inside 内置插件).
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'border-collie-pet', order: 120,
          label: '桌面宠物',
        }, () => h(SettingsTab)));
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon', id: 'border-collie-pet',
        }, (props) => PetIcon(props || {})));
      },
    };
  },
});
