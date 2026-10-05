'use client';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { Archive, CheckCircle2, Cloud, CloudOff, Eye, GitMerge, Radio, RefreshCw, ShieldAlert, UserCheck, Users, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useIncidentStore, type OutboxOp, type ResponseAction, type Role } from '@/lib/store';

const formSchema = z.object({ title: z.string().min(4, '请填写至少4个字的子事件'), owner: z.string().min(2, '请填写负责组') });
const roleNames: Record<Role, string> = { analyst: '分析员', responder: '响应负责人', legal: '法务/公关', viewer: '访客' };
const severityNames = { medium: '中', high: '高', critical: '严重' } as const;

function SortableAction({ action }: { action: ResponseAction }) {
  const store = useIncidentStore();
  const sortable = useSortable({ id: action.id });
  const canSee = !action.sensitive || ['responder', 'legal'].includes(store.role);
  const threshold = action.kind === 'isolate' ? 2 : 1;
  const approved = action.approvals.length >= threshold;
  return (
    <div ref={sortable.setNodeRef} style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }} className="action-row">
      <div>
        <strong>{canSee ? action.title : '敏感处置动作（当前角色不可见）'}</strong>
        <div className="muted">{action.kind} · 审批人 {action.approvals.join('、') || '无'} · {action.status}{action.kind === 'isolate' && ` · 需 ${action.approvals.length}/2 名角色确认`}</div>
      </div>
      <div className="row-actions">
        <Button size="sm" variant="outline" disabled={store.demoMode || store.role === 'viewer' || action.approvals.includes(store.role) || action.status === 'executed'} onClick={() => store.approveAction(action.id)}><UserCheck size={14} />审批</Button>
        <Button size="sm" disabled={store.demoMode || store.role === 'viewer' || !approved || action.status === 'executed'} onClick={() => store.executeAction(action.id)}>执行</Button>
        <Button size="sm" variant="ghost" {...sortable.attributes} {...sortable.listeners}>排序</Button>
      </div>
    </div>
  );
}

function statusBadge(status: OutboxOp['status'], t: (key: string) => string) {
  const map = { pending: { label: t('pending'), cls: 'badge-pending' }, merged: { label: t('merged'), cls: 'badge-merged' }, conflict: { label: t('conflict'), cls: 'badge-conflict' }, failed: { label: t('failed'), cls: 'badge-failed' } } as const;
  const item = map[status];
  return <Badge className={item.cls}>{item.label}</Badge>;
}

