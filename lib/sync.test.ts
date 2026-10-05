// 合并引擎规则验证（不依赖 React/DOM），通过 TypeScript transpileModule 直接运行
import assert from 'node:assert';
import {
  applyOperation,
  contextOf,
  mergeShift,
  resolveConflict,
  upgradeIncident,
  type Incident,
  type Operation,
  type ResponseAction,
  type ShiftSnapshot
} from './sync';

const now = '2026-10-04T08:00:00.000Z';
let counter = 0;
const oid = (type: string) => `${type}-t${++counter}`;

function makeIncident(): Incident {
  const ctx = { severity: 'high' as const, affected: ['gw-1', 'gw-2'] };
  const act = (a: Partial<ResponseAction> & Pick<ResponseAction, 'id' | 'title' | 'kind'>): ResponseAction => ({
    approvals: [],
    status: 'pending',
    rev: 1,
    approvalContext: ctx,
    rejectedVersions: [],
    ...a
  });
  return {
    id: 'INC-T1',
    version: 1,
    title: '测试事件',
    severity: 'high',
    status: 'investigating',
    affected: ['gw-1', 'gw-2'],
    subIncidents: [],
    timeline: [],
    actions: [
      act({ id: 'iso', title: '隔离节点', kind: 'isolate' }),
      act({ id: 'blk', title: '封禁地址', kind: 'block' }),
      act({ id: 'ready', title: '已备批准', kind: 'isolate', approvals: [{ role: 'analyst', at: now }, { role: 'legal', at: now }], status: 'approved' })
    ]
  };
}

type OpInput = Record<string, unknown> & { type: Operation['type']; base?: number };
function op(partial: OpInput): Operation {
  return { id: oid(partial.type), shiftId: 'SHIFT-X', at: now, base: 1, ...partial } as Operation;
}
const apply = (incident: Incident, operation: Operation): Incident => {
  const result = applyOperation(incident, operation);
  if (!result.ok) throw new assert.AssertionError({ message: `applyOperation 失败: ${result.reason}` });
  return result.incident;
};
const expectFail = (incident: Incident, operation: Operation, pattern: RegExp) => {
  const result = applyOperation(incident, operation);
  assert.ok(!result.ok && pattern.test(result.reason), `预期失败匹配 ${pattern}，实际 ${result.ok ? '成功' : result.reason}`);
};

function snapshotFrom(base: Incident, ops: Operation[]): ShiftSnapshot {
  let result = structuredClone(base);
  for (const operation of ops) result = apply(result, operation);
  return { format: 'yf56-shift-v1', incidentId: base.id, shiftId: 'SHIFT-REMOTE-1', takenAt: now, base, result, ops };
}

// 1. 隔离动作需要两个不同角色
{
  const ctx = () => contextOf(makeIncident());
  const i1 = apply(makeIncident(), op({ type: 'approve', actionId: 'iso', role: 'analyst', context: ctx() }));
  assert.equal(i1.actions[0].status, 'pending', '单角色不能批准隔离');
  // 同角色重复审批不写入
  const i1dup = apply(i1, op({ type: 'approve', actionId: 'iso', role: 'analyst', context: ctx() }));
  assert.equal(i1dup.actions[0].approvals.length, 1, '同角色重复审批幂等');
  const i2 = apply(i1dup, op({ type: 'approve', actionId: 'iso', role: 'legal', context: ctx() }));
  assert.equal(i2.actions[0].status, 'approved', '两角色后批准');
  // 访客不能写
  expectFail(i2, op({ type: 'approve', actionId: 'blk', role: 'viewer', context: ctx() }), /访客/);
  // 批准不足不能执行
  expectFail(i1, op({ type: 'execute', actionId: 'iso', role: 'responder', context: ctx() }), /不同角色确认/);
  console.log('✓ 1. 隔离双角色确认 / 重复审批幂等 / 访客禁写');
}

