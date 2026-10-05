// store 集成验证：断网记录、回网合并、冲突裁决、合并失败保留待办与重试幂等
import assert from 'node:assert';

// ---- 浏览器环境桩：在加载 store 之前就位 ----
const storage = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key)
  }
};
(globalThis as { localStorage?: unknown }).localStorage = (globalThis as unknown as { window: { localStorage: unknown } }).window.localStorage;
(globalThis as { structuredClone?: unknown }).structuredClone ??= (value: unknown) => JSON.parse(JSON.stringify(value));

async function main() {
  const { useIncidentStore } = await import('./store');
  const store = useIncidentStore as unknown as { getState: typeof useIncidentStore.getState; setState: typeof useIncidentStore.setState };
  const s = () => store.getState();
  const find = (id: string) => s().incident.actions.find((a) => a.id === id)!;

  // 干净起点：在线、分析员、演示关闭，回到初始 v1 事件
  const initial = s().incident;
  store.setState({
    incident: JSON.parse(JSON.stringify({ ...initial, version: 1 })),
    demoMode: false,
    role: 'analyst',
    online: true,
    pendingOps: [],
    snapshot: null,
    appliedIds: [],
    sync: { status: 'idle' as const }
  });
  // 重置后初始动作回到全 pending
  store.setState({
    incident: {
      ...s().incident,
      actions: s().incident.actions.map((a) => ({ ...a, status: 'pending' as const, approvals: [], conflict: undefined, rejectedVersions: [], rev: 1 }))
    }
  });

  // 1. 断网：分析员审批隔离动作（第一角色）与 block 动作
  s().setOnline(false);
  assert.equal(s().online, false);
  s().approveAction('act-2'); // block：单角色即批准
  s().approveAction('act-1'); // isolate：第一角色
  assert.equal(s().pendingOps.length, 2, '离线审批进入待办队列');
  assert.equal(find('act-2').status, 'approved', '本地立即生效：block 已批准');
  assert.equal(find('act-1').status, 'pending', '隔离单角色仍待第二确认');

  // 2. 断网期间本地记录执行结果
  s().executeAction('act-2');
  assert.equal(s().pendingOps.length, 3);
  assert.equal(find('act-2').status, 'executed', '本地记录执行结果');

  // 3. 访客与演示模式不能写入
  s().setRole('viewer');
  const beforeLen = s().pendingOps.length;
  s().approveAction('act-1');
  s().executeAction('act-2');
  assert.equal(s().pendingOps.length, beforeLen, '访客写入被拒绝');
  s().setRole('analyst');
  s().toggleDemo();
  s().approveAction('act-1');
  assert.equal(s().pendingOps.length, beforeLen, '演示模式写入被拒绝');
  s().toggleDemo();

  // 4. 模拟对端班次也改了同一动作（对端两角色批准并执行 act-1）
  s().simulateRemote('approve');
  assert.ok(s().snapshot, '收到对端快照');
  assert.equal(s().snapshot!.incidentId, s().incident.id);

  // 5. 回网：setOnline(true) 且有快照时自动合并 → 冲突
  s().setOnline(true);
  assert.equal(s().sync.status, 'conflict', `合并状态应为冲突，实际 ${s().sync.status}`);
  assert.ok(find('act-1').conflict, 'act-1 双方同改 → 冲突保留');
  assert.equal(find('act-2').status, 'executed', '对端未动 act-2，本班执行结果保持');

  // 6. 非负责人不能裁决
  s().setRole('analyst');
  s().resolveActionConflict('act-1', 'remote');
  assert.ok(find('act-1').conflict, '分析员无法裁决');

  // 7. 负责人裁决采用对端版本（已执行），本班版本作为未采用版本留档
  s().setRole('responder');
  s().resolveActionConflict('act-1', 'remote');
  assert.equal(find('act-1').status, 'executed', '采用对端已执行版本');
  assert.equal(find('act-1').conflict, undefined);
  assert.equal(find('act-1').rejectedVersions.length, 1, '本班未采用版本留档');
  assert.equal(find('act-1').rejectedVersions[0].side, 'local');
  assert.equal(find('act-1').rejectedVersions[0].rejectedBy, 'responder');

  // 8. 合并失败（损坏快照）：待办保留；重试不重复写入审批
  store.setState({ role: 'analyst' });
  s().setOnline(false);
  s().approveAction('act-3'); // notify 离线审批
  const pendingCount = s().pendingOps.length;
  assert.ok(pendingCount >= 1);
  s().corruptIncomingSnapshot();
  const approvalsBefore = find('act-3').approvals.length;
  s().setOnline(true);
  assert.equal(s().sync.status, 'failed', '损坏快照合并失败');
  assert.equal(s().pendingOps.length, pendingCount, '本地待办原样保留');
  assert.ok(s().snapshot, '损坏快照保留可重试');
  assert.equal(find('act-3').approvals.length, approvalsBefore, '失败不产生任何审批写入');
  // 换成合法快照重试（对端审批 act-3 的另一个角色）
  s().simulateRemote('approve');
  s().mergeRemote();
  assert.notEqual(s().sync.status, 'failed', '重试后合并成功');
  const roles = find('act-3').approvals.map((a) => a.role);
  assert.equal(new Set(roles).size, roles.length, '重试无重复角色审批');

  // 9. 事件级别变化：未执行动作旧批准失效回待复核，已执行不回退
  const approvedAction = s().incident.actions.find((a) => a.status === 'approved');
  if (approvedAction) {
    s().setSeverity(s().incident.severity === 'critical' ? 'high' : 'critical');
    const after = find(approvedAction.id);
    assert.equal(after.status, 'pending', '级别变化后回待复核');
    assert.equal(after.approvals.length, 0, '旧批准清空');
  }
  assert.equal(find('act-1').status, 'executed', '已执行动作不受级别变化影响');
  assert.equal(find('act-2').status, 'executed');

  // 10. 持久化结构完好
  const persisted = JSON.parse(storage.get('yf56-incident-store')!);
  assert.equal(typeof persisted.state.incident.version, 'number');
  assert.ok(Array.isArray(persisted.state.appliedIds));

  console.log('✓ 断网记录 → 回网冲突 → 负责人裁决留档 → 失败保留重试 → 级别失效 → 持久化');
  console.log('全部 store 集成验证通过 ✅');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
