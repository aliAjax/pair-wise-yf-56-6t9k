import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Severity = 'medium' | 'high' | 'critical';
export type Role = 'analyst' | 'responder' | 'legal' | 'viewer';
export type ActionKind = 'isolate' | 'block' | 'restore' | 'notify';
export type ActionStatus = 'pending' | 'approved' | 'executed';

export interface TimelineEvent { id: string; at: string; actor: string; text: string; sensitive?: boolean; }
export interface SubIncident { id: string; title: string; owner: string; status: 'open' | 'contained' | 'closed'; }
export interface ResponseAction { id: string; title: string; kind: ActionKind; approvals: string[]; status: ActionStatus; sensitive?: boolean; }

export interface Incident {
  id: string;
  title: string;
  severity: Severity;
  status: 'investigating' | 'contained' | 'recovered';
  affected: string[];
  /** 事件版本号：每次变更递增，离线交班按此版本合并 */
  version: number;
  subIncidents: SubIncident[];
  actions: ResponseAction[];
  timeline: TimelineEvent[];
}

/** 离线待办（断网时记录的审批/执行结果，回网后合并） */
export interface OutboxOp {
  id: string;
  /** 幂等键：重试时据此判断是否已写入，避免重复审批 */
  idempotencyKey: string;
  kind: 'approve' | 'execute';
  actionId: string;
  actionTitle: string;
  role: Role;
  /** 记账时的事件版本 */
  baseVersion: number;
  /** 记账时动作快照（三方合并的基准） */
  actionSnapshot: { approvals: string[]; status: ActionStatus };
  createdAt: string;
  status: 'pending' | 'merged' | 'conflict' | 'failed';
  attempts: number;
  error?: string;
}

/** 版本冲突记录：同一动作被两个班次改过时保留，由负责人选定 */
export interface ConflictRecord {
  id: string;
  opId: string;
  actionId: string;
  actionTitle: string;
  kind: 'approve' | 'execute';
  role: Role;
  detectedAt: string;
  baseVersion: number;
  remoteVersion: number;
  /** 本地（待采用）版本 */
  local: { approvals: string[]; status: ActionStatus };
  /** 远端（当前）版本 */
  remote: { approvals: string[]; status: ActionStatus };
  status: 'open' | 'resolved-local' | 'resolved-remote';
  resolvedAt?: string;
  resolvedBy?: string;
}

/** 归档：未采用版本保留留档 */
export interface ArchivedVersion {
  id: string;
  conflictId: string;
  actionId: string;
  actionTitle: string;
  kind: 'approve' | 'execute';
  /** 被保留下来的是哪一方的版本 */
  retained: 'local' | 'remote';
  snapshot: { approvals: string[]; status: ActionStatus };
  reason: string;
  at: string;
}

interface State {
  incident: Incident;
  role: Role;
  demoMode: boolean;
  online: boolean;
  outbox: OutboxOp[];
  conflicts: ConflictRecord[];
  archive: ArchivedVersion[];
  setRole: (role: Role) => void;
  toggleDemo: () => void;
  setOnline: (online: boolean) => void;
  addSubIncident: (payload: { title: string; owner: string }) => void;
  approveAction: (id: string) => void;
  executeAction: (id: string) => void;
  reorderActions: (activeId: string, overId: string) => void;
  changeSeverity: (severity: Severity) => void;
  changeAffected: (affected: string[]) => void;
  tick: () => void;
  /** 回网后合并离线待办 */
  mergeOutbox: () => void;
  /** 合并失败后重试（幂等，不重复写入审批） */
  retryOp: (opId: string) => void;
  /** 负责人选定冲突版本，未采用版本留档 */
  resolveConflict: (conflictId: string, adopt: 'local' | 'remote') => void;
  /** 模拟远端班次变更（演示离线冲突用） */
  simulateRemoteShift: () => void;
}

/** 隔离动作需两个不同角色确认，其余动作需一个角色确认 */
function thresholdFor(kind: ActionKind): number {
  return kind === 'isolate' ? 2 : 1;
}

