// 事件版本模型、旧数据升级与离线交班合并引擎（纯函数，无副作用，可安全重试）

export type Role = 'analyst' | 'responder' | 'legal' | 'viewer';
export type Severity = 'medium' | 'high' | 'critical';
export type ActionKind = 'isolate' | 'block' | 'restore' | 'notify';
export type ActionStatus = 'pending' | 'approved' | 'executed';

export const ROLE_LABELS: Record<Role, string> = {
  analyst: '分析员',
  responder: '响应负责人',
  legal: '法务/公关',
  viewer: '访客'
};
export const WRITABLE_ROLES: Role[] = ['analyst', 'responder', 'legal'];

export interface TimelineEvent {
  id: string;
  at: string;
  actor: string;
  text: string;
  sensitive?: boolean;
}
export interface SubIncident {
  id: string;
  title: string;
  owner: string;
  status: 'open' | 'contained' | 'closed';
}
export interface ApprovalRecord {
  role: Role;
  at: string;
}
export interface IncidentContext {
  severity: Severity;
  affected: string[];
}
export interface ActionVersion {
  approvals: ApprovalRecord[];
  status: ActionStatus;
  rev: number;
  at: string;
  context?: IncidentContext;
}
export interface RejectedVersion extends ActionVersion {
  side: 'local' | 'remote';
  rejectedBy: Role;
  rejectedAt: string;
  shiftId: string;
}
export interface PendingConflict {
  shiftId: string;
  opIds: string[];
  base: ActionVersion;
  remote: ActionVersion;
  at: string;
}
export interface ResponseAction {
  id: string;
  title: string;
  kind: ActionKind;
  approvals: ApprovalRecord[];
  status: ActionStatus;
  sensitive?: boolean;
  rev: number;
  // 批准成立时的事件级别与影响资产指纹；与当前不一致则旧批准失效
  approvalContext?: IncidentContext;
  conflict?: PendingConflict;
  rejectedVersions: RejectedVersion[];
}
export interface Incident {
  id: string;
  version: number;
  title: string;
  severity: Severity;
  status: 'investigating' | 'contained' | 'recovered';
  affected: string[];
  subIncidents: SubIncident[];
  actions: ResponseAction[];
  timeline: TimelineEvent[];
}

// 断网期间的操作记录：既是本地待同步日志，也是对端快照里的交班内容
export type Operation =
  | { id: string; shiftId: string; at: string; base: number; type: 'approve'; actionId: string; role: Role; context: IncidentContext }
  | { id: string; shiftId: string; at: string; base: number; type: 'execute'; actionId: string; role: Role; context: IncidentContext }
  | { id: string; shiftId: string; at: string; base: number; type: 'addSub'; sub: SubIncident }
  | { id: string; shiftId: string; at: string; base: number; type: 'severity'; value: Severity }
  | { id: string; shiftId: string; at: string; base: number; type: 'affected'; added: string[]; removed: string[] };

export interface ShiftSnapshot {
  format: 'yf56-shift-v1';
  incidentId: string;
  shiftId: string;
  takenAt: string;
  base: Incident; // 共同基线（对端最后同步到的状态）
  result: Incident; // 对端应用离线操作后的状态
  ops: Operation[];
}

export interface MergeSummary {
  status: 'merged' | 'conflict';
  applied: string[];
  duplicates: string[];
  conflicts: { actionId: string; title: string }[];
  failed: { opId: string; reason: string }[];
  notes: string[];
  version: number;
}

