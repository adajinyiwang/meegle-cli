# 文档上传（git 编排）

触发：`/sdlc-next` 的文档类动作（commands.md N3）。目录映射、commit message 约定见 [team-conventions.md](team-conventions.md)。

## 流程

1. **询问**（禁止自行扫描目录）：「要上传哪些<文档类型>到需求 <ID> 的 <目录> 目录？请给出文件名或路径。」
2. 用户给出名称/路径 → 验证文件存在；不存在 → 如实报告并再问一次（最多两轮，仍无 → 本动作结束，不猜文件）
3. 复制文件到 `docs/sdlc/<ID>/<子目录>/`（保留原文件名；重名冲突 → 询问覆盖还是重命名）
4. `git add <本次文件>` → 展示提交确认卡片：

```
即将提交文档：
  文件：<列表>
  Message：docs(sdlc): add <prd|cases|reports> for #<ID>
确认提交？
```

5. 确认后 `git commit`
6. **推送另出确认卡片**（远端写操作）：

```
即将推送：
  仓库：<origin url>　分支：<分支名>
  待推送提交：<N> 个（含本次文档提交）
确认推送？
```

7. 推送后验证：`git ls-remote --heads origin <分支名>` 确认远端分支存在，`git status` 确认无 ahead；回读失败 → 按失败报告，禁止宣称上传成功

## 护栏

- 用户有未提交改动（`git status --porcelain` 非空且非本动作产生）→ 不动它们、不加入本次 add；会被卷入提交时如实报告请用户处理
- 只 `git add` 本次动作涉及的 `docs/sdlc/<ID>/` 下文件；**禁止** `git add -A` / `git add .`
