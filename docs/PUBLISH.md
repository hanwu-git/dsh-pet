# 上架操作手册（发布到 DSH 插件市场）

> 面向：插件作者（老韩）
> 前提：Windows 上已装 DSH；有 GitHub 账号
> 最后更新：2026-11-22

---

## 一、市场是怎么工作的

DSH 插件市场本质是**一个 JSON 索引文件**。用户把索引地址加进 DSH，就能看到里面列出的插件并一键安装。

没有中心化商店，不需要审核，不需要注册开发者账号——**你托管一个 JSON，别人订阅它**。

```
你的 GitHub 仓库
   ├─ 插件代码（打 tag，取 commit SHA）
   └─ market-index.json  ← 用户订阅这个地址
```

索引里每条插件必须声明版本从哪来，二选一：

| 来源类型 | 安装方式 | 要求 |
|---|---|---|
| `npm` | `包名@版本` | 已发布到 npm |
| `git` | `git+<url>.git#<commit>` | **https 公开仓库 + 完整 40 位 commit SHA** |

推荐用 **git 源**：不用发 npm，改动灵活。

---

## 二、你已经准备好的东西

本次已完成，无需再动：

| 项 | 状态 |
|---|---|
| 包名 | `dsh-border-collie-pet`（已从 `@local/border-collie-pet` 改） |
| 版本 | `0.4.0` |
| `private` | 已移除 |
| `os: ["win32"]` | 已声明（只支持 Windows） |
| `LICENSE` | MIT，已添加 |
| `README.md` | 已写（功能、安装、系统要求、FAQ） |
| Python 探测 | 已加固：DSH 运行时 → 用户级安装 → 系统级 → PATH |
| 无 Python 降级 | 已实现：页内宠物照常工作，点 📌 明确提示原因 |
| 市场索引 | `market-index.example.json`，**已通过 DSH 官方校验器验证** |
| 索引自检脚本 | `scripts/validate-market-index.cjs` |

---

## 三、发布步骤

### 第 1 步：在 GitHub 建仓库（已完成）

仓库已建好：**https://github.com/hanwu-git/dsh-pet**（Public）

> 注意：npm 包名是 `dsh-border-collie-pet`，仓库名是 `dsh-pet`，两者不同是正常的——市场索引里用 npm 包名做标识，用仓库 URL 拉取代码。

### 第 2 步：把本地代码推上去

在 `D:\obj\dsh-pet` 目录下执行（PowerShell）：

```powershell
cd D:\obj\dsh-pet

# 初始化仓库
git init
git branch -M main

# .gitignore 已由助手生成好（排除 .companion/、__pycache__/、node_modules/ 等）

git add .
git commit -m "feat: border collie desktop pet 0.4.0"
git remote add origin https://github.com/hanwu-git/dsh-pet.git
git push -u origin main
```

> 推送时若提示登录，用 GitHub 账号的用户名 + **Personal Access Token**（不是密码）作为凭据。

### 第 3 步：打 tag 并取 commit SHA

市场要求 git 源**精确固定到某个 commit**，所以先确认代码已提交干净：

```powershell
cd D:\obj\dsh-pet

# 确认工作区干净
git status

# 打 tag（版本要和 package.json 的 version 一致）
git tag -a v0.4.0 -m "v0.4.0: size presets, bubble sounds, settings page"
git push origin v0.4.0

# 取完整 commit SHA —— 下面这行输出的 40 位字符串就是
git rev-parse HEAD
```

**把 `git rev-parse HEAD` 的输出（40 位十六进制）记下来**，下一步要用。

### 第 4 步：填写市场索引

`market-index.example.json` 里的仓库 URL 已全部替换为 `hanwu-git/dsh-pet`，只剩两个字段要填：

| 占位符 | 替换成 |
|---|---|
| `commit` 字段 `PLACEHOLDER_COMMIT_SHA_40HEX` | 第 3 步拿到的 40 位 SHA |
| `publishTimestamp`（当前是 1795360000） | 当前 Unix 秒数（见下） |

填好后复制为 `market-index.json`（去掉 `.example`）。

取当前 Unix 秒数：

```powershell
[int][double]::Parse((Get-Date -UFormat %s))
```

替换完成后，**复制一份为** `market-index.json`（去掉 `.example`），并用校验器自检：

