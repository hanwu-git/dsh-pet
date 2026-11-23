# 多任务状态灯 + 点气泡跳转会话 设计文档

- 日期：2026-11-23
- 作者：lead（DSH 会话）
- 状态：待老韩确认
- 背景：v0.4.1 的"浮动动画"在多任务并发下误判（A 结束就停浮动、弹完成，但 B 还在跑）；`state.json` 每次全量覆盖导致 `run`/`ask`/`runningEnd` 无法共存。老韩决定：**撤掉浮动改状态灯**，并**新增点气泡跳转到对应会话**。

## 1. 需求与已定语义

1. **撤掉浮动**：删除 v0.4.1 的整只狗上下浮动动画。
2. **状态灯**：狗右上角一个小圆点，**仅当至少一个会话处于 running 时亮**；`ask`（等你确定）**不算活跃、不亮灯**；无任务时灭。
3. **完成气泡**：**每个任务结束都弹**（保持现状），即使并发、即使灯还亮着。
4. **点气泡跳转**：三色气泡（完成/失败/等你确定）显示时，点小狗 = 呼 DSH 前台 + **切换到气泡对应的会话** + 消除气泡；无气泡时点狗只呼前（保持现状）。

## 2. 根因（为什么要重做）

| 层 | 问题 |
|---|---|
| 单布尔误判 | `agent/status` 处理是"任一 running 写 run、任一非 running 写 runningEnd"，不区分会话。A 结束会误停浮动/误弹完成，哪怕 B 还在跑 |
| 状态覆盖 | `writeState({...patch})` 每次全量覆盖，`run`/`ask`/`runningEnd` 互斥，无法表达"一边在跑一边等确认" |
| ask 与 running 割裂 | ask 状态不告诉小窗"还有其他任务在跑"，导致监控跟着事件乱跳 |

## 3. 关键可行性调查结论（读 DSH 源码确认）

| 事项 | 结论 |
|---|---|
| 会话导航 API | `ctx.uiWorkspace.openSession(sessionId)` —— Client 侧标准导航方法，官方 chat/subagent/conversation 插件均在使用 |
| uiWorkspace 注入 | `UiWorkspaceService` 以 `super(ctx, 'uiWorkspace')` 注册，client 插件可 `inject: ['uiWorkspace']` 获取 |
| Host→Client 事件 | **存在严格白名单** `API_REMOTE_FORWARDED_EVENTS`（在 `dsh-api-remotes/lib/types/remote-events.js`），插件**无法注册新转发事件**。因此"Host emit 自定义事件 → Client $on"这条路**不可用** |
| 采用的转发方式 | **Client 主动轮询 RPC**：现有 `POST /border-collie-pet/rpc` 增加 action `take-navigation`，Client 定时查询是否有待处理跳转；有则拿 sessionId 调 `openSession` |

## 4. 架构与数据流

### 4.1 状态灯流

```
Host ctx.on("agent/status"):
  running     → runningSet.add(id)    → state {active:true,  ...}
  非 running  → runningSet.delete(id) → state {active:bool, runningEnd:{id}}  (集合空则 active:false)
每次都写 runningEnd → 每个任务结束都弹完成气泡
ask/fail 事件 → 只写 ask/fail 气泡，不动 active 灯
```

**关键约束**：`writeState` 是每次全量覆盖，所以 `{active}` 与 `{runningEnd}` 必须在**同一次写入**里，不能分两次（后写会覆盖前写）。

### 4.2 点气泡跳转流

```
小窗显示气泡时记住气泡的 sessionId (来自 runningEnd/fail/ask 的 id)
  ↓ 点狗（有气泡）
小窗写 cmd.json: {kind:"navigate", sessionId, t}
  ↓
Host RPC/轮询 cmd.json 读取 → 存入内存 pendingNavigation
  ↓
网页 Client 定时轮询 rpc("take-navigation") → 拿到 sessionId
  ↓
Client: ctx.uiWorkspace.openSession(sessionId)
  ↓ 成功后 Host 清除 pendingNavigation
呼 DSH 前台 + 消除气泡（小窗侧，立即执行）
```

