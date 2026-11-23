# 边牧桌宠（Border collie pet）

右下角一只边牧桌面宠物（用户提供的插画），监控 **所有工作区** 的任务执行状态，弹出三色提示气泡；并支持 **固定到桌面**——DSH 最小化后宠物仍以置顶小窗形式显示在屏幕最前面。

## 功能

### 固定到桌面（0.3.0 新增）

- 宠物右上角有一个 📌 圆形按钮。点击后：
  - 页内宠物收起，改为一个 **独立置顶小窗** 显示在桌面（DSH 主窗口之外）；
  - DSH 最小化、被遮挡时，宠物窗仍保持在最前面；
  - 宠物窗可拖动，任务气泡照常弹出。
- 再次点击 📌（页内右下角残留的小按钮）取消固定：小窗关闭，宠物恢复为页内显示。
- 固定状态保存在 `localStorage`（key: `border-collie-pet:pinned`），刷新页面后保持。
- 小窗由 DSH 自带的 Python（tkinter）渲染，随固定/取消启停；DSH 退出时小窗随进程树自动关闭。

### 三色任务气泡

| 状态 | 触发 | 气泡样式 |
|---|---|---|
| 执行完成 | 任意工作区任务从运行转为停止 | 浅绿底 / 绿边 |
| 执行失败 | 任务出错（Host 监听 `agent/error`） | 淡红底 / 红边，附简短原因 |
| 等你确定 | Agent 发起用户提问（`tool/call: ask_user_question`）或审批（`approval/asked`） | 淡黄底 / 黄边 |

- 气泡**不会自动消失**；点小狗 = 把 DSH 主窗呼叫到前台并消除气泡。
- 页内模式与桌面固定模式行为一致。

## 实现说明

- **Host 服务**（`pet-service.js`）：**函数插件**（`apply(ctx)` + `inject: ["webServer", "connection"]`，与 prompt-polish 同款）。注册一条 webServer 路由 `POST /border-collie-pet/rpc`（走 connection 信任墙，浏览器 cookie 鉴权），dispatch `pin` / `status` / `test` 三个 action；同时监听 Host 事件（`agent/status`、`agent/error`、`session/event` global）把任务状态写进 `.companion/state.json`。**不 import 任何 `@deepseek-ai/*` 包**——link 安装的插件真实路径上方没有 node_modules，bare import 会在激活时报 ERR_MODULE_NOT_FOUND。
- **RPC 协议**：`{action:"pin", value:true|false}` → 启停伴生窗并持久化到 `.companion/pinned.json`；`{action:"status"}` → 查询当前固定状态；`{action:"test", kind}` → 预览气泡。
- **固定状态持久化 + 随 DSH 自启**：`apply` 时读 `pinned.json`，若上次固定过则自动重新拉起伴生窗（DSH 重启后宠物自动回到桌面）。
- **置顶小窗**（`companion.py`）：tkinter 无边框窗（`overrideredirect` + `-topmost`），品红色键控透明，加载 `pet-flat.png`（构建期 alpha 二值化预合成，避免键色混出紫边），轮询状态文件显示气泡；轮询命令文件响应退出指令（读后即清空，防重放）。宿主 spawn 前先清空命令文件，避免残留 quit 指令把新窗口秒杀。优先 `pythonw.exe` 启动（无控制台闪窗）。
- **气泡交互**：气泡不自动消失；点小狗 = 把 DSH 主窗呼叫到前台（ctypes EnumWindows + SetForegroundWindow，区分点击与拖动）并消除气泡；新结果替换旧气泡内容。
- **孤儿防护**：Host 启动伴生窗时把自身 pid 作为第 5 个命令行参数传入，伴生窗在启动瞬间记为常量，每次轮询检查**这个启动时记下的 pid** 是否存活，宿主死亡则窗口自关。**不能读 state.json 的 `owner` 字段**——新宿主会覆盖该字段，孤儿窗会误判自己仍有主。该修复用于避免重装/重启后残留幽灵窗口导致双窗。
- **Client 模块**（`client.js`）：宠物右上角 📌 按钮，点击 `fetch` 调 RPC 路由；固定后页内宠物收起、只留小按钮可取消；页内模式保留三色气泡（远程事件订阅）。固定状态同步存 localStorage（`border-collie-pet:pinned`）。
- **素材**：`pet.png`（300×272）内嵌为 data URL，无 SVG 裂纹问题。
- 打字监控与鼠标跟踪功能已按需求移除。

## 限制

- 桌面小窗需要**带 tkinter 的 Python 3**。查找顺序：DSH 自带运行时 → 用户级安装（`%LOCALAPPDATA%\Programs\Python\Python3xx`）→ 系统级（`C:\Python3xx`）→ `PATH`。找不到时点 📌 会返回明确原因，页内宠物不受影响。
- **仅支持 Windows**（`package.json` 的 `os` 声明为 `win32`）：置顶窗与窗口呼前都依赖 Win32 API（ctypes / winsound），macOS 与 Linux 无法使用桌面固定功能。
- 气泡为纯展示，不做点击跳转；点小狗只负责呼前 DSH。
- 提示音直接播放 `C:\Windows\Media\*.wav`（不依赖系统事件绑定——部分机器上 SystemQuestion 事件未绑定音频，`MessageBeep(MB_ICONQUESTION)` 会静默）。
- RPC 路由只在本机 GUI 会话内可用（cookie 鉴权）；浏览器验证需要带登录态的 GUI 地址。
- 发布到市场的完整流程见 [PUBLISH.md](PUBLISH.md)。