// 2. 级别或资产变化后旧批准失效，回到待复核
{
  const approved = apply(makeIncident(), op({ type: 'approve', actionId: 'blk', role: 'analyst', context: contextOf(makeIncident()) }));
  assert.equal(approved.actions[1].status, 'approved');
  const changed = apply(approved, op({ type: 'severity', value: 'critical' }));
  assert.equal(changed.actions[1].status, 'pending', '级别变化后回到待复核');
  assert.equal(changed.actions[1].approvals.length, 0, '旧批准清空');
  assert.ok(changed.timeline.some((e) => /旧批准失效/.test(e.text)), '时间线记录失效');
  // 已执行动作不受影响
  const executed = apply(makeIncident(), op({ type: 'execute', actionId: 'ready', role: 'responder', context: contextOf(makeIncident()) }));
  const thenChanged = apply(executed, op({ type: 'severity', value: 'critical' }));
  assert.equal(thenChanged.actions[2].status, 'executed', '已执行动作不回退');
  console.log('✓ 2. 级别/资产变化使旧批准失效并回待复核，已执行不受影响');
}

// 3. 同一动作两个班次都改 → 冲突保留，负责人裁决且留档未采用版本
{
  const localApproved = apply(makeIncident(), op({ type: 'approve', actionId: 'iso', role: 'analyst', context: contextOf(makeIncident()) }));
  const base = makeIncident();
  const snap = snapshotFrom(base, [
    op({ type: 'approve', actionId: 'iso', role: 'responder', context: contextOf(base) }),
    op({ type: 'approve', actionId: 'iso', role: 'legal', context: contextOf(base) }),
    op({ type: 'execute', actionId: 'iso', role: 'responder', context: contextOf(base) })
  ]);
  const { incident: merged, summary } = mergeShift(localApproved, snap, new Set());
  assert.equal(summary.status, 'conflict');
  assert.ok(merged.actions[0].conflict, '动作冻结为冲突');
  assert.equal(merged.actions[0].status, 'pending', '冲突动作不应用任一方状态');
  const { incident: resolved } = resolveConflict(merged, 'iso', 'remote', 'responder', 'SHIFT-LOCAL');
  const finalAction = resolved.actions[0];
  assert.equal(finalAction.status, 'executed', '采用对端执行结果');
  assert.equal(finalAction.conflict, undefined);
  assert.equal(finalAction.rejectedVersions.length, 1, '留档一个未采用版本');
  assert.equal(finalAction.rejectedVersions[0].side, 'local');
  assert.equal(finalAction.rejectedVersions[0].rejectedBy, 'responder');
  assert.ok(resolved.timeline.some((e) => /冲突裁决/.test(e.text)));
  console.log('✓ 3. 双方同改产生冲突、负责人裁决、未采用版本留档');
}

// 4. 只有响应负责人能裁决
{
  const localApproved = apply(makeIncident(), op({ type: 'approve', actionId: 'blk', role: 'analyst', context: contextOf(makeIncident()) }));
  const base = makeIncident();
  const snap = snapshotFrom(base, [op({ type: 'approve', actionId: 'blk', role: 'legal', context: contextOf(base) })]);
  const { incident: merged } = mergeShift(localApproved, snap, new Set());
  assert.ok(merged.actions[1].conflict);
  assert.throws(() => resolveConflict(merged, 'blk', 'local', 'analyst', 'SHIFT-L'), /响应负责人|没有待裁决/);
  console.log('✓ 4. 非负责人不能裁决');
}

// 5. 无冲突的离线审批与新增子事件正常合并，事件版本递增
{
  const base = makeIncident();
  const snap = snapshotFrom(base, [
    op({ type: 'approve', actionId: 'blk', role: 'legal', context: contextOf(base) }),
    op({ type: 'addSub', sub: { id: 'sub-x', title: '对端子事件', owner: '网络组', status: 'open' } })
  ]);
  const { incident, summary } = mergeShift(makeIncident(), snap, new Set());
  assert.equal(summary.status, 'merged');
  assert.ok(incident.actions[1].approvals.some((a) => a.role === 'legal'));
  assert.ok(incident.subIncidents.some((s) => s.id === 'sub-x'));
  assert.ok(incident.version > makeIncident().version, '版本递增');
  console.log('✓ 5. 无冲突离线操作合并、子事件汇入、版本递增');
}

