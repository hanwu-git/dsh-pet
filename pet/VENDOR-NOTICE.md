# Vendored Pet — dsh-pet v2.0

本目录是从 [qianyiai/KuroCat](https://github.com/qianyiai/KuroCat) vendor 进来的宠物引擎源码，
作为 dsh-pet 的内置 KuroCat 形象。**本仓库即最终形态**——不再跟踪上游更新。

## 来源

- 上游仓库：https://github.com/qianyiai/KuroCat
- Base commit：`1df9f3f`（v5.1.3 系列，Windows 主目标）
- 上游许可证：MIT（保留于本目录 `LICENSE`，版权归 KuroCat 作者 Kevin Hao / qianyiai 所有）
- 本项目整体许可证：MIT（见仓库根 `source/LICENSE`）

## 相对上游的修改（dsh-pet 集成）

| 修改 | 说明 |
|---|---|
| `src-tauri/src/updater.rs` | **自升级彻底移除**：仅保留 `CURRENT_VERSION` 常量。检查/下载/安装更新的命令与后台线程全部删除 |
| `src-tauri/src/tray.rs` | 托盘"检查更新"菜单项禁用（保留占位，菜单布局不变）；URL 打开改为调用 `lib.rs::open_url_in_browser_pub` |
| `src-tauri/src/lib.rs` | 移除 `get_cached_update_info` / `check_for_update` / `install_update` 三个 Tauri 命令及更新检查器启动；新增 `open_url_in_browser_pub`；`get_app_version` 返回带 `-dshpet` 后缀 |
| `website/`、`android/`、SEO 脚本 | 不 vendor（与 DSH 插件无关） |
| `src-tauri/gen/`（Tauri 生成物）、`win7/` shim | 不 vendor；Windows 10/11 为唯一构建目标（`macos_window.rs`、`win7_layered.rs` 源码保留但非目标） |
| 其余 | 托盘菜单、设置、MCP、/hook、隐私守卫、OBS、捏猫、打字联动等**全部保留原样** |

## 构建

```
cd src-tauri && cargo build --release   # 产出 KuroCat.exe
npm install && npm run build            # 前端 dist（Tauri 打包时内嵌）
```

## 与 dsh-pet 的关系

- dsh-pet 插件（`../pet-service.js`）通过 `kurocat-bridge.js` 启动/接管本引擎：
  - 端口：内嵌实例使用 **27430+**（官方 KuroCat 的 27420 不受影响）
  - 单实例：已有实例在监听时直接接管，绝不双开
  - 生命周期：可独立于 DSH 运行；DSH 退出时由用户选择是否同步关闭
  - 任务状态：DSH 事件 → `/hook` → 猫表演（working/done/error/waiting）
