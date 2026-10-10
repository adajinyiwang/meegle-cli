// meegle 适配层真实通道（meegle-contract §2/§3）：子进程调用官方 meegle CLI。
// 命令形状按 v1.0.23 实测结论拼装；输出解析只取所需字段、忽略未知（契约 §1），
// 形状与实测不符时按 external_unknown/未核实上报，不猜（M1 #28–#35 运行时回填）。
// 幂等门（§3.1）：advance/change = 「确保处于目标阶段」——写前回读后从当前
// doing 节点连续流转到目标节点落位（追赶语义，中间节点如测试环境部署自动过；
// 节点必填缺失停下如实转述由人补，CLI 不代填伪数据）；任务动作按标题/映射幂等。
// 节点映射（v5）：stage_nodes.node_key 精确 key，或 `*后缀` 名称模式（R5 修正
// 旧认知：开发节点 key 实为模板预置稳定值；模式的真实价值 = 33 个并行 OR 分支
// 开发节点的「落位判定 = 任一 doing」，模板加新开发节点自动适应）。profile
// 判定链（R5）：hint > 模板 id 直查（config template_id 预置映射）> 节点集
// 打分兜底。
import { findSdlcRoot, loadRepoConfig } from '../config.js';
import { SdlcError } from '../errors.js';
import { runMeegle, meegleAuthStatus } from './runner.js';

/** 解析可选的仓库配置上下文（createCore() 无参调用时自 cwd 探测）。 */
function resolveConfigCtx(opts) {
  if (opts?.config) return { config: opts.config };
  const root = findSdlcRoot(process.cwd());
  if (!root) return { config: null };
  try {
    return { config: loadRepoConfig(root).config };
  } catch {
    return { config: null };
  }
}

/** project_key（配置缺失 → validation_failed 不猜节点）。 */
function projectKeyOf(config) {
  const pk = config?.feishu?.project_key;
  if (!pk || typeof pk !== 'string' || pk.startsWith('<')) {
    throw new SdlcError('validation_failed', '仓库配置缺 feishu.project_key（真实通道必填）——请补 .sdlc/config.yaml');
  }
  return pk;
}

/** profile 解析：显式传入 > workitem 类型匹配 > 单 profile 配置。 */
function resolveProfile(config, hint) {
  const profiles = config?.feishu?.profiles ?? {};
  if (hint && profiles[hint]) return hint;
  const keys = Object.keys(profiles);
  if (keys.length === 1) return keys[0];
  return null; // 多 profile 且无提示 → 调用方 requirementState 按类型兜底，写动作报错
}

/** workitem 类型 key → profile 匹配（多 profile 仓的主路径：story/tech 类型
 *  各异，bind 前无 meta.profile 可 hint——R4 实测 7131703974 阶段 null 的根因）。 */
function profileByType(config, typeKey) {
  if (!typeKey) return null;
  for (const [name, p] of Object.entries(config?.feishu?.profiles ?? {})) {
    if (p?.work_item_type_key === typeKey) return name;
  }
  return null;
}

/** 流程模板 id → profile 直查（R5 PMO 预置映射：config profile 声明 template_id，
 *  readState 并行的 workitem get 读 template.id 比对——强证据源，优先于节点集打分
 *  启发式；模板未预置/字段读不到时回退打分）。模板 id 对照 PMO 导出：story 敏捷
 *  3312019 / story DiDa 2633577 / tech 敏捷 4584631 / tech 标准 2709195。 */
function profileByTemplate(config, templateId) {
  if (templateId == null) return null;
  for (const [name, p] of Object.entries(config?.feishu?.profiles ?? {})) {
    if (String(p?.template_id ?? '') === String(templateId)) return name;
  }
  return null;
}

/** 节点值匹配（精确 key 或 `*后缀` 名称模式）。 */
function nodeValueMatches(value, key, name) {
  if (Array.isArray(value)) return value.some((v) => nodeValueMatches(v, key, name));
  if (typeof value !== 'string' || value.startsWith('<')) return false;
  if (value.startsWith('*')) return String(name).endsWith(value.slice(1));
  return value === key;
}

/**
 * profile 节点集自适应匹配（R4b 实测 7131600756：story 类型存在多套流程模板
 * ——`doing/state_15/state_40/…/end` 与 `started/state_29/…/state_50` 节点集
 * 互斥，type key 相同会撞车）。按「映射节点在当前节点表中的命中数」打分：terminal
 * 命中 ×2、每个 stage_nodes 命中 ×1；最高分 >0 胜出。同分时保持声明序（Object
 * entries 序）——用户把更常用的 profile 排前即可。
 * @param {any} config @param {{nodes: {key: string, name: string}[]}} table
 * @returns {string | null}
 */
function profileByTable(config, table) {
  let best = null;
  let bestScore = 0;
  for (const [name, p] of Object.entries(config?.feishu?.profiles ?? {})) {
    let score = 0;
    for (const [stage, sn] of Object.entries(p?.stage_nodes ?? {})) {
      if (table.nodes.some((n) => nodeValueMatches(sn?.node_key, n.key, n.name))) score += 1;
    }
    if (table.nodes.some((n) => nodeValueMatches(p?.terminal?.node_key, n.key, n.name))) score += 2;
    if (score > bestScore) { best = name; bestScore = score; }
  }
  return bestScore > 0 ? best : null;
}

/**
 * get-node 全表 → 节点序列 + 子任务（一次调用，形状 M1 #29/#32 实测：
 * data.list 元素 basic.{name,node_key,status} + sub_tasks[]）。tasks 附带
 * points/owner（流转必填自动补齐用：估分总和=按人估分建议值；owner 空/含我
 * =推进语义可代勾，他人任务不代勾）。
 * @param {any} data
 * @returns {{nodes: {key: string, name: string, status: string}[], tasks: {id: string, title: string, state: string, nodeKey: string, points: number, owner: string[]}[]}}
 */
