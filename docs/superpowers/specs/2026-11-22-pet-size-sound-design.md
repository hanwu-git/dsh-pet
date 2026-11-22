# 桌面宠物尺寸三档 + 气泡提示音 设计文档

- 日期：2026-11-22
- 作者：lead（DSH 会话）
- 状态：已实施并通过自动化验收（2026-11-22）；网页页签外观待老韩在 GUI 目视确认
- 上游决策：入口不用右键菜单，改走 DSH 网页「设置 → 插件」新增「桌面宠物」页签（老韩 2026-11-22 指定）

## 1. 需求

1. **尺寸三档**：大 = 当前尺寸（300×272）为最大档；中 = 大的 1/4 面积（150×136）；小 = 大的 1/9 面积（100×91）。切换时气泡字号、气泡宽度、头部留白同步缩小（老韩已确认）。
2. **切换锚点**：左上角锚点不动（老韩指定）——窗口 `+x+y` 保持，右下边缘随尺寸收缩。
3. **气泡提示音**：气泡弹出时可选提示音。音源用 Windows 系统音三档（完成 MB_OK / 失败 MB_ICONERROR / 等你确定 MB_ICONQUESTION，老韩已确认）；三种气泡全响（老韩已确认）；默认开。
4. **设置入口**：DSH 网页设置左侧导航新增「桌面宠物」独立页（槽位 `settings.section` + 图标槽位 `settings.section.icon`），内含：尺寸三档单选 + 提示音开关。
   - 注：初版误用 `settings.plugins.tab`（该槽位只在「内置插件」页内部渲染成 tab，左侧导航不可见），2026-11-22 改为 `settings.section` 后左导航直接出现入口。

## 2. 架构与数据流

```
网页设置页签（新，client.js）
   │  尺寸单选 / 提示音开关
   ▼
POST /border-collie-pet/rpc  {action:"settings", value:{size, sound}}   ← 已有 RPC 路由加一个 action
   ▼
Host (pet-service.js)：写 .companion/settings.json + 记 host.log
   ▼
伴生窗 (companion.py)：每 400ms 轮询 settings.json（新增，与 state.json 并行）
   ▼
立即生效：窗口/图/气泡重排；播放提示音规则更新
```

- 设置持久化在 `.companion/settings.json`：`{"size":"large|medium|small","sound":true|false}`。
- 伴生窗**只读**设置文件（写入口唯一走 Host RPC，避免双写竞争）。
- 网页 localStorage 同步缓存最后选择，用于页签初始渲染，但以 Host 落盘值为准（RPC `settings` GET 返回当前生效值）。
- 页签初始值通过 RPC `status` 扩展返回 `{pinned, size, sound}`，避免新增路由。

## 3. 组件改动清单

### 3.1 client.js（由 .client-template.js 构建）
- 新增 `SettingsTab` 组件：两块 UI——尺寸三档（radio：大/中/小）、提示音（checkbox「气泡提示音」）。
- 注册方式（照官方 contract 示例，`dsh-tool-picker` 同款写法）：
  - `ctx.slots.inject('settings.section', () => ctx.slots.register({ name:'settings.section', id:'border-collie-pet', order:120, label:'桌面宠物' }, SettingsTab))`
  - `ctx.slots.inject('settings.section.icon', () => ctx.slots.register({ name:'settings.section.icon', id:'border-collie-pet' }, PetIcon))`（id 必须与 section 一致，否则不渲染）
- 交互：点击选项 → `rpc('settings', {size|sound})` → 成功后更新本地高亮；失败显示行内错误（复用现有错误样式）。
- 页签打开时先 `rpc('status')` 拉当前值再渲染（避免本地缓存过期）。

### 3.2 pet-service.js（Host）
- `settings.json` 读写函数：`readSettings()` / `writeSettings(patch)`，默认 `{size:"large", sound:true}`，损坏时回默认。
- RPC 新增 action `settings`：body `{action:"settings", value:{size?, sound?}}`，校验 size ∈ {large,medium,small}、sound 为 boolean；写文件 + `logLine("settings", ...)`；返回 `{ok:true, size, sound}`。
- RPC `status` 扩展：返回 `{ok:true, pinned, companion, size, sound}`（伴生窗未运行时也返回持久设置）。

### 3.3 companion.py（伴生窗）
- 启动时按约定路径 `<state.json 同目录>/settings.json` 自动发现并读取（不加命令行参数，向后兼容）。
- 轮询循环里新增 `handle_settings()`：t 风格简化——直接比对文件 mtime + 内容，变化即应用：
  - **resize(scale)**：`scale = 1 | 0.5 | 1/3`？——**不用浮点缩放**，用 `PhotoImage.subsample(2)`（中，1/2 边长 = 1/4 面积）与 `subsample(3)`（小，1/3 边长 = 1/9 面积），与老韩的 1/4、1/9 面积口径精确一致。
  - 窗口宽高 = `art_w//k × art_h//k + HEAD_ROOM//k`（HEAD_ROOM 档位化：64/32/21）。
  - **左上角锚点不动**：resize 前记录 `winfo_x()/winfo_y()`，重排后 `geometry(f"+{x}+{y}")`。
  - 气泡参数档位化：字号 11/9/8、气泡最小宽 120/80/60、头部留白 64/32/21；当前有气泡时按新档位重画。
