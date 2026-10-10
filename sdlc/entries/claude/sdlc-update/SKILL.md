---
name: sdlc-update
description: sdlc 工具自身的更新与维护（npm 更新 / doctor 自检）。用户说「更新 sdlc」「工具出问题了」「sdlc 版本」时使用。更新 = npm 全局升级，CLI、薄入口、skill-core 随包同版本更新；自检只读；先说明将发生什么再执行。
---

# sdlc-update（工具维护）

读取用户主目录下 **`.sdlc/skill-core.md`** 并完整遵循——特别是触发映射、plan/apply 协作（§3）与对话输出规范（§0）。

本发行版的更新走 npm（git tag 自更新已退役；`sdlc update` 会拒绝并提示重装——这是预期行为，不要绕过它）：

- **更新**：向用户确认后执行 `npm i -g @didatravel-jinyi/meegle@latest`，随后运行 `meegle install --no-auth` 重铺薄入口与 `~/.sdlc/skill-core.md`（保证与新版 CLI 同版本）。若更新是经 meegle 启动时的自动更新提示完成的，薄入口与 skill-core 已随之自动刷新，无需重铺。
- **降级**：`npm i -g @didatravel-jinyi/meegle@<版本号>`，随后同样重铺。
- **自检**：`sdlc doctor`（只读；meegle 未装/未登录标「未核实」不算失败），结果如实转述。

转述版本变化用自然语言；自检只读，不擅改用户工具/权限配置。