// 6. 合并失败（快照损坏/事件不符）抛错且不写入
{
  assert.throws(() => mergeShift(makeIncident(), { format: 'bad' } as unknown as ShiftSnapshot, new Set()), /格式/);
  const other = makeIncident();
  other.id = 'INC-OTHER';
  assert.throws(() => mergeShift(makeIncident(), snapshotFrom(other, []), new Set()), /其他事件/);
  console.log('✓ 6. 损坏快照 / 跨事件快照整体失败');
}

// 7. 重试不重复写入审批（幂等键 + 角色去重双保险）
{
  const base = makeIncident();
  const approveOp = op({ type: 'approve', actionId: 'blk', role: 'legal', context: contextOf(base) });
  const snap = snapshotFrom(base, [approveOp]);
  const first = mergeShift(makeIncident(), snap, new Set());
  assert.equal(first.incident.actions[1].approvals.length, 1);
  // 同一快照重试，op.id 已在幂等表
  const second = mergeShift(first.incident, snap, new Set(first.summary.applied));
  assert.equal(second.summary.duplicates.length, 1, '重试识别为重复');
  assert.equal(second.incident.actions[1].approvals.length, 1, '不重复写审批');
  // 幂等表丢失时角色去重兜底
  const third = mergeShift(first.incident, snap, new Set());
  assert.equal(third.incident.actions[1].approvals.length, 1, '角色去重兜底');
  console.log('✓ 7. 重试幂等：不重复写入审批');
}

// 8. 条件不满足的操作进 failed，其他操作照常，快照可保留重试
{
  const base = makeIncident();
  const approveOp = op({ type: 'approve', actionId: 'iso', role: 'analyst', context: contextOf(base) });
  const badExec = op({ type: 'execute', actionId: 'iso', role: 'responder', context: contextOf(base) });
  const snap = snapshotFrom(base, [approveOp]);
  snap.ops.push(badExec); // 手工加入一条对端也无法满足的执行操作
  const { summary } = mergeShift(makeIncident(), snap, new Set());
  assert.ok(summary.failed.some((f) => f.opId === badExec.id), '失败操作被记录');
  assert.ok(summary.applied.length >= 1, '其他操作仍然生效');
  console.log('✓ 8. 部分失败不阻塞其他操作，失败原因保留');
}

// 9. 旧数据无版本号 → 升级为初始版本，字符串审批补结构
{
  const legacy = {
    id: 'INC-OLD',
    title: '老事件',
    severity: 'medium',
    status: 'investigating',
    affected: ['a'],
    subIncidents: [],
    timeline: [],
    actions: [{ id: 'x', title: '老动作', kind: 'block', approvals: ['analyst'], status: 'pending' }]
  };
  const upgraded = upgradeIncident(legacy);
  assert.equal(upgraded.version, 1, '补初始版本 v1');
  assert.equal(upgraded.actions[0].rev, 1);
  assert.deepEqual(upgraded.actions[0].approvals[0], { role: 'analyst', at: 'legacy' });
  assert.ok(upgraded.actions[0].approvalContext, '补批准上下文');
  console.log('✓ 9. 旧数据无版本号升级为初始版本');
}

// 10. 对端改级别后合并，其带旧上下文审批不会复活
{
  const base = makeIncident();
  const snap = snapshotFrom(base, [
    op({ type: 'approve', actionId: 'blk', role: 'analyst', context: contextOf(base) }),
    op({ type: 'severity', value: 'critical' })
  ]);
  const { incident } = mergeShift(makeIncident(), snap, new Set());
  assert.equal(incident.severity, 'critical');
  assert.equal(incident.actions[1].status, 'pending');
  console.log('✓ 10. 跨上下文审批不会复活，按当前上下文待复核');
}

console.log('\n全部合并引擎规则验证通过 ✅');