```powershell
$env:ELECTRON_RUN_AS_NODE="1"
& "D:\Program Files\DHS\DeepSeek Harness.exe" "D:\obj\dsh-pet\scripts\validate-market-index.cjs"
Remove-Item Env:\ELECTRON_RUN_AS_NODE
```

必须看到 `VALID: index parsed successfully` 才继续。

### 第 5 步：把索引推到 GitHub

```powershell
cd D:\obj\dsh-pet
git add market-index.json
git commit -m "chore: publish market index"
git push
```

> ⚠️ **注意循环依赖**：索引里固定了 commit SHA，但这个提交本身又改变了仓库。
> 实践中两种做法都可行：
> - **做法 A（简单）**：索引里的 commit 指向"插件代码那次提交"（第 3 步那个），索引文件本身在它之后的提交里——市场安装代码时不需要索引文件，所以没问题。
> - **做法 B（更严谨）**：把索引放在**另一个仓库**，与插件代码仓库分离。推荐这个。

### 第 6 步：拿到索引的公开地址

如果索引在仓库根目录：

```
https://raw.githubusercontent.com/hanwu-git/dsh-pet/main/market-index.json
```

打开这个地址，确认能看到 JSON 内容（不是 404）。

### 第 7 步：在 DSH 里订阅并验证

1. DSH → 设置 → 插件市场
2. 添加市场源，填入上一步的 raw 地址
3. 应该能看到「边牧桌宠」
4. 点安装 → 确认能装上

---

## 四、把插件安装到别人机器上会发生什么

| 场景 | 结果 |
|---|---|
| Windows + DSH 自带 Python | 全部功能可用 |
| Windows + 自己装的 Python（含 tkinter） | 全部功能可用 |
| Windows + 无 Python | 页内宠物可用，📌 提示需要 Python |
| macOS / Linux | `os: ["win32"]` 会在安装时警告/拒绝；即使装上，固定功能不可用 |

---

## 五、后续版本怎么发

1. 改代码 → 提升 `package.json` 的 `version`（如 0.4.0 → 0.4.1）
2. 提交、打 tag、推
3. `git rev-parse HEAD` 取新 SHA
4. 在索引的 `versions` 数组**新增**一条（保留旧的，用户可回退）：

```json
"versions": [
  {
    "version": "0.4.1",
    "publishTimestamp": <新时间戳>,
    "source": { "type": "git", "url": "https://github.com/hanwu-git/dsh-pet", "commit": "<新SHA>" },
    "engines": { "dsh": ">=0.2.0" }
  },
  {
    "version": "0.4.0",
    "publishTimestamp": <旧时间戳>,
    "source": { "type": "git", "url": "https://github.com/hanwu-git/dsh-pet", "commit": "<旧SHA>" },
    "engines": { "dsh": ">=0.2.0" }
  }
]
```

5. 重新用校验器自检 → 推

---

## 六、常见问题

**Q：索引校验报 `references undeclared id`**
`labels` / `categories` 里的 id 必须先在索引顶层 `metadata` 里声明。插件只能引用已声明的 id。

**Q：校验报 `publishTimestamp` 错误**
必填，是**整数 Unix 秒**（不是毫秒）。用 `[int][double]::Parse((Get-Date -UFormat %s))` 取。

**Q：commit 可以写分支名吗**
不行。必须 40 位完整小写十六进制 SHA，否则校验器拒绝。

**Q：图标能用本地路径吗**
不能。必须 https 绝对 URL，或内联 base64 data URL（不超过 32 KiB）。推荐放仓库里用 raw 地址。

**Q：改了插件代码但没重新打 SHA，用户能拿到新代码吗**
不能。市场按 commit 固定安装，必须走新版本流程。

---

## 七、待办清单

| ID | 描述 | 状态 | 截止时间 |
|---|---|---|---|
| P1 | 建 GitHub 公开仓库 `hanwu-git/dsh-pet` | 已完成 | 2026-11-22 |
| P2 | 本地 git init + 推送代码（含 .gitignore） | 待办 | 待定 |
| P3 | 打 v0.4.0 tag 并取 40 位 commit SHA | 待办 | 待定 |
| P4 | 填入索引 commit SHA + 时间戳，复制为 market-index.json | 待办 | 待定 |
| P5 | 用官方校验器自检索引 | 待办 | 待定 |
| P6 | 推送索引到 GitHub，取得 raw 地址 | 待办 | 待定 |
| P7 | 在 DSH 中订阅并试装验证 | 待办 | 待定 |