- Host 如何读到 cmd.json：现有 companion 轮询 cmd.json 的 `quit` 指令；Host 侧新增一个轻量轮询（如 800ms）读取 `cmd.json` 中的 `navigate` 指令，取走后清空。
- `pendingNavigation` 存单个最近请求即可（覆盖式）。
- 会话已关闭/跳转失败：Client 吞掉错误，Host 清除请求，不打扰用户。

## 5. 组件改动清单

### 5.1 pet-service.js（Host）
- `runningSet = new Set()`；`agent/status`：running 加 id，非 running 删 id。
- 非 running 时写 `writeState({ active: runningSet.size > 0, runningEnd: {id} })`（每任务结束都弹）。
- running 时写 `writeState({ active: true })`。
- `fail`/`ask` 不变（不碰 active）。
- 新增 cmd.json 轮询：读取 `navigate` 指令 → 存 `pendingNavigation = {sessionId, t}` → 清空文件。
- RPC 新增 action `take-navigation`：返回并清除 `pendingNavigation`（无则 `{ok:true, sessionId:null}`）。

### 5.2 companion.py（小窗）
- **删除**全部浮动动画：`busy/busy_phase/busy_after` 字段、`set_busy`/`animate_float`/`reset_pet_position` 方法及调用。
- 新增状态灯：`self.status_dot`（canvas item），`set_active(bool)` 显示/隐藏；位置 = 狗图右上角内侧，半径按档位 6/4/3；绿色 `#5cb85c` + 深绿边。
- `handle_state`：读 `state['active']` → `set_active`；结果气泡逻辑不变。
- 气泡记住 sessionId：`show_bubble(kind, text, sessionId)` 存 `self.current_bubble = (kind, text, sessionId)`。
- `on_release` 点击时：若有气泡且 sessionId 存在 → 写 cmd.json `{kind:"navigate", sessionId}` → 呼 DSH 前台 → 清气泡；否则只呼前。

### 5.3 client 模板 / client.js
- 模板内模块 `inject` 数组增加 `'uiWorkspace'`。
- `apply` 里启动一个轮询（如 1s）：`rpc('take-navigation')` → 若返回 sessionId → `ctx.uiWorkspace.openSession(sessionId)`（try/catch 吞错）。轮询挂 `ctx.effect` 以便卸载清理。
- **`package.json` 的 `dsh.client.inject` 必须增加 `@deepseek-ai/dsh-client-ui-workspace`**（已查证：官方 `dsh-client-ui-chat` / `dsh-client-ui-subagent` 都在 package.json 声明该包作依赖，才能注入 `uiWorkspace` 服务）。两处声明需同步。

## 6. 错误处理
- 跳转失败（会话不存在/无权限）：Client try/catch 吞掉，Host 已清除请求，不弹错误。
- cmd.json 读写竞争：读取后立即清空（同 quit 指令模式）；Host 与小窗不同时写 navigate。
- 状态灯与气泡冲突：灯独立于气泡 canvas item，互不干扰。
- 多 DSH 实例：各自独立 cmd.json/state.json（同目录）——多实例场景已存在，不在本次范围。

## 7. 测试要点
1. 单任务：开始→灯亮；结束→灯灭 + 完成气泡。
2. 并发 A/B：A 开始亮、B 开始仍亮、**A 结束灯仍亮**、B 结束才灭；每个结束各弹一次完成气泡。
3. ask：不亮灯，只弹黄气泡。
4. 点气泡跳转：三色气泡各自点狗 → 切到对应会话；无气泡点狗只呼前。
5. 尺寸三档：灯位置正确不越界。
6. 回归：拖动、点击呼前、提示音、孤儿防护、设置页。

## 8. 待办
| ID | 描述 | 状态 | 截止时间 |
|---|---|---|---|
| D1 | Host：runningSet + active + take-navigation RPC | 待办 | 2026-11-23 |
| D2 | 小窗：删浮动 + 状态灯 + 气泡存 sessionId + 点击写 navigate | 待办 | 2026-11-23 |
| D3 | Client：inject uiWorkspace + 轮询 take-navigation 调 openSession | 待办 | 2026-11-23 |
| D4 | 重装 + 并发/跳转/回归验收 | 待办 | 2026-11-23 |
| D5 | 发 v0.4.2（tag + 索引 + 校验 + 推送） | 待办 | 2026-11-23 |