/** sub_tasks.owner 字段（JSON 字符串 '[{"username":"…"}]'）→ username 数组。 */
function parseOwnerUsernames(owner) {
  if (typeof owner !== 'string' || owner === '') return [];
  try {
    const arr = JSON.parse(owner);
    return Array.isArray(arr) ? arr.map((o) => String(o?.username ?? '')).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function parseNodeTable(data) {
  const list = Array.isArray(data) ? data : (data?.nodes ?? data?.node_list ?? data?.list ?? null);
  const nodes = [];
  const tasks = [];
  const byId = new Map();
  if (!Array.isArray(list)) return { nodes, tasks };
  for (const n of list) {
    const b = n?.basic ?? n;
    const key = b?.node_key ?? b?.node_id ?? n?.key;
    const name = b?.name ?? '';
    const status = b?.status ?? '';
    if (typeof key === 'string' && typeof status === 'string') {
      nodes.push({ key, name: String(name), status });
    }
    for (const t of (Array.isArray(n?.sub_tasks) ? n.sub_tasks : [])) {
      const id = String(t?.sub_task_id ?? t?.id ?? '');
      if (id !== '' && !byId.has(id)) {
        byId.set(id, {
          id,
          title: String(t?.sub_task_name ?? t?.title ?? t?.name ?? ''),
          state: t?.is_finished === true || t?.status === 'done' || t?.status === 'finished' ? 'completed' : 'open',
          nodeKey: key ?? '',
          points: Number(t?.points ?? 0) || 0,
          owner: parseOwnerUsernames(t?.owner),
        });
      }
    }
  }
  return { nodes, tasks: [...byId.values()] };
}

/** workitem get 输出 → {title, type_key}（形状 M1 #28 已回填：meegle 1.0.23 实测
 *  title = work_item_attribute.work_item_name，type_key = work_item_attribute.work_item_type.key）。 */
function parseWorkItem(data) {
  const attr = data?.work_item_attribute ?? {};
  const templateId = attr?.template?.id ?? data?.template?.id ?? null;
  return {
    title: data?.name ?? data?.title ?? attr?.work_item_name ?? null,
    type_key: data?.work_item_type_key ?? data?.work_item_type ?? attr?.work_item_type?.key ?? null,
    // R5 实测：work_item_attribute.template = {id, name}（workitem get 返回全量属性，
    // --fields 过滤不生效——template 零额外往返即可读，链 7131752604/7131398378 验证）
    template_id: templateId == null ? null : String(templateId),
  };
}

/**
 * 真实通道 createCore。
 * @param {{config?: any, profile?: string}} [opts]
 */
export function createRealCore(opts = {}) {
  const { config } = resolveConfigCtx(opts);

  /** profile 的 stage_nodes/terminal 配置段。 */
  const feishuProfile = (profile) => config?.feishu?.profiles?.[profile] ?? null;

  /**
   * 阶段/终态 → 候选节点集合（表序）。node_key 精确值直取（string 或 string[]
   * ——数组用于同阶段多节点，如 tech 链「需求关键信息确认 + 技术评审」都算 prd，
   * 卡点#14：中间节点无映射 → 阶段 null → 一致性校验拦 handoff）；`*后缀`
   * 名称模式（R5：key 实为模板预置稳定值，模式的价值 = 并行 OR 分支开发节点
   * 的落位判定 = 任一 doing，模板加节点自动适应）。
   * @param {string | null} profile
   * @param {string} stage  阶段 id 或 'done'（terminal）
   * @param {{nodes: {key: string, name: string, status: string}[]}} table
   */
  function targetNodes(profile, stage, table) {
    const conf = feishuProfile(profile);
    const value = stage === 'done' ? conf?.terminal?.node_key : conf?.stage_nodes?.[stage]?.node_key;
    if (Array.isArray(value)) {
      // 数组：全部按精确 key 匹配（元素混入模式串也按名称后缀处理）——按声明序
      // 展开（targets[0] = 声明序首个；get-node 表序不稳定（M1 实测），入口任务
      // 勾选的 target 定位依赖声明序——表序会把后续节点顶到首位勾错位置）
      return value.flatMap((v) => table.nodes.filter((n) => (v.startsWith('*') ? n.name.endsWith(v.slice(1)) : n.key === v)));
    }
    if (!value || typeof value !== 'string' || value.startsWith('<')) {
      throw new SdlcError('validation_failed', `profile ${profile ?? '(未定)'} 未配置阶段 ${stage} 的 node_key 映射（v5 主映射）——请补 .sdlc/config.yaml`);
    }
    if (!value.startsWith('*')) return table.nodes.filter((n) => n.key === value);
    const suffix = value.slice(1); // `*开发` → 名称以「开发」结尾的节点
    return table.nodes.filter((n) => n.name.endsWith(suffix));
  }

  /** 一次 get-node 全表（含子任务——readState 与任务同步共用，免二次往返）。 */
  async function fetchNodeTable(reqId, { needSubTasks = true } = {}) {
    const pk = projectKeyOf(config);
    const args = ['workflow', 'get-node', '--project-key', pk, '--work-item-id', String(reqId), '--node-id-list', '["_all"]'];
    if (needSubTasks) args.push('--need-sub-task');
    const raw = await runMeegle(args);
    return parseNodeTable(raw.data);
  }

  /**
   * 需求状态回读（get-node 全表 + workitem 字段并行；远端无版本——v5 观察链本地维护）。
   * @returns {Promise<{profile: string|null, title: string|null, current_stage: string|null, completion_status: string, doingNode: {key: string, name: string}|null, table: any}>}
   */
  async function readState(reqId, profileHint) {
    const pk = projectKeyOf(config);
    // 子任务与节点表同一次调用；标题字段并行（requirementState 也复用本表——两次往返顶过去三次串行）。
    // profile：hint（meta.profile）优先，否则按 workitem 类型匹配（bind 前无 hint 的主路径）
    const [table, itemRaw] = await Promise.all([
      fetchNodeTable(reqId),
      runMeegle(['workitem', 'get', '--project-key', pk, '--work-item-id', String(reqId), '--fields', '["name"]']),
    ]);
    const item = parseWorkItem(itemRaw.data);
    // profile 解析链：hint（meta.profile）> 模板 id 直查（R5 预置映射，强证据）
    // > 节点集自适应（story 多套流程模板——R4b 实测 7131600756 节点集与 type key
    // 同的 7131581708 互斥）> 类型匹配（bind 前主路径）> 单 profile 兜底
    const profile = (profileHint && (config?.feishu?.profiles ?? {})[profileHint] ? profileHint : null)
      ?? profileByTemplate(config, item.template_id)
      ?? profileByTable(config, table)
      ?? profileByType(config, item.type_key)
      ?? resolveProfile(config, null);
    // 当前阶段 = 映射节点 status=doing 的阶段（模式匹配取 doing 候选）；无 doing 按终态判断完成
    const stages = Object.keys(feishuProfile(profile)?.stage_nodes ?? {});
    let current = null;
    for (const s of stages) {
      if (targetNodes(profile, s, table).some((n) => n.status === 'doing')) { current = s; break; }
    }
    const doingNode = table.nodes.find((n) => n.status === 'doing') ?? null;
    const terminalKey = feishuProfile(profile)?.terminal?.node_key;
    const terminalFinished = terminalKey ? table.nodes.some((n) => n.key === terminalKey && n.status === 'finished') : false;
    return {
      profile,
      title: item.title,
      current_stage: current ?? (terminalFinished ? 'done' : null),
      completion_status: terminalFinished ? 'verified' : 'pending', // 飞书终态回读（契约 §2 完成态证据）
      doingNode,
      table,
    };
  }

  /** 懒必填查询：transition 被拒时补查节点流转必填清单（list-state-required），消息升级为「缺什么」。 */
  async function describeRequired(pk, reqId, node) {
    try {
      const r = await runMeegle(['workflow', 'list-state-required', '--project-key', pk, '--work-item-id', String(reqId), '--state-key', node.key]);
      const list = Array.isArray(r.data) ? r.data : (r.data?.list ?? r.data?.required_fields ?? null);
      if (Array.isArray(list) && list.length > 0) {
        const items = list.map((f) => (typeof f === 'string' ? f : (f?.name ?? f?.field_key ?? f?.key ?? JSON.stringify(f)))).join('、');
        return `节点「${node.name || node.key}」流转需先填写：${items}——请到飞书补填后重跑本命令（CLI 不代填伪数据）`;
      }
      return null;
    } catch {
      return null; // 必填查询失败不掩盖原始错误
    }
  }

  /** list-state-required 结构化（describeRequired 的可编程版；失败 null 不掩盖原错误）。 */
  async function fetchRequiredRaw(pk, reqId, nodeKey) {
    try {
      const r = await runMeegle(['workflow', 'list-state-required', '--project-key', pk, '--work-item-id', String(reqId), '--state-key', nodeKey]);
      return r.data ?? null;
    } catch {
      return null;
    }
  }

  /** 结论启发式：节点名匹配（部署→已部署、发布→发布成功、否则已通过）。 */
  function pickConclusionName(nodeName) {
    const n = String(nodeName ?? '');
    if (n.includes('部署')) return '已部署';
    if (n.includes('发布')) return '发布成功';
    return '已通过';
  }

  const cachedConclusionOpts = {}; // 结论字段名 → 选项集缓存（分桶——字段名随模板不同）
  /** 结论字段选项集（meta-node-fields 按实际字段名动态查——非 system 前缀
   * option_id 空间级不同不可写死；失败 → 空集，结论不自动填走转述）。字段名
   * 含 conclusion 即结论类（node_finished_conclusion / owners_node_finished_
   * conclusion 多负责人变体——R4c 实测 story2 state_10）。 */
  async function conclusionOptions(profile, fieldName = 'node_finished_conclusion') {
    if (cachedConclusionOpts[fieldName] !== undefined) return cachedConclusionOpts[fieldName];
    cachedConclusionOpts[fieldName] = [];
    const typeKey = feishuProfile(profile)?.work_item_type_key;
    if (!typeKey) return cachedConclusionOpts[fieldName];
    try {
      const r = await runMeegle(['workflow', 'meta-node-fields', '--project-key', projectKeyOf(config), '--work-item-type', typeKey, '--field-keys', JSON.stringify([fieldName])]);
      const list = Array.isArray(r.data) ? r.data : (r.data?.list ?? r.data?.fields ?? null);
      const f = (Array.isArray(list) ? list : []).find((x) => (x?.field_key ?? x?.key) === fieldName);
      const opts = f?.options ?? f?.option ?? f?.option_list ?? f?.field_options ?? null;
      if (Array.isArray(opts)) {
        cachedConclusionOpts[fieldName] = opts
          .map((o) => ({ id: String(o?.option_id ?? o?.id ?? o?.value ?? ''), name: String(o?.option_name ?? o?.name ?? o?.label ?? '') }))
          .filter((o) => o.id !== '' && o.name !== '');
      }
    } catch { /* 选项集不可达 → 空集走转述 */ }
    return cachedConclusionOpts[fieldName];
  }

  /**
   * 流转必填自动补齐（R4b BQL 三成因——子任务未全完成/节点完成结论/按人估分排期；
   * 结论值域按节点不同，填错不报错但不触发流转）。结论按节点名启发式从动态选项集
   * 按名取 id；估分=节点子任务估分总和（无任务兜底 1）、负责人取必填回显的
   * not_finished_owner（--schedules 按人差异化，R4b 实测通道）；任务勾选仅限
   * owner 空/含我（推进语义可代勾，他人任务不代勾→stop）；owner 必填不可自动
   * （可选范围限制）→ stop 转述。补齐幂等（重填同值/重复勾选无害）；tried 限
   * 每类一次/节点——BQL 场景结论覆盖重填一次即止，再拒走转述。future=true 时
   * 只做 ①④⑤（结论/owner 转述/form_items）——未开始节点的估分与任务不代填代勾
   *（BQL 拒因可在后续节点，R4c 实测 story2 state_9 流转拒因 state_10 结论未填）。
   * @param {string} pk @param {string} reqId @param {string|null} profile
   * @param {{key: string, name: string}} node @param {Set<string>} tried
   * @param {boolean} [future] 未开始节点的前置补齐模式
   * @returns {Promise<{filled: string[], stop: string|null}>}
   */
  async function autoFillRequired(pk, reqId, profile, node, tried, future = false) {
    const st = await fetchRequiredRaw(pk, reqId, node.key);
    const filled = [];
    let stop = null;
    if (!st) return { filled, stop };
    const fields = Array.isArray(st?.node_fields) ? st.node_fields : (Array.isArray(st) ? st : []);
    const reqTasks = Array.isArray(st?.tasks) ? st.tasks : [];
    let fullCache = null; // get-node 全表（②③懒取共用一次）
    const getFull = () => (fullCache ??= fetchNodeTable(reqId));
    // ① 节点完成结论（字段名含 conclusion 即结论类——node_finished_conclusion /
    // owners_node_finished_conclusion 多负责人变体，R4c 实测 story2 state_10）：
    // 不按 finished 判断（填错值也回显 finished——BQL 场景需覆盖重填）。
    // R4c 教训：值不在该节点选项集=无效值（写 success 不报错但流转不动——节点
    // 选项集是全局集子集，CLI 不可知）——候选轮换：填后流转仍被拒则下一轮换
    // 候选重填（tried 按候选 id 记）；候选=启发式名 → system_passed → 选项集
    // 其余完成语义项（排除「未通过/失败」类否定语义），穷尽走转述
    const fkey = (f) => String(f?.field_key ?? f?.key ?? '');
    for (const cf of fields.filter((f) => /conclusion/.test(fkey(f)))) {
      const ck = fkey(cf);
      const want = pickConclusionName(node.name);
      const opts = await conclusionOptions(profile, ck);
      const ranked = [
        opts.find((o) => o.name === want),
        opts.find((o) => o.id === 'system_passed'),
        ...opts.filter((o) => o.name !== want && o.id !== 'system_passed' && !/未|失败/.test(o.name)),
      ].filter(Boolean);
      const hit = ranked.find((o) => !tried.has(`concl:${ck}:${node.key}:${o.id}`));
      if (!hit) continue;
      tried.add(`concl:${ck}:${node.key}:${hit.id}`);
      if (ck.startsWith('owners_')) {
        // owners 变体=复合字段 owners_finished_info 的子字段：直写子字段名不落地
        //（R4c 实测），须按人分桶写复合字段（field_value=JSON 字符串）；缺结论的
        // 人从 not_finished_owner 取（明示谁缺），空则退 user me
        let owners = Array.isArray(cf?.not_finished_owner) ? cf.not_finished_owner.map(String).filter(Boolean) : [];
        if (owners.length === 0) {
          try { const me = await runMeegle(['user', 'me']); owners = [String(me.data?.user_key ?? me.data?.user?.user_key ?? '')].filter(Boolean); } catch { /* 不可达→空 */ }
        }
        if (owners.length > 0) {
          const compound = {};
          for (const u of owners) compound[u] = [{ field_key: ck, field_type: 'select', field_value: hit.id }];
          await runMeegle(['workflow', 'update-node', '--project-key', pk, '--work-item-id', String(reqId), '--node-id', node.key, '--fields', JSON.stringify([{ field_key: 'owners_finished_info', field_value: JSON.stringify(compound) }])]);
          filled.push(`节点「${node.name}」负责人结论=${hit.name}（${owners.length} 人）`);
        }
      } else {
        await runMeegle(['workflow', 'update-node', '--project-key', pk, '--work-item-id', String(reqId), '--node-id', node.key, '--fields', JSON.stringify([{ field_key: ck, field_value: hit.id }])]);
        filled.push(`节点「${node.name}」结论=${hit.name}`);
      }
    }
    // ② 节点估分排期（ErrScheduleRequired/ErrPointCheck）——**任务级通道**
    //（R4d 链 2 实测破译：任务填估分/排期后节点总估分/总排期自动汇总更新；
    // update-node --schedules 返回 success 但不落地=假通道，弃）。无任务 → 创建
    // 默认执行任务（估分 1 人天、排期今日~+1 天、负责人=本人——落地即自动汇总，
    // 勾选交 ③/下轮）；有任务 → 给零估分任务补估分排期。future 跳过（未开始
    // 节点的排期不代填，流转到该节点时再补）
    const sched = future ? null : fields.find((f) => (fkey(f) === 'point' || fkey(f) === 'schedule') && f?.finished === false);
    if (sched && !tried.has(`sched:${node.key}`)) {
      tried.add(`sched:${node.key}`);
      const full = await getFull();
      const nodeTasks = full.tasks.filter((t) => t.nodeKey === node.key);
      let myKey = '';
      try { const me = await runMeegle(['user', 'me']); myKey = String(me.data?.user_key ?? me.data?.user?.user_key ?? ''); } catch { /* 不可达→不设负责人 */ }
      const estimateKey = config?.feishu?.estimate_field_key ?? 'points';
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const startMs = start.getTime();
      if (nodeTasks.length === 0) {
        const endMs = startMs + 86_400_000;
        const args = ['subtask', 'update', '--action', 'create', '--project-key', pk, '--work-item-id', String(reqId), '--node-id', node.key, '--fields', JSON.stringify([{ field_key: 'name', field_value: '测试执行' }, { field_key: estimateKey, field_value: '1' }])];
        if (myKey) args.push('--assignee', JSON.stringify([myKey]));
        args.push('--schedule', JSON.stringify({ estimate_start_date: startMs, estimate_end_date: endMs }));
        await runMeegle(args);
        filled.push(`节点「${node.name}」无子任务——创建默认执行任务「测试执行」（估分 1 人天，节点总估分/总排期自动汇总）`);
      } else {
        let patched = 0;
        for (const t of nodeTasks.filter((x) => !x.points)) {
          const endMs = startMs + 86_400_000;
          await runMeegle(['subtask', 'update', '--action', 'update', '--project-key', pk, '--work-item-id', String(reqId), '--node-id', node.key, '--task-id', t.id, '--fields', JSON.stringify([{ field_key: estimateKey, field_value: '1' }]), '--schedule', JSON.stringify({ estimate_start_date: startMs, estimate_end_date: endMs })]);
          patched += 1;
        }
        if (patched > 0) filled.push(`节点「${node.name}」${patched} 个任务补估分排期（1 人天，节点汇总自动更新）`);
      }
    }
    // ③ 节点下未完成子任务：owner 空/含我可代勾（推进语义）；他人任务不代勾
    //（future 跳过——未开始节点的任务不代勾，流转到该节点时再勾）。
    // 入口任务不代勾（R4d 链 1 教训：勾「确认进入开发」即认领并触发节点完成
    // 流转——节点被放走、后建任务无人勾）——时序强控：入口任务勾选只走
    // tasks_split 尾段（子任务已创建后统一勾）。节点下 open 任务全是入口任务 →
    // stop 转述「先拆任务再推进」
    const entryNames = new Set(Object.values(feishuProfile(profile)?.stage_nodes ?? {}).flatMap((s) => (Array.isArray(s?.entry_tasks) ? s.entry_tasks : [])));
    const opens = future ? [] : reqTasks.filter((t) => t?.finished === false);
    if (opens.length > 0 && !tried.has(`tasks:${node.key}`)) {
      tried.add(`tasks:${node.key}`);
      const full = await getFull();
      let myKey = '';
      try { const me = await runMeegle(['user', 'me']); myKey = String(me.data?.user_key ?? me.data?.user?.user_key ?? ''); } catch { /* 身份未取到——只勾无主任务 */ }
      const stuck = [];
      let devOpens = 0;
      for (const ot of opens) {
        const task = full.tasks.find((t) => t.id === String(ot?.task_id ?? ot?.id ?? ''));
        if (!task) continue;
        if (entryNames.has(task.title)) continue; // 入口任务：tasks_split 尾段勾，代勾会放走节点
        devOpens += 1;
        const owners = task.owner ?? [];
        if (owners.length === 0 || (myKey !== '' && owners.includes(myKey))) {
          await runMeegle(['subtask', 'update', '--action', 'confirm', '--project-key', pk, '--work-item-id', String(reqId), '--node-id', task.nodeKey, '--task-id', task.id]);
          filled.push(`勾选任务「${task.title}」`);
        } else {
          stuck.push(`「${task.title}」（负责人 ${owners.join('、')}）`);
        }
      }
      if (stuck.length > 0) {
        stop = `节点「${node.name}」子任务未完成且负责人非本人：${stuck.join('、')}——需负责人完成或明确授权代勾`;
      } else if (devOpens === 0) {
        stop = `节点「${node.name}」下尚无开发子任务（仅入口任务未勾）——先拆分任务（dev/tasks.md 带 sdlc:tasks 标记）保存同步后再推进；入口任务须在子任务创建后勾选（勾选即触发节点完成流转，先勾会把节点放走、后建任务无人勾）`;
      }
    }
    // ④ owner 必填：可选范围限制不可自动指定——stop 转述（R4b 实测 story 链卡点）；
    // 排除结论类字段名（owners_node_finished_conclusion 含 owner 子串会误报）
    const ownerField = fields.find((f) => fkey(f).includes('owner') && !/conclusion/.test(fkey(f)) && f?.finished === false);
    if (ownerField) {
      stop = stop ?? `节点「${node.name}」负责人未填（可选范围限制，CLI 不代指定）——请在飞书页面设置节点负责人后重试`;
    }
    // ⑤ form_items（需求实体级必填——ErrFieldRequired 的常见面：交付计划完成
    // 日期等模板必填，字段 key 随流程模板不同不可写死）。date 类补合理默认
    //（今日 +7 天——模拟推进语义的排期占位）；其余类型（select 值域/参与人）
    // 不可猜 → stop 转述。通道 workitem update --fields（update-node 写不到实体
    // 层，R4b 实测 7131432757 field_56804b）
    for (const f of (Array.isArray(st?.form_items) ? st.form_items : [])) {
      const k = String(f?.key ?? f?.field_key ?? '');
      const type = String(f?.field_type_key ?? f?.field_type ?? '');
      if (k !== '' && f?.finished === false && !tried.has(`form:${k}`)) {
        tried.add(`form:${k}`);
        if (type === 'date') {
          const ms = Date.now() + 7 * 86_400_000;
          await runMeegle(['workitem', 'update', '--project-key', pk, '--work-item-id', String(reqId), '--fields', JSON.stringify([{ field_key: k, field_value: String(ms) }])]);
          filled.push(`需求字段 ${k}（date）=默认今日+7天`);
        } else {
          // select 类试探无效值：服务端校验报错内嵌 field_name+合法值（无写入）——
          // 转述用字段名而非裸 key（R4c 实测 field_0c456c→「是否需要配置告警及监控机制」）
          let desc = `${k}（${type || '未知类型'}）`;
          if (type === 'select') {
            try {
              await runMeegle(['workitem', 'update', '--project-key', pk, '--work-item-id', String(reqId), '--fields', JSON.stringify([{ field_key: k, field_value: '__probe__' }])]);
            } catch (e) {
              const nm = /"field_name":"([^"]+)"/.exec(String(e?.message ?? ''));
              if (nm) desc = `${nm[1]}（${k}）`;
            }
          }
          stop = stop ?? `需求级必填字段 ${desc} 未填且不可自动——请在飞书补填后重试`;
        }
      }
    }
    return { filled, stop };
  }

  /**
   * 追赶流转（§3.1 v2）：ensure-语义——从当前 doing 节点连续 confirm（或回退
   * rollback）直到目标阶段节点落位 doing；已落位幂等重放；他人已推进超过目标
   * 同样视为达成；节点必填缺失停下如实转述（懒查必填清单）。步数保护 = 节点数+2。
   * story 链激活（R4 实测 7131581708）：前一节点流转后下一节点 not_started、
   * 不自动 doing——勾入口任务即开发认领（节点转 doing），无 doing 时以入口
   * 任务激活续推（tech 链流转自动串行，不走该分支）。
   * @param {string} reqId @param {string|null} profile @param {string} to  目标阶段或 'done'
   * @param {'confirm'|'rollback'} action @param {string[]} [extraArgs]
   * @param {string[]} [entryTasks] 目标阶段入口任务名（激活用；rollback 不传）
   */
  async function advanceTo(reqId, profile, to, action, extraArgs = [], entryTasks = []) {
    const pk = projectKeyOf(config);
    const maxSteps = 16; // ponytail: 节点表上限保护（dida 流程 ≤8 节点，双倍余量），防异常死循环
    let stepped = false;
    let waitAfterActivate = 0; // 勾选激活后的异步落位等待轮（R4 实测：勾后节点转 doing 有服务端延迟）
    const autoTried = new Set(); // 流转必填自动补齐防重（每类一次/节点——BQL 结论覆盖重填一次即止）
    const probedNodes = new Set(); // future 前置探查防重（每未开始节点只查一次必填清单）
    let lastStop = null; // 补齐时的不可自动项转述（filled 非空轮被 continue 吞掉——跨轮保留到最终抛）
    for (let i = 0; i <= maxSteps; i++) {
      const table = await fetchNodeTable(reqId, { needSubTasks: false }); // 轮回间只看节点，轻量
      const targets = targetNodes(profile, to, table);
      if (targets.some((n) => n.status === 'doing')) {
        return { idempotent: !stepped, node_status: 'finished' };
      }
      if (targets.length > 0 && targets.every((n) => n.status === 'finished') && action === 'confirm') {
        // 目标节点已 finished 且无 doing（超过目标/双 doing 竞态余留）——视为已达成。
        // 仅 confirm 方向：rollback 时目标 finished 恰说明尚未退到位（R4b 实测
        // 7131432757 回退 dev——dev 节点 finished 被误判「已在位」，实际 test 节点
        // 还在 doing），须继续回退流转直到目标 doing
        return { idempotent: true, node_status: 'finished' };
      }
      const cur = table.nodes.find((n) => n.status === 'doing');
      if (!cur) {
        // 过冲达成（R4d 链 1：流转直冲终态全 finished 无 doing——上方 targets.every
        // 判定接不住目标节点不在表/表序未映射的场景）——终态 finished 即视为已
        // 达成（仅 confirm 方向；rollback 时终态 finished 恰说明未退到位）
        const terminalKey = feishuProfile(profile)?.terminal?.node_key;
        if (action === 'confirm' && terminalKey && table.nodes.some((n) => n.key === terminalKey && n.status === 'finished')) {
          return { idempotent: true, node_status: 'finished' };
        }
        // 无 doing：story/tech 链待认领态——勾目标节点入口任务激活（已勾/无入口
        // 任务则维持原错误；勾后 continue 重查，目标应转 doing）
        if (entryTasks.length > 0 && targets.length > 0) {
          const full = await fetchNodeTable(reqId);
          const target = targets[0];
          const opens = full.tasks.filter((t) => t.nodeKey === target.key && entryTasks.includes(t.title) && t.state === 'open');
          if (opens.length > 0) {
            for (const t of opens) {
              await runMeegle(['subtask', 'update', '--action', 'confirm', '--project-key', pk, '--work-item-id', String(reqId), '--node-id', t.nodeKey, '--task-id', t.id]);
            }
            stepped = true;
            waitAfterActivate = 3; // 勾选后异步转 doing：最多等 3 轮 × 2s
            continue;
          }
          if (waitAfterActivate > 0 && full.tasks.some((t) => t.nodeKey === target.key && entryTasks.includes(t.title) && t.state === 'completed')) {
            // 入口任务已勾（本函数刚勾或先前已勾）但节点未转 doing——异步落位中，等 2s 重查
            waitAfterActivate -= 1;
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
        }
        // 无 doing 也未落位：未开始/终态后——人工核对，不猜
        throw new SdlcError('validation_failed', `远端无进行中节点（目标 ${to} 未落位）——请人工核对飞书流程位置后重试`);
      }
      try {
        await runMeegle(['workflow', 'transition', '--node-id', cur.key, '--project-key', pk, '--work-item-id', String(reqId), '--action', action, ...extraArgs]);
        stepped = true;
      } catch (e) {
        // 流转被拒：先自动补齐（BQL 三成因——结论/任务/估分，R4b 实测口径；
        // 补齐发生即重试流转），补不动（owner/他人任务/已试过）才懒查必填清单
        // 升级消息转述停；其余原样上抛
        if (e instanceof SdlcError) {
          // 补齐链路自身异常 → 降级走 describeRequired 转述（不放大错误）
          let fill = { filled: [], stop: null };
          try { fill = await autoFillRequired(pk, reqId, profile, cur, autoTried); } catch { /* 降级转述 */ }
          // cur 必填全满足仍被拒：BQL 条件可在后续节点（R4c 实测 story2 state_9
          // 流转拒因 state_10 owners 结论未填）——对未开始节点前置补齐（future 模式
          // 只补结论/form_items/owner 转述），每节点只探一次
          if (fill.filled.length === 0 && !fill.stop) {
            for (const n of table.nodes.filter((x) => x.status === 'not_started')) {
              if (probedNodes.has(n.key)) continue;
              probedNodes.add(n.key);
              try {
                const nf = await autoFillRequired(pk, reqId, profile, n, autoTried, true);
                fill.filled.push(...nf.filled);
                if (nf.stop) fill.stop = fill.stop ?? nf.stop;
              } catch { /* 查不到跳过 */ }
            }
          }
          if (fill.filled.length > 0) {
            if (fill.stop) lastStop = fill.stop;
            console.log(`  ↳ 流转被拒，已自动补齐：${fill.filled.join('；')}——重试流转`);
            if (fill.stop) console.log(`  ⚠ 仍有不可自动补齐项：${fill.stop}`);
            stepped = true;
            continue;
          }
          if (fill.stop || lastStop) {
            throw new SdlcError('validation_failed', `${fill.stop ?? lastStop}（原始错误：${e.message.slice(0, 160)}）`);
          }
          const required = await describeRequired(pk, reqId, cur);
          if (required) throw new SdlcError('validation_failed', `${required}（原始错误：${e.message.slice(0, 160)}）`, e.details ?? null);
          // 必填清单无未满足项（或查询不可达）仍被拒：模板自定义 BQL 流转条件
          //（R4c 实测 story2 state_11→end——条件必填/迭代归属/工时等 CLI 不可枚举）
          //——转人工核对
          throw new SdlcError('validation_failed', `节点「${cur.name}」流转被拒（BQL 条件不满足）：可查必填项无缺口，可能是节点表单的条件必填（选「是」触发的关联字段）或模板自定义流转条件（迭代归属/工时等）——请在飞书界面核对后重试（原始错误：${e.message.slice(0, 120)}）`, e.details ?? null);
        }
        throw e;
      }
    }
    throw new SdlcError('external_unknown', `追赶推进超过 ${maxSteps} 步仍未到达 ${to}——结果未知，请人工核对飞书`);
  }

  return {
    mock: false,

    async me() {
      const r = await runMeegle(['user', 'me']);
      const key = r.data?.user_key ?? r.data?.user?.user_key;
      if (!key) throw new SdlcError('external_unknown', 'user me 输出无 user_key（形状与研读结论不符，M1 #28）——身份未核实');
      return { actor: { actor_id: String(key) } };
    },

    authStatus: meegleAuthStatus,

    async requirementState(reqId) {
      const st = await readState(reqId, opts.profile);
      if (st.current_stage === null && !st.title) {
        throw new SdlcError('not_found', `需求 ${reqId} 回读失败（不存在或无权限）`);
      }
      return {
        req_id: String(reqId),
        title: st.title,
        url: `https://project.feishu.cn/story/${reqId}`, // 展示用回读 URL（真实 URL 形状 M1 #28：url decode 反解）
        profile: st.profile,
        current_stage: st.current_stage,
        stage_version: null, // v5：远端无版本——journal 观察链本地维护
        doingNode: st.doingNode, // handoff 预览「无 doing 待认领」放行判定（story/tech 链语义）
        participants: {}, // 参与人读取能力 M1 #31 验证——不可用缺省（展示降级，授权飞书原生兜底）
        participants_source: 'feishu',
        completion_status: st.completion_status,
        tasks: st.table.tasks.map(({ id, title, state }) => ({ id, title, state })), // get-node 全表聚合（M1 #32）
      };
    },

    /** 阶段推进（追赶语义）：连续 confirm 到目标节点落位。story 链目标节点
     *  not_started（待认领）时勾入口任务激活（R4 实测：入口任务勾选=节点转
     *  doing 的认领开关）——entryTasks 由 handoff 计划传入；tasks_split 尾段
     *  的幂等勾选保留兜底（已勾 → no_op）。 */
    async advanceStage({ reqId, from, to, entryTasks, profile }) {
      const prof = profile ?? resolveProfile(config, opts.profile);
      const r = await advanceTo(reqId, prof, to, 'confirm', [], entryTasks ?? []);
      return { ...r, from_version: null, to_version: null, node_status: 'finished' };
    },

    /** 阶段回退（追赶对称）：连续 rollback 当前 doing 节点直到目标阶段落位；reason 留痕。 */
    async changeStage({ reqId, from, to, reason, profile }) {
      const prof = profile ?? resolveProfile(config, opts.profile);
      const extra = reason != null && String(reason) !== '' ? ['--rollback-reason', String(reason)] : [];
      const r = await advanceTo(reqId, prof, to, 'rollback', extra);
      return { ...r, from_version: null, to_version: null, node_status: 'finished' };
    },

    async splitTasks({ reqId, tasks }) {
      const pk = projectKeyOf(config);
      // 单次回读（旧版逐任务回读 N×3 spawn——实测循环轮次多的性能根因之一）
      const table = await fetchNodeTable(reqId);
      const existing = new Map(table.tasks.map((t) => [t.title, t]));
      const doingKey = table.nodes.find((n) => n.status === 'doing')?.key;
      if (!doingKey) {
        throw new SdlcError('validation_failed', `需求 ${reqId} 远端无进行中节点——无处挂新任务，请人工核对飞书流程位置`);
      }
      // 当前负责人（lazy 取一次缓存——create 时自动设负责人/排期/估分，R4 实测）；
      // 估分字段键可配（默认 points——create 场景值落地实测不稳定，字段名以空间
      // 配置为准，用户可在 feishu.estimate_field_key 调整）
      let myKey = null;
      try { const me = await runMeegle(['user', 'me']); myKey = me.data?.user_key ?? me.data?.user?.user_key ?? null; } catch { /* 未登录/失败——不带负责人，创建仍继续 */ }
      const estimateKey = config?.feishu?.estimate_field_key ?? 'points';
      const items = [];
      for (const t of tasks ?? []) {
        const found = existing.get(t.title);
        if (found) {
          items.push({ id: t.id, result: 'already_exists', remote_id: found.id });
          continue;
        }
        // v1.0.23 实测：--node-id 必填（挂当前 doing 节点）；字段条目形状
        // {field_key, field_value}——value 键会被服务端以「necessary field name
        // not found」拒绝（M1 #33 回填）。返回 ID 在顶层 r.data.ID。
        // assignee=[user_key 数组] → owner 落位；schedule 键 estimate_start_date/
        // estimate_end_date 值为毫秒时间戳（R4 实测，start=今日、end=今日+估分人天）。
        const est = typeof t.estimate === 'number' && t.estimate > 0 ? t.estimate : null;
        const fields = [{ field_key: 'name', field_value: String(t.title) }];
        if (est) fields.push({ field_key: estimateKey, field_value: String(est) });
        const args = ['subtask', 'update', '--action', 'create', '--project-key', pk, '--work-item-id', String(reqId), '--node-id', doingKey, '--fields', JSON.stringify(fields)];
        if (myKey) args.push('--assignee', JSON.stringify([myKey]));
        if (est) {
          const start = new Date(); start.setHours(0, 0, 0, 0);
          const startMs = start.getTime();
          const endMs = startMs + Math.round(est) * 86_400_000;
          args.push('--schedule', JSON.stringify({ estimate_start_date: startMs, estimate_end_date: endMs }));
        }
        const r = await runMeegle(args);
        const remoteId = r.data?.sub_task_id ?? r.data?.id ?? r.data?.ID ?? null;
        items.push({ id: t.id, result: 'created', remote_id: remoteId ? String(remoteId) : null });
      }
      return { items };
    },

    async checkTasks({ reqId, items, tasksMap = {} }) {
      const pk = projectKeyOf(config);
      const table = await fetchNodeTable(reqId); // 单次回读：remote_id/标题双查 + 节点归属（--node-id 必填）
      const byRemote = new Map(table.tasks.map((t) => [t.id, t]));
      const byTitle = new Map(table.tasks.map((t) => [t.title, t]));
      const out = [];
      for (const it of items ?? []) {
        const task = (it.remote_id ? byRemote.get(it.remote_id) : undefined)
          ?? (tasksMap[it.id] ? byRemote.get(tasksMap[it.id]) : undefined)
          ?? (it.title ? byTitle.get(it.title) : undefined);
        if (!task) {
          out.push({ id: it.id, result: 'not_found', remote_id: null });
          continue;
        }
        const target = it.state === 'cancelled' ? 'cancelled' : 'completed';
        if (task.state === target) {
          out.push({ id: it.id, result: 'no_op', remote_id: task.id });
          continue;
        }
        // v1.0.23：完成/回滚走 --task-id（任务 id）+ --node-id（所属节点 key）——非 --sub-task-id
        await runMeegle(['subtask', 'update', '--action', target === 'cancelled' ? 'rollback' : 'confirm', '--project-key', pk, '--work-item-id', String(reqId), '--node-id', task.nodeKey, '--task-id', task.id]);
        out.push({ id: it.id, result: target, remote_id: task.id });
      }
      return { items: out };
    },

    async completeRequirement({ reqId, completion, profile }) {
      const prof = profile ?? resolveProfile(config, opts.profile);
      if (!feishuProfile(prof)?.terminal?.node_key) {
        throw new SdlcError('validation_failed', `profile ${prof} 未配置 terminal.node_key——无法执行飞书终态 transition`);
      }
      // 幂等：终态已落（飞书终态回读）→ 重放；source 仅随 completion 记录留痕
      const st = await readState(reqId, prof);
      if (st.completion_status !== 'pending') {
        return { completion_status: completion.source === 'manual' ? 'manual' : completion.result, source: completion.source, idempotent: true };
      }
      const r = await advanceTo(reqId, prof, 'done', 'confirm');
      return { completion_status: completion.source === 'manual' ? 'manual' : completion.result, source: completion.source, idempotent: r.idempotent };
    },
  };
}