let seq = 0;
export function genId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}-${Math.random().toString(36).slice(2, 7)}`;
}
const clone = <T,>(value: T): T => structuredClone(value);

export function contextOf(incident: Incident): IncidentContext {
  return { severity: incident.severity, affected: [...incident.affected].sort() };
}
export function contextKey(context: IncidentContext): string {
  return `${context.severity}|${[...context.affected].sort().join(',')}`;
}
export function isStale(action: ResponseAction, incident: Incident): boolean {
  return (
    action.status !== 'executed' &&
    action.approvals.length > 0 &&
    !!action.approvalContext &&
    contextKey(action.approvalContext) !== contextKey(contextOf(incident))
  );
}
export function distinctApprovers(action: ResponseAction): number {
  return new Set(action.approvals.map((item) => item.role)).size;
}
export function requiredApprovers(action: ResponseAction): number {
  return action.kind === 'isolate' ? 2 : 1;
}
export function recomputeStatus(action: ResponseAction): ActionStatus {
  if (action.status === 'executed') return 'executed';
  return distinctApprovers(action) >= requiredApprovers(action) ? 'approved' : 'pending';
}

export function pushTimeline(incident: Incident, event: Omit<TimelineEvent, 'id'>, cap = 40): Incident {
  return { ...incident, timeline: [{ ...event, id: genId('e') }, ...incident.timeline].slice(0, cap) };
}

// ---- 旧数据升级：无版本号的历史数据补成初始版本 v1，字符串审批补成结构化记录 ----
const LEGACY_AT = 'legacy';
export function upgradeIncident(raw: unknown): Incident {
  if (!raw || typeof raw !== 'object') throw new Error('事件数据为空，无法升级');
  const data = raw as Record<string, unknown>;
  const context: IncidentContext = {
    severity: (data.severity as Severity) ?? 'high',
    affected: Array.isArray(data.affected) ? (data.affected as string[]) : []
  };
  const actions = Array.isArray(data.actions) ? (data.actions as unknown[]) : [];
  return {
    id: String(data.id ?? 'INC-UNKNOWN'),
    version: typeof data.version === 'number' ? data.version : 1,
    title: String(data.title ?? '未命名事件'),
    severity: context.severity,
    status: (data.status as Incident['status']) ?? 'investigating',
    affected: context.affected,
    subIncidents: Array.isArray(data.subIncidents) ? (data.subIncidents as SubIncident[]) : [],
    timeline: Array.isArray(data.timeline) ? (data.timeline as TimelineEvent[]) : [],
    actions: actions.map((item) => {
      const a = item as Record<string, unknown>;
      const approvals = Array.isArray(a.approvals)
        ? (a.approvals as unknown[]).map((x): ApprovalRecord =>
            typeof x === 'string' ? { role: x as Role, at: LEGACY_AT } : (x as ApprovalRecord)
          )
        : [];
      const action: ResponseAction = {
        id: String(a.id ?? genId('act')),
        title: String(a.title ?? '未命名动作'),
        kind: (a.kind as ActionKind) ?? 'block',
        approvals,
        status: (a.status as ActionStatus) ?? 'pending',
        sensitive: Boolean(a.sensitive),
        rev: typeof a.rev === 'number' ? a.rev : 1,
        approvalContext: (a.approvalContext as IncidentContext) ?? context,
        rejectedVersions: Array.isArray(a.rejectedVersions) ? (a.rejectedVersions as RejectedVersion[]) : []
      };
      if (a.conflict) action.conflict = a.conflict as PendingConflict;
      return action;
    })
  };
}

// ---- 单条操作在事件状态上的应用（本地与合并共用，返回失败原因而不是抛错） ----
type ApplyResult = { ok: true; incident: Incident } | { ok: false; reason: string };

function applyApprove(incident: Incident, op: Extract<Operation, { type: 'approve' }>): ApplyResult {
  const action = incident.actions.find((item) => item.id === op.actionId);
  if (!action) return { ok: false, reason: `动作 ${op.actionId} 不存在` };
  if (op.role === 'viewer') return { ok: false, reason: '访客不能写入审批' };
  if (action.status === 'executed') return { ok: false, reason: `动作已执行：${action.title}` };
  if (action.approvals.some((item) => item.role === op.role)) {
    return { ok: true, incident }; // 同角色已批，幂等无写入
  }
  const next: ResponseAction = {
    ...action,
    approvals: [...action.approvals, { role: op.role, at: op.at }],
    approvalContext: op.context,
    rev: action.rev + 1
  };
  next.status = recomputeStatus(next);
  return {
    ok: true,
    incident: pushTimeline(
      { ...incident, actions: incident.actions.map((item) => (item.id === action.id ? next : item)) },
      { at: op.at, actor: ROLE_LABELS[op.role], text: `审批处置动作：${action.title}（事件 v${op.base}）` }
    )
  };
}

function applyExecute(incident: Incident, op: Extract<Operation, { type: 'execute' }>): ApplyResult {
  const action = incident.actions.find((item) => item.id === op.actionId);
  if (!action) return { ok: false, reason: `动作 ${op.actionId} 不存在` };
  if (op.role === 'viewer') return { ok: false, reason: '访客不能写入执行结果' };
  if (action.status === 'executed') return { ok: true, incident };
  const candidate = { ...action, approvalContext: op.context };
  if (recomputeStatus(candidate) !== 'approved') {
    return {
      ok: false,
      reason: `未达到批准条件：${action.title} 需 ${requiredApprovers(action)} 个不同角色确认，当前 ${distinctApprovers(action)} 个`
    };
  }
  const next: ResponseAction = { ...action, status: 'executed', rev: action.rev + 1 };
  return {
    ok: true,
    incident: pushTimeline(
      { ...incident, actions: incident.actions.map((item) => (item.id === action.id ? next : item)) },
      { at: op.at, actor: ROLE_LABELS[op.role], text: `执行处置动作：${action.title}（事件 v${op.base}）`, sensitive: action.sensitive }
    )
  };
}

function applyAddSub(incident: Incident, op: Extract<Operation, { type: 'addSub' }>): ApplyResult {
  if (incident.subIncidents.some((item) => item.id === op.sub.id)) return { ok: true, incident };
  return {
    ok: true,
    incident: pushTimeline(
      { ...incident, subIncidents: [...incident.subIncidents, op.sub] },
      { at: op.at, actor: '响应负责人', text: `创建子事件：${op.sub.title}（事件 v${op.base}）` }
    )
  };
}

// 级别或影响资产变化：旧批准失效，未执行动作回到待复核
export function applyContextChange(
  incident: Incident,
  patch: { severity?: Severity; affected?: string[] },
  at: string,
  textPrefix: string
): Incident {
  const next: Incident = {
    ...incident,
    severity: patch.severity ?? incident.severity,
    affected: patch.affected ?? incident.affected
  };
  const key = contextKey(contextOf(next));
  const invalidated: ResponseAction[] = [];
  next.actions = next.actions.map((action) => {
    if (action.status === 'executed' || action.approvals.length === 0) return action;
    if (action.approvalContext && contextKey(action.approvalContext) === key) return action;
    invalidated.push(action);
    return { ...action, approvals: [], status: 'pending' as ActionStatus, conflict: undefined, rev: action.rev + 1 };
  });
  if (!invalidated.length) return next;
  return pushTimeline(next, {
    at,
    actor: '系统',
    text: `${textPrefix}，以下动作旧批准失效并回到待复核：${invalidated.map((item) => item.title).join('、')}`
  });
}

export function applyOperation(incident: Incident, op: Operation): ApplyResult {
  switch (op.type) {
    case 'approve':
      return applyApprove(incident, op);
    case 'execute':
      return applyExecute(incident, op);
    case 'addSub':
      return applyAddSub(incident, op);
    case 'severity': {
      if (incident.severity === op.value) return { ok: true, incident };
      return {
        ok: true,
        incident: applyContextChange(incident, { severity: op.value }, op.at, `事件级别调整为 ${op.value}（事件 v${op.base}）`)
      };
    }
    case 'affected': {
      if (!op.added.length && !op.removed.length) return { ok: true, incident };
      const affected = [...incident.affected.filter((asset) => !op.removed.includes(asset)), ...op.added.filter((asset) => !incident.affected.includes(asset))];
      return {
        ok: true,
        incident: applyContextChange(incident, { affected }, op.at, `影响资产变化（事件 v${op.base}）`)
      };
    }
  }
}

// ---- 动作指纹：用于三方合并判断两边是否都改过同一动作 ----
function fingerprint(action: ResponseAction | undefined): string {
  if (!action) return '∅';
  return JSON.stringify({ status: action.status, roles: action.approvals.map((item) => item.role).sort() });
}
function toVersion(action: ResponseAction, at: string): ActionVersion {
  return { approvals: clone(action.approvals), status: action.status, rev: action.rev, at, context: action.approvalContext };
}

export function opSummary(op: Operation): string {
  switch (op.type) {
    case 'approve':
      return `审批动作 ${op.actionId}（${ROLE_LABELS[op.role]}）`;
    case 'execute':
      return `执行动作 ${op.actionId}（${ROLE_LABELS[op.role]}）`;
    case 'addSub':
      return `新增子事件「${op.sub.title}」`;
    case 'severity':
      return `事件级别调整为 ${op.value}`;
    case 'affected':
      return `影响资产变更 +${op.added.length}/-${op.removed.length}`;
  }
}

// 三方合并：local=本班次当前状态，snapshot.base=共同基线，snapshot.result=对端离线后状态
// 纯函数：成功才返回新事件；结构损坏直接抛错，由调用方保留待办
export function mergeShift(local: Incident, snapshot: ShiftSnapshot, appliedIds: ReadonlySet<string>): { incident: Incident; summary: MergeSummary } {
  if (!snapshot || snapshot.format !== 'yf56-shift-v1') throw new Error('交班快照格式无法识别');
  if (snapshot.incidentId !== local.id) throw new Error(`快照属于其他事件：${snapshot.incidentId}`);

  const base = upgradeIncident(snapshot.base);
  const remote = upgradeIncident(snapshot.result);
  const incident = clone(local);
  const applied: string[] = [];
  const duplicates: string[] = [];
  const conflicts: MergeSummary['conflicts'] = [];
  const failed: MergeSummary['failed'] = [];
  const notes: string[] = [];
  let current = incident;

  for (const op of snapshot.ops) {
    if (appliedIds.has(op.id)) {
      duplicates.push(op.id);
      continue;
    }
    if (op.type === 'approve' || op.type === 'execute') {
      const localAction = current.actions.find((item) => item.id === op.actionId);
      const baseAction = base.actions.find((item) => item.id === op.actionId);
      const remoteAction = remote.actions.find((item) => item.id === op.actionId);
      if (!localAction) {
        failed.push({ opId: op.id, reason: `动作 ${op.actionId} 在本班次不存在` });
        continue;
      }
      const localChanged = fingerprint(localAction) !== fingerprint(baseAction);
      const remoteChanged = fingerprint(remoteAction) !== fingerprint(baseAction);
      if (localChanged && remoteChanged && fingerprint(localAction) !== fingerprint(remoteAction)) {
        const existing = localAction.conflict;
        const conflict: PendingConflict = existing
          ? { ...existing, opIds: [...existing.opIds, op.id] }
          : {
              shiftId: snapshot.shiftId,
              opIds: [op.id],
              base: toVersion(baseAction ?? localAction, snapshot.takenAt),
              remote: toVersion(remoteAction ?? localAction, op.at),
              at: op.at
            };
        current = {
          ...current,
          actions: current.actions.map((item) => (item.id === op.actionId ? { ...item, conflict } : item))
        };
        if (!existing) {
          conflicts.push({ actionId: op.actionId, title: localAction.title });
          current = pushTimeline(current, {
            at: op.at,
            actor: '系统',
            text: `交班合并发现冲突：${localAction.title} 被两个班次同时修改，等待响应负责人裁决（对端班次 ${snapshot.shiftId.slice(0, 8)}）`
          });
        }
        continue;
      }
    }
    const result = applyOperation(current, op);
    if (!result.ok) {
      failed.push({ opId: op.id, reason: result.reason });
      continue;
    }
    current = result.incident;
    applied.push(op.id);
    if (op.type !== 'addSub') {
      // 结构性操作已在 applyOperation 内写时间线；补充对端来源标记
    }
  }

  // 对端带入的子事件/时间线补合并（去重）
  current.subIncidents = [...current.subIncidents, ...remote.subIncidents.filter((item) => !current.subIncidents.some((local) => local.id === item.id))];

  // 合并后再做一次旧批准清理（对端可能带着旧上下文中的审批）
  const before = current.actions.length;
  const key = contextKey(contextOf(current));
  current = {
    ...current,
    actions: current.actions.map((action) => {
      if (action.status === 'executed' || action.approvals.length === 0 || !action.approvalContext) return action;
      if (contextKey(action.approvalContext) === key) return action;
      return { ...action, approvals: [], status: 'pending' as ActionStatus, rev: action.rev + 1 };
    })
  };
  if (current.actions.some((action, i) => action !== incident.actions[i]) && before) {
    notes.push('部分审批基于旧级别/资产，已置为待复核');
  }

  const version = Math.max(local.version, base.version, remote.version) + 1;
  current.version = version;
  if (applied.length) notes.push(`已合并 ${applied.length} 条对端操作`);
  if (duplicates.length) notes.push(`跳过 ${duplicates.length} 条重试重复操作`);
  if (failed.length) notes.push(`${failed.length} 条操作未满足条件，保留待办`);

  return {
    incident: current,
    summary: { status: conflicts.length ? 'conflict' : 'merged', applied, duplicates, conflicts, failed, notes, version }
  };
}

// 负责人裁决冲突：采用一方，另一方作为未采用版本留档
export function resolveConflict(
  incident: Incident,
  actionId: string,
  choice: 'local' | 'remote',
  leader: Role,
  localShiftId: string
): { incident: Incident; resolvedOpIds: string[] } {
  const action = incident.actions.find((item) => item.id === actionId);
  if (!action || !action.conflict) throw new Error('该动作没有待裁决冲突');
  if (leader !== 'responder') throw new Error('只有响应负责人可以裁决冲突');
  const conflict = action.conflict;
  const at = new Date().toISOString();
  const localVersion: ActionVersion = toVersion(action, at);
  const dropped: RejectedVersion =
    choice === 'local'
      ? { ...conflict.remote, side: 'remote', rejectedBy: leader, rejectedAt: at, shiftId: conflict.shiftId }
      : { ...localVersion, side: 'local', rejectedBy: leader, rejectedAt: at, shiftId: localShiftId };
  const chosen = choice === 'local' ? localVersion : conflict.remote;
  const next: ResponseAction = {
    ...action,
    approvals: clone(chosen.approvals),
    status: chosen.status,
    approvalContext: chosen.context ?? action.approvalContext,
    conflict: undefined,
    rev: action.rev + 1,
    rejectedVersions: [...action.rejectedVersions, dropped]
  };
  next.status = chosen.status === 'executed' ? 'executed' : recomputeStatus(next);
  const updated = pushTimeline(
    { ...incident, version: incident.version + 1, actions: incident.actions.map((item) => (item.id === action.id ? next : item)) },
    {
      at,
      actor: ROLE_LABELS[leader],
      text: `冲突裁决：${action.title} 采用${choice === 'local' ? '本班次' : `对端班次 ${conflict.shiftId.slice(0, 8)}`}版本，另一版本已留档`
    }
  );
  return { incident: updated, resolvedOpIds: conflict.opIds };
}
