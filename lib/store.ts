import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import {
  applyOperation,
  contextOf,
  genId,
  mergeShift,
  resolveConflict,
  upgradeIncident,
  type Incident,
  type IncidentContext,
  type MergeSummary,
  type Operation,
  type Role,
  type ResponseAction,
  type Severity,
  type ShiftSnapshot,
  type TimelineEvent
} from './sync';

export * from './sync';

export interface SyncState {
  status: 'idle' | 'syncing' | 'success' | 'conflict' | 'failed';
  summary?: MergeSummary;
  error?: string;
  lastAt?: string;
}
interface State {
  incident: Incident;
  role: Role;
  demoMode: boolean;
  online: boolean;
  shiftId: string;
  pendingOps: Operation[];
  snapshot: ShiftSnapshot | null;
  appliedIds: string[];
  sync: SyncState;
  setRole: (role: Role) => void;
  toggleDemo: () => void;
  setOnline: (online: boolean) => void;
  addSubIncident: (payload: { title: string; owner: string }) => void;
  approveAction: (id: string) => void;
  executeAction: (id: string) => void;
  setSeverity: (severity: Severity) => void;
  addAffected: (asset: string) => void;
  removeAffected: (asset: string) => void;
  reorderActions: (activeId: string, overId: string) => void;
  simulateRemote: (kind: 'approve' | 'severity') => void;
  corruptIncomingSnapshot: () => void;
  mergeRemote: () => void;
  resolveActionConflict: (actionId: string, choice: 'local' | 'remote') => void;
  tick: () => void;
}

function legacyIncident(): Incident {
  // 初始事件按升级后的版本模型给出初始版本 v1
  const at = new Date().toISOString();
  const ctx: IncidentContext = { severity: 'critical', affected: ['api-gateway', 'customer-portal', 'audit-log'] };
  const act = (a: Omit<ResponseAction, 'rev' | 'rejectedVersions' | 'approvalContext'>): ResponseAction => ({
    ...a,
    rev: 1,
    approvalContext: ctx,
    rejectedVersions: []
  });
  return {
    id: 'INC-2026-0929',
    version: 1,
    title: '对外网关异常凭证使用',
    severity: 'critical',
    status: 'investigating',
    affected: [...ctx.affected],
    subIncidents: [
      { id: 'sub-1', title: '异常会话来源分析', owner: '分析组', status: 'open' },
      { id: 'sub-2', title: '受影响租户范围确认', owner: '平台组', status: 'open' }
    ],
    actions: [
      act({ id: 'act-1', title: '隔离异常网关节点', kind: 'isolate', approvals: [{ role: 'analyst', at }], status: 'pending', sensitive: true }),
      act({ id: 'act-2', title: '封禁可疑出口地址', kind: 'block', approvals: [], status: 'pending' }),
      act({ id: 'act-3', title: '准备客户披露口径', kind: 'notify', approvals: [{ role: 'legal', at }], status: 'pending', sensitive: true })
    ],
    timeline: [
      { id: 'e-init-1', at: new Date(Date.now() - 1500000).toISOString(), actor: '告警平台', text: '检测到同一凭证跨三个地域登录', sensitive: true },
      { id: 'e-init-2', at: new Date(Date.now() - 900000).toISOString(), actor: '值班分析员', text: '确认会话未经过常规办公出口' }
    ]
  };
}

const LOCAL_SHIFT_PREFIX = 'SHIFT-LOCAL';

