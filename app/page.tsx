'use client';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { AlertTriangle, CloudOff, Eye, GitMerge, Radio, RefreshCw, ShieldAlert, UserCheck, Users, Wifi, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  ROLE_LABELS,
  distinctApprovers,
  isStale,
  opSummary,
  requiredApprovers,
  useIncidentStore,
  type Incident,
  type ResponseAction
} from '@/lib/store';

const formSchema = z.object({ title: z.string().min(4, '请填写至少4个字的子事件'), owner: z.string().min(2, '请填写负责组') });
const roleNames: Record<string, string> = { analyst: '分析员', responder: '响应负责人', legal: '法务/公关', viewer: '访客' };
const severityNames: Record<string, string> = { medium: '中', high: '高', critical: '紧急' };
const actionNames: Record<string, string> = { isolate: '隔离', block: '封禁', restore: '恢复', notify: '通报' };

function VersionBadge({ action, incident }: { action: ResponseAction; incident: Incident }) {
  const stale = isStale(action, incident);
  return (
    <div className="muted">
      {actionNames[action.kind]} · 修订 r{action.rev} · 审批 {distinctApprovers(action)}/{requiredApprovers(action)} 角色 ·{' '}
      {stale ? <Badge className="stale">旧批准失效·待复核</Badge> : <span>{action.status === 'pending' ? '待复核' : action.status === 'approved' ? '已批准' : '已执行'}</span>}
    </div>
  );
}

function SortableAction({ action }: { action: ResponseAction }) {
  const store = useIncidentStore();
  const sortable = useSortable({ id: action.id });
  const canSee = !action.sensitive || ['responder', 'legal'].includes(store.role);
  const stale = isStale(action, store.incident);
  const frozen = !!action.conflict;
  const approvedRoles = action.approvals.map((item) => ROLE_LABELS[item.role]);
  const canApprove = !store.demoMode && store.role !== 'viewer' && !action.approvals.some((item) => item.role === store.role) && action.status !== 'executed' && !frozen;
  const canExecute = !store.demoMode && store.role !== 'viewer' && action.status === 'approved' && !frozen;
  const isLeader = store.role === 'responder';

  return (
    <div ref={sortable.setNodeRef} style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }} className={`action-row${frozen ? ' frozen' : ''}`}>
      <div className="action-main">
        <strong>{canSee ? action.title : '敏感处置动作（当前角色不可见）'}</strong>
        <VersionBadge action={action} incident={store.incident} />
        <div className="approvers">
          审批人：{approvedRoles.length ? approvedRoles.map((name) => <Badge key={name} className="approver">{name}</Badge>) : <span className="muted">无</span>}
          {action.kind === 'isolate' && <span className="muted">（隔离需两个不同角色确认）</span>}
          {stale && <AlertTriangle size={13} className="stale-icon" />}
        </div>
        {action.rejectedVersions.length > 0 && (
          <details className="rejected">
            <summary>未采用版本留档（{action.rejectedVersions.length}）</summary>
            {action.rejectedVersions.map((version, index) => (
              <div key={index} className="muted rejected-line">
                {version.side === 'remote' ? '对端' : '本班'}版本 r{version.rev} · {version.status} ·{' '}
                {version.approvals.map((item) => ROLE_LABELS[item.role]).join('、') || '无审批'} · 负责人 {ROLE_LABELS[version.rejectedBy]} 未采用
              </div>
            ))}
          </details>
        )}
        {frozen && canSee && (
          <div className="conflict-box">
            <div className="conflict-title"><AlertTriangle size={15} /> 两个班次同时修改了该动作，等待响应负责人裁决</div>
            <div className="conflict-grid">
              <div>
                <Badge>本班次</Badge>
                <p className="muted">r{action.rev} · {action.status === 'pending' ? '待复核' : action.status === 'approved' ? '已批准' : '已执行'} · {approvedRoles.join('、') || '无审批'}</p>
              </div>
              <div>
                <Badge>对端班次 {action.conflict!.shiftId.slice(-4)}</Badge>
                <p className="muted">r{action.conflict!.remote.rev} · {action.conflict!.remote.status === 'pending' ? '待复核' : action.conflict!.remote.status === 'approved' ? '已批准' : '已执行'} · {action.conflict!.remote.approvals.map((item) => ROLE_LABELS[item.role]).join('、') || '无审批'}</p>
              </div>
            </div>
            <div className="conflict-actions">
              <Button size="sm" variant="outline" disabled={!isLeader || store.demoMode} onClick={() => store.resolveActionConflict(action.id, 'local')}>采用本班版本</Button>
              <Button size="sm" variant="outline" disabled={!isLeader || store.demoMode} onClick={() => store.resolveActionConflict(action.id, 'remote')}>采用对端版本</Button>
              {!isLeader && <span className="muted">仅响应负责人可裁决</span>}
            </div>
          </div>
        )}
      </div>
      <div className="row-actions">
        <Button size="sm" variant="outline" disabled={!canApprove} title={canApprove ? '' : '已审批 / 访客与演示模式不可写 / 冲突待裁决'} onClick={() => store.approveAction(action.id)}><UserCheck size={14} />审批</Button>
        <Button size="sm" disabled={!canExecute} title={action.status !== 'approved' ? '批准条件未满足' : ''} onClick={() => store.executeAction(action.id)}>执行</Button>
        <Button size="sm" variant="ghost" disabled={store.demoMode} {...sortable.attributes} {...sortable.listeners}>排序</Button>
      </div>
    </div>
  );
}