- 提示音：`show_bubble(kind, text, play_sound)` 内新增——`winsound.MessageBeep(MB_OK|MB_ICONERROR|MB_ICONQUESTION)`（kind→音映射：done→MB_OK，fail→MB_ICONERROR，ask→MB_ICONQUESTION）。`winsound` 为 Python 标准库，零依赖。仅**新事件**触发（handle_state 里走到 show_bubble 且 t 变化）时响；test 气泡也响（便于验证）；点击消除、替换显示不响。
- settings.json 读取失败/缺失 → 维持当前值（不重置）。

## 4. 错误处理

| 场景 | 行为 |
|---|---|
| settings.json 损坏 | Host 与伴生窗各自回默认值（large/true），下次 RPC 写入覆盖修复 |
| RPC 传非法 size | Host 返回 `{ok:false, error:"bad size"}`，不落盘 |
| 伴生窗未运行时改设置 | 设置仍落盘，下次伴生窗启动读取生效（固定开启时自动加载） |
| winsound 播放异常 | try/except 吞掉，气泡照常显示（声音是增强不是阻塞） |
| 页签在插件未激活/未固定时打开 | 页签仍可用：设置写入即生效于下次伴生窗启动；页签顶部说明当前未固定状态 |

## 5. 测试与验收

1. `node --check pet-service.js`、`py_compile companion.py`、重建 client.js 后语法检查。
2. 重装插件 → 网页打开「设置 → 插件」→ 出现「桌面宠物」页签。
3. 页签切「中」：小狗立即变 150×136，左上角不动，气泡同步变小（写 test 气泡验证）。
4. 页签切「小」：100×91，同理。
5. 勾选提示音 → test 气泡三色各响对应系统音；取消勾选 → 无声。
6. 重启 DSH：尺寸/提示音保持；auto-pin 恢复的伴生窗按设置尺寸出现。
7. 回归：拖动跟随、点击呼叫 DSH 前台、气泡持久不自动消失、孤儿防护仍工作。

## 6. 里程碑

| ID | 描述 | 状态 | 截止时间 |
|---|---|---|---|
| S1 | Host：settings.json 读写 + RPC settings action + status 扩展 | 待办 | 2026-11-22 |
| S2 | 伴生窗：settings 轮询 + subsample 三档缩放（左上锚点）+ 气泡档位化 | 待办 | 2026-11-22 |
| S3 | 伴生窗：winsound 三档提示音（新事件触发） | 待办 | 2026-11-22 |
| S4 | 网页：settings.plugins.tab 页签 UI + RPC 调用 | 待办 | 2026-11-22 |
| S5 | 重装 + 全链路验收（第 5 节 7 项） | 已完成（6/7 自动验证通过，第 3 项网页页签外观待目视） | 2026-11-22 |

## 7. 验收结果（2026-11-22）

| 项 | 结果 |
|---|---|
| 语法检查（pet-service.js / companion.py / client.js） | 通过 |
| 重装后单一伴生窗拉起、auto-pin 恢复 | 通过（PID 4052 单一实例） |
| RPC 路由 `settings`/`status` 注册（无 cookie POST=401，随机路径=405） | 通过 |
| 三档缩放：large 300×336 / medium 150×168 / small 100×112 | 通过（尺寸=图+头部留白，符合 1/1、1/2、1/3 边长口径） |
| 左上角锚点不动 | **修复后通过**：初测用 winfo_x/y 漂移，改用 winfo_rootx/rooty + update_idletasks 后 large→medium→small→large 全程锁定 (1596,624) |
| 气泡档位化：small 808px → large 3571px 背景像素 | 通过（约 4.4 倍，字号/宽度/高度同步缩放） |
| 气泡在 small 档渲染、切换尺寸时重绘不崩 | 通过 |
| 提示音三档 | **修复后改用 wav 直放**：初版用 `winsound.MessageBeep(MB_ICONQUESTION)` 播「等你确定」，但本机 `HKCU\AppEvents\Schemes\Apps\.Default\SystemQuestion\.Current` 为空（该事件未绑定音频），必然静默；改为优先播放 `C:\Windows\Media\*.wav`（done=ding.wav、fail=Windows Critical Stop.wav、ask=Windows Notify.wav），MessageBeep 仅作回退 |
| 设置入口 `settings.section` 左导航独立页 | 通过（老韩 GUI 已确认「桌面宠物」出现，大中小三档均有效果） |
| 透明键色（粉色方块） | **修复后通过**：重写时漏掉 `attributes("-transparentcolor", key)` 导致品红键色泄漏成粉色方块；补回并在 resize 后重新断言，实测 small/medium/large 纯品红像素 5605(50%) → **0** |
| 提示音试听按钮 | 新增 `sound-test` RPC action + 设置页三个试听按钮（完成/失败/等你确定），走与真实气泡完全相同的 winsound 代码路径 |

**关键修复**：缩放时左上角锚点漂移——根因是 `winfo_x/y()` 对 overrideredirect + -topmost 窗口返回父相对坐标且 canvas resize 时 WM 重定位；改用 `winfo_rootx/rooty()` 取屏幕绝对坐标 + `update_idletasks()` 后再 `geometry()` 重新钉住，锚点全程稳定。