export const useIncidentStore = create<State>()(
  persist(
    (set, get) => {
      // 本地写入：演示模式与访客一律拒绝；成功后若离线则进入待同步队列
      function commit(build: (opId: string, at: string, base: number, context: IncidentContext) => Operation) {
        const state = get();
        if (state.demoMode || state.role === 'viewer') return;
        const at = new Date().toISOString();
        const op = build(genId('op'), at, state.incident.version, contextOf(state.incident));
        const result = applyOperation(state.incident, op);
        if (!result.ok) {
          set({ sync: { ...state.sync, error: result.reason, status: 'failed' } });
          return;
        }
        set({
          incident: { ...result.incident, version: state.incident.version + 1 },
          pendingOps: state.online ? state.pendingOps : [...state.pendingOps, op]
        });
      }

      return {
        incident: legacyIncident(),
        role: 'analyst',
        demoMode: false,
        online: true,
        shiftId: `${LOCAL_SHIFT_PREFIX}-${Math.random().toString(36).slice(2, 8)}`,
        pendingOps: [],
        snapshot: null,
        appliedIds: [],
        sync: { status: 'idle' },

        setRole: (role) => set({ role }),
        toggleDemo: () => set((state) => ({ demoMode: !state.demoMode })),
        setOnline: (online) => {
          set({ online });
          if (online && get().snapshot) get().mergeRemote();
        },

        addSubIncident: (payload) =>
          commit((id, at, base) => ({
            id,
            shiftId: get().shiftId,
            at,
            base,
            type: 'addSub',
            sub: { id: genId('sub'), title: payload.title, owner: payload.owner, status: 'open' }
          })),

        approveAction: (actionId) =>
          commit((id, at, base, context) => ({
            id,
            shiftId: get().shiftId,
            at,
            base,
            type: 'approve',
            actionId,
            role: get().role,
            context
          })),

        executeAction: (actionId) =>
          commit((id, at, base, context) => ({
            id,
            shiftId: get().shiftId,
            at,
            base,
            type: 'execute',
            actionId,
            role: get().role,
            context
          })),

        setSeverity: (severity) =>
          commit((id, at, base) => ({ id, shiftId: get().shiftId, at, base, type: 'severity', value: severity })),

        addAffected: (asset) =>
          commit((id, at, base) => ({ id, shiftId: get().shiftId, at, base, type: 'affected', added: [asset], removed: [] })),

        removeAffected: (asset) =>
          commit((id, at, base) => ({ id, shiftId: get().shiftId, at, base, type: 'affected', added: [], removed: [asset] })),

        // 模拟对端班次在离线期间产生的交班快照（基线 = 双方最后一致的状态）
        simulateRemote: (kind) => {
          const state = get();
          if (state.demoMode || state.role === 'viewer') return;
          const base = structuredClone(state.incident);
          const shiftId = `SHIFT-REMOTE-${Math.random().toString(36).slice(2, 6)}`;
          const at = new Date().toISOString();
          const ops: Operation[] = [];
          let remote = base;
          if (kind === 'approve') {
            const target = base.actions.find((item) => item.status !== 'executed');
            if (!target) return;
            const remoteRole: Role = target.kind === 'notify' ? 'analyst' : 'responder';
            const op: Operation = {
              id: genId('op'),
              shiftId,
              at,
              base: base.version,
              type: 'approve',
              actionId: target.id,
              role: remoteRole,
              context: contextOf(base)
            };
            ops.push(op);
            const approved = applyOperation(remote, op);
            if (!approved.ok) return;
            remote = approved.incident;
            // 对端满足批准条件时继续执行，制造两边都改同一动作的冲突
            const acted = remote.actions.find((item) => item.id === target.id)!;
            if (acted.status === 'approved') {
              const exec: Operation = {
                id: genId('op'),
                shiftId,
                at,
                base: base.version,
                type: 'execute',
                actionId: target.id,
                role: remoteRole,
                context: contextOf(base)
              };
              const executed = applyOperation(remote, exec);
              if (executed.ok) {
                ops.push(exec);
                remote = executed.incident;
              }
            }
          } else {
            const next: Severity = base.severity === 'critical' ? 'high' : 'critical';
            const op: Operation = { id: genId('op'), shiftId, at, base: base.version, type: 'severity', value: next };
            const result = applyOperation(remote, op);
            if (!result.ok) return;
            ops.push(op);
            remote = result.incident;
          }
          const snapshot: ShiftSnapshot = { format: 'yf56-shift-v1', incidentId: base.id, shiftId, takenAt: at, base, result: remote, ops };
          set({ snapshot, sync: { status: 'idle', error: undefined } });
        },

        corruptIncomingSnapshot: () => {
          const state = get();
          if (state.demoMode || state.role === 'viewer') return;
          set({ snapshot: { format: 'yf56-corrupt' } as unknown as ShiftSnapshot, sync: { status: 'idle', error: undefined } });
        },

        // 回网合并。整体失败（快照损坏/事件不符）时不写入任何内容，待办与快照原样保留可重试
        mergeRemote: () => {
          const state = get();
          if (!state.snapshot || state.sync.status === 'syncing') return;
          set({ sync: { status: 'syncing' } });
          try {
            const { incident, summary } = mergeShift(state.incident, state.snapshot, new Set(state.appliedIds));
            // 只有真正生效或确认重复的操作才进入幂等表；条件不满足的操作不进入，随快照保留待重试
            const consumed = new Set<string>([...summary.applied, ...summary.duplicates]);
            const retained = summary.failed.length > 0;
            set({
              incident,
              // 有未生效操作时保留快照；重试时已生效操作按幂等键跳过，不会重复写入审批
              snapshot: retained ? state.snapshot : null,
              pendingOps: retained ? state.pendingOps : [],
              appliedIds: [...new Set([...state.appliedIds, ...consumed])],
              sync: {
                status: retained ? 'failed' : summary.conflicts.length ? 'conflict' : 'success',
                summary,
                error: retained ? `${summary.failed.length} 条操作未满足条件（如批准数不足），已保留待重试` : undefined,
                lastAt: new Date().toISOString()
              }
            });
          } catch (error) {
            set({
              sync: {
                status: 'failed',
                error: error instanceof Error ? error.message : '合并失败',
                summary: state.sync.summary,
                lastAt: new Date().toISOString()
              }
            });
          }
        },

        // 冲突只能由响应负责人裁决；未采用版本永久留档
        resolveActionConflict: (actionId, choice) => {
          const state = get();
          if (state.demoMode || state.role !== 'responder') return;
          const { incident, resolvedOpIds } = resolveConflict(state.incident, actionId, choice, 'responder', state.shiftId);
          const remaining = incident.actions.some((item) => item.conflict);
          set({
            incident,
            appliedIds: [...new Set([...state.appliedIds, ...resolvedOpIds])],
            sync: remaining
              ? state.sync
              : { status: 'success' as const, summary: state.sync.summary, lastAt: new Date().toISOString() }
          });
        },

        reorderActions: (activeId, overId) => {
          const state = get();
          if (state.demoMode) return;
          const actions = [...state.incident.actions];
          const from = actions.findIndex((item) => item.id === activeId);
          const to = actions.findIndex((item) => item.id === overId);
          if (from < 0 || to < 0) return;
          const [moved] = actions.splice(from, 1);
          actions.splice(to, 0, moved);
          set({ incident: { ...state.incident, actions } });
        },

        tick: () => {
          const state = get();
          if (state.demoMode) return;
          const event: TimelineEvent = {
            id: genId('e'),
            at: new Date().toISOString(),
            actor: '监测代理',
            text: `实时检查：${state.incident.affected.length} 项资产状态已更新（v${state.incident.version}）`
          };
          set({ incident: { ...state.incident, timeline: [event, ...state.incident.timeline].slice(0, 40) } });
        }
      };
    },
    {
      name: 'yf56-incident-store',
      version: 2,
      // SSR/无 localStorage 环境使用空存储，避免预渲染访问浏览器 API
      storage: createJSONStorage(() =>
        typeof window !== 'undefined'
          ? window.localStorage
          : { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }
      ),
      // 旧数据无版本号：升级后补成初始版本 v1，旧字符串审批补成结构化记录
      migrate: (persisted: unknown, version: number) => {
        const data = (persisted ?? {}) as Partial<State>;
        const migrated: Partial<State> = {
          ...data,
          pendingOps: [],
          snapshot: null,
          appliedIds: [],
          sync: { status: 'idle' as const },
          online: true,
          shiftId: data.shiftId ?? `${LOCAL_SHIFT_PREFIX}-${Math.random().toString(36).slice(2, 8)}`
        };
        if (data.incident) migrated.incident = upgradeIncident(data.incident);
        return migrated as State;
      }
    }
  )
);