function newTimeline(actor: string, text: string, sensitive?: boolean): TimelineEvent {
  return { id: `e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: new Date().toISOString(), actor, text, sensitive };
}

/** 级别或影响资产变化后，旧批准失效，动作回到待复核 */
function invalidateApprovals(incident: Incident, reason: string): Incident {
  return {
    ...incident,
    version: incident.version + 1,
    actions: incident.actions.map((a) => ({ ...a, approvals: [], status: a.status === 'executed' ? 'executed' : 'pending' })),
    timeline: [newTimeline('响应负责人', `${reason}，旧批准已失效，动作回到待复核`), ...incident.timeline].slice(0, 50),
  };
}

const initial: Incident = {
  id: 'INC-2026-0929', title: '对外网关异常凭证使用', severity: 'critical', status: 'investigating', affected: ['api-gateway', 'customer-portal', 'audit-log'],
  version: 1,
  subIncidents: [
    { id: 'sub-1', title: '异常会话来源分析', owner: '分析组', status: 'open' },
    { id: 'sub-2', title: '受影响租户范围确认', owner: '平台组', status: 'open' }
  ],
  actions: [
    { id: 'act-1', title: '隔离异常网关节点', kind: 'isolate', approvals: ['analyst'], status: 'pending', sensitive: true },
    { id: 'act-2', title: '封禁可疑出口地址', kind: 'block', approvals: [], status: 'pending' },
    { id: 'act-3', title: '准备客户披露口径', kind: 'notify', approvals: ['legal'], status: 'pending', sensitive: true }
  ],
  timeline: [
    { id: 'e1', at: new Date(Date.now() - 1500000).toISOString(), actor: '告警平台', text: '检测到同一凭证跨三个地域登录', sensitive: true },
    { id: 'e2', at: new Date(Date.now() - 900000).toISOString(), actor: '值班分析员', text: '确认会话未经过常规办公出口' }
  ]
};

export const useIncidentStore = create<State>()(persist((set, get) => ({
  incident: initial, role: 'analyst', demoMode: false, online: true,
  outbox: [], conflicts: [], archive: [],
  setRole: (role) => set({ role }),
  toggleDemo: () => set((state) => ({ demoMode: !state.demoMode })),
  setOnline: (online) => set({ online }),
  addSubIncident: (payload) => { const state = get(); if (state.demoMode || state.role === 'viewer') return; set((state) => ({ incident: { ...state.incident, version: state.incident.version + 1, subIncidents: [...state.incident.subIncidents, { id: `sub-${Date.now()}`, ...payload, status: 'open' }], timeline: [newTimeline('响应负责人', `创建子事件：${payload.title}`), ...state.incident.timeline].slice(0, 50) } })); },
  approveAction: (id) => {
    const state = get();
    if (state.demoMode || state.role === 'viewer') return;
    const action = state.incident.actions.find((item) => item.id === id);
    if (!action || action.approvals.includes(state.role)) return;
    // 断网时若已有同幂等键的待办，不重复记账
    const idempotencyKey = `approve:${id}:${state.role}`;
    if (!state.online && state.outbox.some((op) => op.idempotencyKey === idempotencyKey && op.status === 'pending')) return;
    const baseVersion = state.incident.version;
    const nextApprovals = [...action.approvals, state.role];
    const nextStatus: ActionStatus = nextApprovals.length >= thresholdFor(action.kind) ? 'approved' : action.status;
    if (state.online) {
      set({ incident: { ...state.incident, version: baseVersion + 1, actions: state.incident.actions.map((item) => item.id === id ? { ...item, approvals: nextApprovals, status: nextStatus } : item), timeline: [newTimeline(state.role, `审批处置动作：${action.title}`), ...state.incident.timeline].slice(0, 50) } });
    } else {
      const op: OutboxOp = { id: `op-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, idempotencyKey, kind: 'approve', actionId: id, actionTitle: action.title, role: state.role, baseVersion, actionSnapshot: { approvals: action.approvals, status: action.status }, createdAt: new Date().toISOString(), status: 'pending', attempts: 0 };
      set({ outbox: [...state.outbox, op], incident: { ...state.incident, timeline: [newTimeline(state.role, `断网记账：审批处置动作「${action.title}」，回网后按版本 ${baseVersion} 合并`), ...state.incident.timeline].slice(0, 50) } });
    }
  },
  executeAction: (id) => {
    const state = get();
    if (state.demoMode || state.role === 'viewer') return;
    const action = state.incident.actions.find((item) => item.id === id);
    if (!action || action.status === 'executed') return;
    if (action.approvals.length < thresholdFor(action.kind)) return;
    const idempotencyKey = `execute:${id}`;
    if (!state.online && state.outbox.some((op) => op.idempotencyKey === idempotencyKey && op.status === 'pending')) return;
    const baseVersion = state.incident.version;
    if (state.online) {
      set({ incident: { ...state.incident, version: baseVersion + 1, actions: state.incident.actions.map((item) => item.id === id ? { ...item, status: 'executed' } : item), timeline: [newTimeline(state.role, `执行处置动作：${action.title}`, action.sensitive), ...state.incident.timeline].slice(0, 50) } });
    } else {
      const op: OutboxOp = { id: `op-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, idempotencyKey, kind: 'execute', actionId: id, actionTitle: action.title, role: state.role, baseVersion, actionSnapshot: { approvals: action.approvals, status: action.status }, createdAt: new Date().toISOString(), status: 'pending', attempts: 0 };
      set({ outbox: [...state.outbox, op], incident: { ...state.incident, timeline: [newTimeline(state.role, `断网记账：执行处置动作「${action.title}」，回网后按版本 ${baseVersion} 合并`, action.sensitive), ...state.incident.timeline].slice(0, 50) } });
    }
  },
  reorderActions: (activeId, overId) => { const state = get(); const actions = [...state.incident.actions]; const from = actions.findIndex((item) => item.id === activeId); const to = actions.findIndex((item) => item.id === overId); if (from < 0 || to < 0 || state.demoMode || state.role === 'viewer') return; const [moved] = actions.splice(from, 1); actions.splice(to, 0, moved); set({ incident: { ...state.incident, version: state.incident.version + 1, actions } }); },
  changeSeverity: (severity) => {
    const state = get();
    if (state.demoMode || state.role === 'viewer') return;
    if (state.incident.severity === severity) return;
    set({ incident: invalidateApprovals({ ...state.incident, severity }, `事件级别调整为 ${severity}`) });
  },
  changeAffected: (affected) => {
    const state = get();
    if (state.demoMode || state.role === 'viewer') return;
    set({ incident: invalidateApprovals({ ...state.incident, affected }, `影响资产变更为 ${affected.join('、') || '无'}`) });
  },
  tick: () => set((state) => ({ incident: { ...state.incident, timeline: [newTimeline('监测代理', `实时检查：${state.incident.affected.length} 项资产状态已更新`), ...state.incident.timeline].slice(0, 50) } })),
  mergeOutbox: () => {
    const state = get();
    if (!state.online) return;
    const pending = state.outbox.filter((op) => op.status === 'pending' || op.status === 'failed');
    if (pending.length === 0) return;
    // 冻结合并开始时的远端状态，用于判断远端是否改过同一动作
    const remoteIncident = state.incident;
    let incident = state.incident;
    const outbox = state.outbox.map((op) => ({ ...op }));
    const conflicts = [...state.conflicts];
    const notes: TimelineEvent[] = [];
    for (const op of outbox) {
      if (op.status !== 'pending' && op.status !== 'failed') continue;
      op.attempts += 1;
      try {
        const action = incident.actions.find((a) => a.id === op.actionId);
        if (!action) { op.status = 'failed'; op.error = '动作不存在'; continue; }
        // 幂等：效果已存在则直接标记合并，不重复写入审批
        if (op.kind === 'approve' && action.approvals.includes(op.role)) { op.status = 'merged'; op.error = undefined; continue; }
        if (op.kind === 'execute' && action.status === 'executed') { op.status = 'merged'; op.error = undefined; continue; }
        const remoteAction = remoteIncident.actions.find((a) => a.id === op.actionId);
        const remoteChanged = !remoteAction || JSON.stringify({ approvals: remoteAction.approvals, status: remoteAction.status }) !== JSON.stringify(op.actionSnapshot);
        if (remoteChanged) {
          // 远端班次也改了同一动作 → 保留冲突，由负责人选定
          const localApprovals = op.kind === 'approve' ? Array.from(new Set([...action.approvals, op.role])) : action.approvals;
          const localStatus: ActionStatus = op.kind === 'execute' ? 'executed' : (localApprovals.length >= thresholdFor(action.kind) ? 'approved' : action.status);
          conflicts.push({ id: `cf-${Date.now()}-${op.id}`, opId: op.id, actionId: op.actionId, actionTitle: op.actionTitle, kind: op.kind, role: op.role, detectedAt: new Date().toISOString(), baseVersion: op.baseVersion, remoteVersion: remoteIncident.version, local: { approvals: localApprovals, status: localStatus }, remote: { approvals: remoteAction?.approvals ?? [], status: remoteAction?.status ?? 'pending' }, status: 'open' });
          op.status = 'conflict';
          op.error = undefined;
          notes.push(newTimeline('交班合并', `动作「${op.actionTitle}」本地与远端版本冲突，已保留待负责人选定`));
          continue;
        }
        // 无冲突：应用本地结果
        if (op.kind === 'approve') {
          const nextApprovals = Array.from(new Set([...action.approvals, op.role]));
          const nextStatus: ActionStatus = nextApprovals.length >= thresholdFor(action.kind) ? 'approved' : action.status;
          incident = { ...incident, version: incident.version + 1, actions: incident.actions.map((a) => a.id === op.actionId ? { ...a, approvals: nextApprovals, status: nextStatus } : a) };
        } else {
          incident = { ...incident, version: incident.version + 1, actions: incident.actions.map((a) => a.id === op.actionId ? { ...a, status: 'executed' } : a) };
        }
        op.status = 'merged';
        op.error = undefined;
        notes.push(newTimeline('交班合并', `已合并${op.kind === 'approve' ? '审批' : '执行'}：${op.actionTitle}`));
      } catch (e) {
        op.status = 'failed';
        op.error = e instanceof Error ? e.message : '合并失败';
      }
    }
    set({ incident: { ...incident, timeline: [...notes.reverse(), ...incident.timeline].slice(0, 50) }, outbox, conflicts });
  },
  retryOp: (opId) => {
    const state = get();
    if (!state.online) return;
    const op = state.outbox.find((o) => o.id === opId);
    if (!op || (op.status !== 'failed' && op.status !== 'pending')) return;
    set({ outbox: state.outbox.map((o) => o.id === opId ? { ...o, status: 'pending', error: undefined } : o) });
    get().mergeOutbox();
  },
  resolveConflict: (conflictId, adopt) => {
    const state = get();
    if (state.demoMode || state.role === 'viewer') return;
    const cf = state.conflicts.find((c) => c.id === conflictId);
    if (!cf || cf.status !== 'open') return;
    let incident = state.incident;
    let archive = [...state.archive];
    if (adopt === 'local') {
      // 采用本地版本；远端版本留档
      incident = { ...incident, version: incident.version + 1, actions: incident.actions.map((a) => a.id === cf.actionId ? { ...a, approvals: cf.local.approvals, status: cf.local.status } : a) };
      archive.push({ id: `ar-${Date.now()}-${cf.id}`, conflictId, actionId: cf.actionId, actionTitle: cf.actionTitle, kind: cf.kind, retained: 'remote', snapshot: cf.remote, reason: '负责人选定采用本地版本，远端未采用版本保留留档', at: new Date().toISOString() });
    } else {
      // 保留远端版本；本地版本留档
      archive.push({ id: `ar-${Date.now()}-${cf.id}`, conflictId, actionId: cf.actionId, actionTitle: cf.actionTitle, kind: cf.kind, retained: 'local', snapshot: cf.local, reason: '负责人选定保留远端版本，本地未采用版本保留留档', at: new Date().toISOString() });
    }
    const outbox = state.outbox.map((o) => o.id === cf.opId ? { ...o, status: 'merged' as const } : o);
    const conflicts = state.conflicts.map((c) => c.id === conflictId ? { ...c, status: (adopt === 'local' ? 'resolved-local' : 'resolved-remote') as ConflictRecord['status'], resolvedAt: new Date().toISOString(), resolvedBy: state.role } : c);
    set({ incident: { ...incident, timeline: [newTimeline('响应负责人', `已处理动作「${cf.actionTitle}」版本冲突：${adopt === 'local' ? '采用本地版本' : '保留远端版本'}，未采用版本已留档`), ...incident.timeline].slice(0, 50) }, outbox, conflicts, archive });
  },
  simulateRemoteShift: () => {
    const state = get();
    if (state.demoMode || state.role === 'viewer') return;
    const candidates = state.incident.actions.filter((a) => a.status !== 'executed');
    if (candidates.length === 0) return;
    const action = candidates[Math.floor(Math.random() * candidates.length)];
    const remoteRole: Role = Math.random() > 0.5 ? 'responder' : 'analyst';
    const nextApprovals = Array.from(new Set([...action.approvals, remoteRole]));
    const canExecute = nextApprovals.length >= thresholdFor(action.kind) && Math.random() > 0.4;
    let nextActions: ResponseAction[];
    let text: string;
    if (canExecute) {
      nextActions = state.incident.actions.map((a) => a.id === action.id ? { ...a, approvals: nextApprovals, status: 'executed' } : a);
      text = `远端班次执行处置动作：${action.title}`;
    } else {
      nextActions = state.incident.actions.map((a) => a.id === action.id ? { ...a, approvals: nextApprovals, status: nextApprovals.length >= thresholdFor(action.kind) ? 'approved' : a.status } : a);
      text = `远端班次审批处置动作：${action.title}`;
    }
    set({ incident: { ...state.incident, version: state.incident.version + 1, actions: nextActions, timeline: [newTimeline('远端班次', text), ...state.incident.timeline].slice(0, 50) } });
  }
}), {
  name: 'yf56-incident-store',
  version: 1,
  partialize: (s) => ({ incident: s.incident, role: s.role, demoMode: s.demoMode, outbox: s.outbox, conflicts: s.conflicts, archive: s.archive }),
  migrate: (persistedState) => {
    const p = (persistedState ?? {}) as Record<string, unknown>;
    const incident = (p.incident ?? {}) as Partial<Incident>;
    // 旧数据无版本号，升级后补成初始版本
    if (typeof incident.version !== 'number') incident.version = 1;
    return {
      ...p,
      incident: incident as Incident,
      outbox: Array.isArray(p.outbox) ? p.outbox : [],
      conflicts: Array.isArray(p.conflicts) ? p.conflicts : [],
      archive: Array.isArray(p.archive) ? p.archive : [],
    } as State;
  }
}));
