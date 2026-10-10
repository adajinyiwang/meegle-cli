# 任务拆分 · {{req_id}} {{title}}

> 开发产出（方案 v0.9 / schema_version 5，D37/D46）。产品先写 PRD，开发再自行拆任务。
> 飞书块 = 粗粒度协作清单（建议 3-8 条，不设数量或完成率 KPI）；开发区 = 自由工作底稿（不进飞书，可加 @Tn 关联）。
> 细任务可引用 OpenSpec 或任何开发方法；不强制使用，也不要求消除重复。

## 飞书任务（粗粒度 · 同步进度）

<!-- sdlc:tasks begin -->
```yaml
tasks:
  - id: T1
    title: （示例）后端登录接口鉴权重构
    assignee_role: dev
    estimate: 3
    state: open
  - id: T2
    title: （示例）前端登录页适配
    assignee_role: dev
    estimate: 1
    state: open
```
<!-- sdlc:tasks end -->

<!-- Tn 是稳定标识，不重排/复用；新任务用新编号增量同步，不因重跑重复创建。 -->
<!-- state 仅 open / completed / cancelled；取消≠完成，本地删行≠远端删除。取消项保留并简述范围变化即可。 -->
<!-- estimate 为可选人天数（正数）：创建远端子任务时自动设当前用户为负责人、按估分排期与估分值。 -->
<!-- assignee_role 只供候选建议；core 按实际参与关系授权。多人候选须回显实际用户并确认，不默认取首人。 -->
<!-- 本地 state 和细任务勾选只是待同步内容/建议，不证明远端已更新；以 plan/apply 回读为准。 -->
<!-- --tasks T1,T2 只能选择本 plan 展示的完成候选；解析失败可跳过同步继续本地工作，不能猜任务或把 skip 当成功。 -->

## 开发任务（细粒度 · 本地工作底稿）

<!-- 逐条勾选；@Tn 标注关联的飞书任务 -->
- [ ] （示例）抽取 token 校验中间件 @T1
- [ ] （示例）登录接口改造 + 单测 @T1
- [ ] （示例）登录页表单校验 @T2