export default function Page() {
  const t = useTranslations();
  const store = useIncidentStore();
  const incident = store.incident;
  const sensors = useSensors(useSensor(PointerSensor));
  const [newAsset, setNewAsset] = useState('');
  const form = useForm<z.infer<typeof formSchema>>({ resolver: zodResolver(formSchema), defaultValues: { title: '', owner: '' } });
  const { data: health = { connected: false, latency: 0 } } = useQuery({ queryKey: ['live', store.online], queryFn: async () => ({ connected: useIncidentStore.getState().online, latency: 42 }), refetchInterval: 5000 });

  // 监听浏览器在线/离线
  useEffect(() => {
    const goOnline = () => useIncidentStore.getState().setOnline(true);
    const goOffline = () => useIncidentStore.getState().setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => { window.removeEventListener('online', goOnline); window.removeEventListener('offline', goOffline); };
  }, []);
  // 回网后自动合并离线待办
  useEffect(() => { if (store.online) store.mergeOutbox(); }, [store.online]);
  useEffect(() => { const timer = window.setInterval(() => { if (!store.demoMode && store.online) store.tick(); }, 20000); return () => window.clearInterval(timer); }, [store.demoMode, store.online]);

  function dragEnd(event: DragEndEvent) { if (event.over) store.reorderActions(String(event.active.id), String(event.over.id)); }
  const canSeeSensitive = ['responder', 'legal'].includes(store.role);
  const canResolve = store.role === 'responder' && !store.demoMode;
  const pendingCount = store.outbox.filter((o) => o.status === 'pending' || o.status === 'failed').length;
  const openConflicts = store.conflicts.filter((c) => c.status === 'open');

  function addAsset() {
    const value = newAsset.trim();
    if (!value) return;
    if (!incident.affected.includes(value)) store.changeAffected([...incident.affected, value]);
    setNewAsset('');
  }
  function removeAsset(asset: string) { store.changeAffected(incident.affected.filter((a) => a !== asset)); }

  return <main className="shell">
    <header className="topbar">
      <div>
        <span className="eyebrow"><Radio size={14} /> LIVE WAR ROOM · PORT 62021</span>
        <h1>{t('title')}</h1>
        <p>{t('subtitle')}</p>
      </div>
      <div className="controls">
        <Badge className={store.online ? 'badge-online' : 'badge-offline'}>{store.online ? <Cloud size={13} /> : <CloudOff size={13} />}{store.online ? t('online') : t('offline')}</Badge>
        <Button variant="outline" size="sm" onClick={() => store.setOnline(!store.online)}>{store.online ? <CloudOff size={14} /> : <Cloud size={14} />}{store.online ? '切换离线' : '切换在线'}</Button>
        <select value={store.role} onChange={(event) => store.setRole(event.target.value as Role)}>{Object.entries(roleNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        <Button variant={store.demoMode ? 'danger' : 'outline'} onClick={store.toggleDemo}><Eye size={16} />{store.demoMode ? '退出演示' : t('demo')}</Button>
      </div>
    </header>
    {store.demoMode && <div className="demo-banner">只读演示模式已开启：审批、执行、拖拽和新增操作均被冻结，仍可查看允许范围内的内容。</div>}
    {!store.online && <div className="offline-banner"><CloudOff size={16} />{t('offlineBanner')}</div>}
    <section className="metrics">
      <Card><CardContent><span>当前事件</span><strong>{incident.id}</strong><Badge className="critical">{incident.severity}</Badge></CardContent></Card>
      <Card><CardContent><span>实时通道</span><strong>{health.connected ? `${health.latency}ms` : t('offline')}</strong><small>{health.connected ? '监测代理已连接' : '断网记账中'}</small></CardContent></Card>
      <Card><CardContent><span>{t('version')}</span><strong>v{incident.version}</strong><small>事件版本号</small></CardContent></Card>
      <Card><CardContent><span>{t('pendingCount')}</span><strong>{pendingCount}</strong><small>待合并 · {openConflicts.length} 冲突</small></CardContent></Card>
    </section>
    <section className="grid">
      <div className="stack">
        <Card>
          <CardHeader><div><h2>事件摘要</h2><p className="muted">影响范围：{incident.affected.join(' · ')}</p></div><ShieldAlert color={incident.severity === 'critical' ? '#ef4444' : '#f59e0b'} /></CardHeader>
          <CardContent>
            <div className="incident-state"><span>处置阶段</span><strong>{incident.status}</strong></div>
            <div className="severity-row">
              <span className="muted">{t('severity')}</span>
              <select value={incident.severity} disabled={store.demoMode || store.role === 'viewer'} onChange={(e) => store.changeSeverity(e.target.value as typeof incident.severity)}>{Object.entries(severityNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
            </div>
            <div className="affected-row">
              <span className="muted">{t('affectedAssets')}</span>
              <div className="asset-tags">{incident.affected.map((asset) => <Badge key={asset} className="asset-tag">{asset}{!store.demoMode && store.role !== 'viewer' && <button className="asset-remove" onClick={() => removeAsset(asset)}>×</button>}</Badge>)}</div>
              {!store.demoMode && store.role !== 'viewer' && <div className="asset-add"><Input value={newAsset} onChange={(e) => setNewAsset(e.target.value)} placeholder={t('assetPlaceholder')} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addAsset(); } }} /><Button size="sm" variant="outline" onClick={addAsset}>{t('addAsset')}</Button></div>}
            </div>
            <p className="muted invalidate-note">{t('invalidateNote')}</p>
            <h3>子事件</h3>
            {incident.subIncidents.map((item) => <div className="sub-row" key={item.id}><div><strong>{item.title}</strong><div className="muted">{item.owner}</div></div><Badge>{item.status}</Badge></div>)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><div><h2>{t('approval')}</h2><p className="muted">{t('isolationNeedsTwo')}，敏感动作仅响应和法务角色可见。</p></div><Users size={20} /></CardHeader>
          <CardContent>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}><SortableContext items={incident.actions.map((item) => item.id)} strategy={verticalListSortingStrategy}><div>{incident.actions.map((action) => <SortableAction key={action.id} action={action} />)}</div></SortableContext></DndContext>
            <div className="outbox-actions">
              <Button size="sm" variant="outline" disabled={store.demoMode || store.role === 'viewer'} onClick={store.simulateRemoteShift}><GitMerge size={14} />{t('simulateRemote')}</Button>
              <Button size="sm" disabled={!store.online || pendingCount === 0} onClick={store.mergeOutbox}><RefreshCw size={14} />{t('mergeNow')} ({pendingCount})</Button>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><div><h2>{t('outbox')}</h2><p className="muted">断网时记录的审批/执行，回网后按版本合并；失败可重试且不重复写入。</p></div><RefreshCw size={20} /></CardHeader>
          <CardContent>
            {store.outbox.length === 0 ? <p className="muted">{t('noOutbox')}</p> : <div className="outbox-list">{store.outbox.map((op) => <div key={op.id} className="outbox-row"><div><strong>{op.actionTitle}</strong><div className="muted">{op.kind === 'approve' ? '审批' : '执行'} · {roleNames[op.role]} · v{op.baseVersion} · 第 {op.attempts} 次{op.error ? ` · ${op.error}` : ''}</div></div><div className="row-actions">{statusBadge(op.status, t)}{(op.status === 'failed' || op.status === 'pending') && <Button size="sm" variant="outline" disabled={!store.online} onClick={() => store.retryOp(op.id)}><RefreshCw size={13} />{t('retry')}</Button>}</div></div>)}</div>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><div><h2>{t('conflicts')}</h2><p className="muted">同一动作被两个班次改过时保留冲突，由负责人选定，未采用版本留档。</p></div><GitMerge size={20} /></CardHeader>
          <CardContent>
            {openConflicts.length === 0 ? <p className="muted">{t('noConflicts')}</p> : <div className="conflict-list">{openConflicts.map((cf) => <div key={cf.id} className="conflict-row"><div className="conflict-head"><strong>{cf.actionTitle}</strong><Badge className="badge-conflict">{t('conflict')}</Badge></div><div className="conflict-versions"><div className="version-box"><span className="muted">{t('localVersion')} (v{cf.baseVersion})</span><code>{cf.kind === 'approve' ? '审批' : '执行'} · {cf.local.approvals.join('、') || '无'} · {cf.local.status}</code></div><div className="version-box"><span className="muted">{t('remoteVersion')} (v{cf.remoteVersion})</span><code>{cf.kind === 'approve' ? '审批' : '执行'} · {cf.remote.approvals.join('、') || '无'} · {cf.remote.status}</code></div></div>{canResolve && <div className="row-actions"><Button size="sm" onClick={() => store.resolveConflict(cf.id, 'local')}><CheckCircle2 size={13} />{t('adoptLocal')}</Button><Button size="sm" variant="outline" onClick={() => store.resolveConflict(cf.id, 'remote')}><XCircle size={13} />{t('keepRemote')}</Button></div>}</div>)}</div>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><div><h2>{t('archive')}</h2><p className="muted">{t('unadoptedRetained')}</p></div><Archive size={20} /></CardHeader>
          <CardContent>
            {store.archive.length === 0 ? <p className="muted">{t('noArchive')}</p> : <div className="archive-list">{store.archive.map((ar) => <div key={ar.id} className="archive-row"><div><strong>{ar.actionTitle}</strong><div className="muted">{ar.retained === 'local' ? '本地版本' : '远端版本'} · {ar.reason}</div></div><code className="muted">{ar.snapshot.approvals.join('、') || '无'} · {ar.snapshot.status}</code></div>)}</div>}
          </CardContent>
        </Card>
      </div>
      <div className="stack">
        <Card><CardHeader><h2>新增子事件</h2></CardHeader><CardContent><form onSubmit={form.handleSubmit((values) => { store.addSubIncident(values); form.reset(); })}><label>子事件名称<Input {...form.register('title')} placeholder="例如：凭据轮换" /></label><small className="error">{form.formState.errors.title?.message}</small><label>负责组<Input {...form.register('owner')} placeholder="例如：平台组" /></label><small className="error">{form.formState.errors.owner?.message}</small><Button type="submit" disabled={store.demoMode || store.role === 'viewer'}><ShieldAlert size={16} />创建子事件</Button></form></CardContent></Card>
        <Card className="timeline-card"><CardHeader><div><h2>{t('timeline')}</h2><p className="muted">每 20 秒接收一次模拟监测事件</p></div><Radio color="#ef4444" /></CardHeader><CardContent><div className="timeline">{incident.timeline.map((event) => <article key={event.id}><i /><div><div className="timeline-meta"><strong>{event.actor}</strong><span>{formatDistanceToNow(new Date(event.at), { addSuffix: true, locale: zhCN })}</span></div><p>{event.sensitive && !canSeeSensitive ? '敏感处置记录已隐藏' : event.text}</p></div></article>)}</div></CardContent></Card>
      </div>
    </section>
  </main>;
}