export default function Page() {
  const t = useTranslations();
  const store = useIncidentStore();
  const incident = store.incident;
  const sensors = useSensors(useSensor(PointerSensor));
  const form = useForm<z.infer<typeof formSchema>>({ resolver: zodResolver(formSchema), defaultValues: { title: '', owner: '' } });
  const [assetInput, setAssetInput] = useState('');
  const { data: health = { connected: false, latency: 0 } } = useQuery({
    queryKey: ['live', store.online],
    queryFn: async () => (store.online ? { connected: true, latency: 42 } : { connected: false, latency: 0 }),
    refetchInterval: 10000
  });
  useEffect(() => {
    const timer = window.setInterval(() => store.tick(), 20000);
    return () => window.clearInterval(timer);
  }, [store]);
  function dragEnd(event: DragEndEvent) { if (event.over) store.reorderActions(String(event.active.id), String(event.over.id)); }
  const canSeeSensitive = ['responder', 'legal'].includes(store.role);
  const readonly = store.demoMode || store.role === 'viewer';
  const conflicts = incident.actions.filter((item) => item.conflict);

  return <main className="shell">
    <header className="topbar">
      <div>
        <span className="eyebrow"><Radio size={14} /> LIVE WAR ROOM · PORT 62021 · 事件版本 v{incident.version}</span>
        <h1>{t('title')}</h1>
        <p>{t('subtitle')} · 离线交班按事件版本合并，冲突由负责人裁决留档</p>
      </div>
      <div className="controls">
        <select value={store.role} onChange={(event) => store.setRole(event.target.value as typeof store.role)}>{Object.entries(roleNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        <Button variant={store.online ? 'outline' : 'danger'} onClick={() => store.setOnline(!store.online)}>
          {store.online ? <Wifi size={16} /> : <WifiOff size={16} />}{store.online ? '在线' : '离线值班'}
        </Button>
        <Button variant={store.demoMode ? 'danger' : 'outline'} onClick={store.toggleDemo}><Eye size={16} />{store.demoMode ? '退出演示' : t('demo')}</Button>
      </div>
    </header>
    {store.demoMode && <div className="demo-banner">只读演示模式已开启：审批、执行、级别/资产变更、合并与裁决均被冻结，仍可查看允许范围内的内容。</div>}
    {!store.online && !store.demoMode && <div className="offline-banner"><CloudOff size={16} /> 当前离线：审批与执行结果继续记录到本地待办（{store.pendingOps.length} 条），回网后按事件版本合并；重试不会重复写入审批。</div>}

    <section className="metrics">
      <Card><CardContent><span>当前事件 / 版本</span><strong className="metric-line">{incident.id}<small>v{incident.version}</small></strong><Badge className="critical">{severityNames[incident.severity]}</Badge></CardContent></Card>
      <Card><CardContent><span>实时通道</span><strong>{store.online ? `${health.latency}ms` : '离线'}</strong><small>{store.online ? '监测代理已连接' : '值班员离线记录中'}</small></CardContent></Card>
      <Card><CardContent><span>待同步 / 冲突</span><strong>{store.pendingOps.length} / {conflicts.length}</strong><small>离线待办 / 待裁决动作</small></CardContent></Card>
      <Card><CardContent><span>处置动作</span><strong>{incident.actions.filter((item) => item.status === 'executed').length}/{incident.actions.length}</strong><small>已执行/总数</small></CardContent></Card>
    </section>

    <section className="grid">
      <div className="stack">
        <Card>
          <CardHeader>
            <div><h2>事件摘要</h2><p className="muted">级别或影响资产变化后，旧批准失效，动作回到待复核。</p></div>
            <ShieldAlert color={incident.severity === 'critical' ? '#ef4444' : '#f59e0b'} />
          </CardHeader>
          <CardContent>
            <div className="incident-state">
              <span>事件级别（变化即作废旧批准）</span>
              <div className="severity-row">
                {(['medium', 'high', 'critical'] as const).map((value) => (
                  <Button key={value} size="sm" variant={incident.severity === value ? 'default' : 'outline'} disabled={readonly} onClick={() => store.setSeverity(value)}>{severityNames[value]}</Button>
                ))}
              </div>
            </div>
            <div className="affected-block">
              <h3>影响资产（{incident.affected.length}）</h3>
              <div className="affected-list">
                {incident.affected.map((asset) => (
                  <Badge key={asset} className="asset">{asset}{!readonly && <button onClick={() => store.removeAffected(asset)} title="移出影响资产">×</button>}</Badge>
                ))}
              </div>
              <form className="asset-form" onSubmit={(event) => { event.preventDefault(); const value = assetInput.trim(); if (value) { store.addAffected(value); setAssetInput(''); } }}>
                <Input value={assetInput} onChange={(event) => setAssetInput(event.target.value)} placeholder="新增影响资产，如 db-primary" disabled={readonly} />
                <Button size="sm" type="submit" disabled={readonly || !assetInput.trim()}>加入</Button>
              </form>
            </div>
            <h3>子事件</h3>
            {incident.subIncidents.map((item) => <div className="sub-row" key={item.id}><div><strong>{item.title}</strong><div className="muted">{item.owner} · r{item.status === 'closed' ? '已关闭' : item.status === 'contained' ? '已遏制' : '处理中'}</div></div><Badge>{item.status}</Badge></div>)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><div><h2>{t('approval')}</h2><p className="muted">隔离动作需两名不同角色确认；两个班次同改一个动作时保留双方版本，由响应负责人选定。</p></div><Users size={20} /></CardHeader>
          <CardContent>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
              <SortableContext items={incident.actions.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                <div>{incident.actions.map((action) => <SortableAction key={action.id} action={action} />)}</div>
              </SortableContext>
            </DndContext>
          </CardContent>
        </Card>
      </div>
      <div className="stack">
        <Card className="handoff-card">
          <CardHeader><div><h2>离线交班 / 回网合并</h2><p className="muted">本班次 {store.shiftId.slice(-6)}</p></div><GitMerge size={20} /></CardHeader>
          <CardContent>
            <div className="handoff-section">
              <h3>本地待同步（{store.pendingOps.length}）</h3>
              {store.pendingOps.length === 0 && <p className="muted">无待办。断网期间的审批、执行、子事件和级别/资产变更会在此排队。</p>}
              <ol className="pending-list">
                {store.pendingOps.map((op) => <li key={op.id}><Badge className="optype">{op.type}</Badge>{opSummary(op)}<span className="muted">基于 v{op.base}</span></li>)}
              </ol>
            </div>
            <div className="handoff-section">
              <h3>对端交班快照</h3>
              {store.snapshot ? (
                <p className="muted">已收到班次 {store.snapshot.format === 'yf56-shift-v1' ? store.snapshot.shiftId.slice(-6) : '（损坏）'} 的 {store.snapshot.format === 'yf56-shift-v1' ? `${store.snapshot.ops.length} 条操作` : '无法解析数据'}，{store.online ? '可立即合并' : '回网后自动合并'}。</p>
              ) : (
                <p className="muted">暂无对端快照。可用下方按钮模拟对端班次在离线期间写入。</p>
              )}
              <div className="sim-row">
                <Button size="sm" variant="outline" disabled={readonly} onClick={() => store.simulateRemote('approve')}>模拟对端审批+执行</Button>
                <Button size="sm" variant="outline" disabled={readonly} onClick={() => store.simulateRemote('severity')}>模拟对端改级别</Button>
                <Button size="sm" variant="ghost" disabled={readonly} onClick={store.corruptIncomingSnapshot}>模拟损坏快照</Button>
              </div>
              <Button className="merge-btn" disabled={readonly || !store.snapshot || store.sync.status === 'syncing'} onClick={store.mergeRemote}>
                <GitMerge size={15} />{store.sync.status === 'syncing' ? '合并中…' : store.sync.status === 'failed' ? '重试合并（待办保留）' : '回网合并'}
              </Button>
            </div>
            {store.sync.status !== 'idle' && store.sync.status !== 'syncing' && (
              <div className={`sync-result ${store.sync.status}`}>
                <h3>
                  {store.sync.status === 'success' && '✅ 合并完成'}
                  {store.sync.status === 'conflict' && '⚠️ 合并完成但存在冲突'}
                  {store.sync.status === 'failed' && '❌ 合并失败'}
                </h3>
                {store.sync.error && <p className="error-line">原因：{store.sync.error}。待办与快照原样保留，可重试；已写入操作按幂等键跳过，不会重复审批。</p>}
                {store.sync.summary && (
                  <ul className="summary-list">
                    {store.sync.summary.notes.map((note) => <li key={note}>{note}</li>)}
                    {store.sync.summary.conflicts.map((item) => <li key={item.actionId}>冲突待裁决：{item.title}</li>)}
                    {store.sync.summary.failed.map((item) => <li key={item.opId}>未满足条件：{item.reason}</li>)}
                  </ul>
                )}
                {store.sync.status === 'failed' && <Button size="sm" onClick={store.mergeRemote}><RefreshCw size={13} />重试合并</Button>}
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><h2>新增子事件</h2></CardHeader>
          <CardContent>
            <form onSubmit={form.handleSubmit((values) => { store.addSubIncident(values); form.reset(); })}>
              <label>子事件名称<Input {...form.register('title')} placeholder="例如：凭据轮换" /></label>
              <small className="error">{form.formState.errors.title?.message}</small>
              <label>负责组<Input {...form.register('owner')} placeholder="例如：平台组" /></label>
              <small className="error">{form.formState.errors.owner?.message}</small>
              <Button type="submit" disabled={readonly}><ShieldAlert size={16} />创建子事件</Button>
            </form>
          </CardContent>
        </Card>
        <Card className="timeline-card">
          <CardHeader><div><h2>{t('timeline')}</h2><p className="muted">每 20 秒接收一次监测事件；离线期间记录不丢失</p></div><Radio color="#ef4444" /></CardHeader>
          <CardContent>
            <div className="timeline">
              {incident.timeline.map((event) => <article key={event.id}><i /><div><div className="timeline-meta"><strong>{event.actor}</strong><span>{event.at === 'legacy' ? '升级补录' : formatDistanceToNow(new Date(event.at), { addSuffix: true, locale: zhCN })}</span></div><p>{event.sensitive && !canSeeSensitive ? '敏感处置记录已隐藏' : event.text}</p></div></article>)}
            </div>
          </CardContent>
        </Card>
      </div>
    </section>
  </main>;
}
