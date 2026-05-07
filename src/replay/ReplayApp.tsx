import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { RecordingSession, NetworkRequest, ConsoleLog, JSError, UserAction, SessionPage } from '../types';

type TabKey = 'timeline' | 'actions' | 'network' | 'console' | 'errors';
type TimelineKind = 'page' | 'action' | 'network' | 'console' | 'error';

const RRWEB_EVENT_TYPE = {
  FullSnapshot: 2,
  IncrementalSnapshot: 3,
} as const;

const RRWEB_INCREMENTAL_SOURCE = {
  Mutation: 0,
} as const;

// rr_media* 是 rrweb 内部运行时状态，回放端会重新计算，保留旧值反而造成状态错乱
const STALE_RRWEB_ATTRIBUTES = [
  'rr_mediaState',
  'rr_mediaCurrentTime',
  'rr_mediaPlaybackRate',
  'rr_mediaMuted',
  'rr_mediaLoop',
  'rr_mediaVolume',
];

interface TimelineItem {
  id: string;
  kind: TimelineKind;
  timestamp: number;
  title: string;
  meta: string;
  severity?: 'info' | 'warn' | 'error';
  action?: UserAction;
  request?: NetworkRequest;
  log?: ConsoleLog;
  error?: JSError;
  page?: SessionPage;
}

function sanitizeReplayEvents(events: unknown[]): unknown[] {
  return events
    .map((event) => sanitizeReplayEvent(event))
    .filter((event): event is unknown => Boolean(event));
}

function sanitizeReplayEvent(event: unknown): unknown | null {
  if (!event || typeof event !== 'object') return event;
  const rrEvent = event as any;

  if (rrEvent.type === RRWEB_EVENT_TYPE.FullSnapshot && rrEvent.data?.node) {
    return {
      ...rrEvent,
      data: {
        ...rrEvent.data,
        node: sanitizeSerializedNode(rrEvent.data.node),
      },
    };
  }

  if (rrEvent.type !== RRWEB_EVENT_TYPE.IncrementalSnapshot || !rrEvent.data) {
    return event;
  }

  if (rrEvent.data.source !== RRWEB_INCREMENTAL_SOURCE.Mutation) {
    // 保留所有非 Mutation 的增量事件（包括 MediaInteraction、Scroll 等）
    return event;
  }

  return {
    ...rrEvent,
    data: {
      ...rrEvent.data,
      adds: Array.isArray(rrEvent.data.adds)
        ? rrEvent.data.adds.map((add: any) => ({
            ...add,
            node: sanitizeSerializedNode(add.node),
          }))
        : rrEvent.data.adds,
      attributes: Array.isArray(rrEvent.data.attributes)
        ? rrEvent.data.attributes.map((mutation: any) => ({
            ...mutation,
            attributes: sanitizeAttributes(mutation.attributes),
          }))
        : rrEvent.data.attributes,
    },
  };
}

function sanitizeSerializedNode(node: any): any {
  if (!node || typeof node !== 'object') return node;

  const next = { ...node };
  if (next.attributes && typeof next.attributes === 'object') {
    next.attributes = sanitizeAttributes(next.attributes);
  }

  if (Array.isArray(next.childNodes)) {
    next.childNodes = next.childNodes.map((child: any) => sanitizeSerializedNode(child));
  }

  return next;
}

function sanitizeAttributes(attributes: any): any {
  if (!attributes || typeof attributes !== 'object') return attributes;

  const next = { ...attributes };
  // 只删除 rrweb 内部运行时状态属性，不动 src/srcset 等真实内容属性
  STALE_RRWEB_ATTRIBUTES.forEach((attr) => delete next[attr]);

  return next;
}

// 预加载 rrweb-player，避免切换时动态 import 带来的延迟
let rrwebPlayerModule: typeof import('rrweb-player').default | null = null;
import('rrweb-player').then(({ default: P }) => { rrwebPlayerModule = P; });

/* ============================================================ */
/*  SearchInput — 通用搜索框                                       */
/* ============================================================ */

const SearchInput: React.FC<{
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}> = ({ value, onChange, placeholder = '搜索...' }) => (
  <div className="search-bar">
    <svg className="search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
    <input
      className="search-input"
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
    />
    {value && (
      <button className="search-clear" onClick={() => onChange('')}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    )}
  </div>
);

/* ============================================================ */
/*  Main App                                                      */
/* ============================================================ */

const ReplayApp: React.FC = () => {
  const [session, setSession] = useState<RecordingSession | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('timeline');
  const [panelOpen, setPanelOpen] = useState(true);
  const [drawerReq, setDrawerReq] = useState<NetworkRequest | null>(null);
  const [filter, setFilter] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sessions, setSessions] = useState<RecordingSession[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const playerInstanceRef = useRef<any>(null);

  const seekToTimestamp = useCallback((timestamp: number) => {
    if (!session || !playerInstanceRef.current || !session.rrwebEvents.length) return;
    const firstEvent = session.rrwebEvents[0] as { timestamp?: number };
    const offset = Math.max(0, timestamp - (firstEvent.timestamp || session.startTime));
    try {
      playerInstanceRef.current.goto?.(offset, false);
    } catch (err) {
      try {
        playerInstanceRef.current.getReplayer?.().pause(offset);
      } catch {
        console.warn('[ReplayDebug] seek failed:', err);
      }
    }
  }, [session]);

  // 加载指定 session
  const loadSession = (id?: string) => {
    if (id) {
      chrome.runtime.sendMessage({ type: 'GET_RECORDING', payload: id }, (res) => {
        if (res?.session) setSession(res.session as RecordingSession);
      });
    } else {
      chrome.storage.local.get('lastSession', (result) => {
        if (result.lastSession) setSession(result.lastSession as RecordingSession);
      });
    }
  };

  // 从 URL 参数或 storage 加载 session
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    loadSession(params.get('id') || undefined);
  }, []);

  // 加载历史列表
  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_SESSIONS' }, (res) => {
      if (res?.sessions) setSessions(res.sessions as RecordingSession[]);
    });
  }, [session]);

  // 切换 tab 时清空搜索
  const handleTabChange = (tab: TabKey) => {
    setActiveTab(tab);
    setFilter('');
  };

  // 导出选中的录制数据
  const handleExport = () => {
    const idsToExport = selectedIds.size > 0 ? selectedIds : new Set(sessions.map(s => s.id));
    chrome.runtime.sendMessage({ type: 'EXPORT_SESSIONS' }, (res) => {
      const all = res?.sessions || [];
      if (all.length === 0) return;
      const filtered = all.filter((s: RecordingSession) => idsToExport.has(s.id));
      if (filtered.length === 0) return;
      const data = JSON.stringify({ version: 1, sessions: filtered }, null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `replay-debug-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setSelectedIds(new Set());
    });
  };

  // 刷新历史列表
  const refreshSessions = () => {
    chrome.runtime.sendMessage({ type: 'GET_SESSIONS' }, (res) => {
      if (res?.sessions) setSessions(res.sessions as RecordingSession[]);
    });
  };

  // 删除单个 session
  const handleDeleteOne = (id: string) => {
    chrome.runtime.sendMessage({ type: 'DELETE_SESSION', payload: id }, () => {
      setSelectedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
      // 如果删除的是当前正在看的 session，跳转到下一个
      if (session?.id === id) {
        const remaining = sessions.filter(s => s.id !== id);
        if (remaining.length > 0) {
          const next = remaining[remaining.length - 1];
          window.history.replaceState(null, '', `?id=${next.id}`);
          loadSession(next.id);
        } else {
          setSession(null);
        }
      }
      refreshSessions();
    });
  };

  // 批量删除选中的 session
  const handleBatchDelete = () => {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    chrome.runtime.sendMessage({ type: 'DELETE_SESSIONS', payload: ids }, () => {
      // 如果当前 session 被删了，跳转
      if (session && selectedIds.has(session.id)) {
        const remaining = sessions.filter(s => !selectedIds.has(s.id));
        if (remaining.length > 0) {
          const next = remaining[remaining.length - 1];
          window.history.replaceState(null, '', `?id=${next.id}`);
          loadSession(next.id);
        } else {
          setSession(null);
        }
      }
      setSelectedIds(new Set());
      refreshSessions();
    });
  };

  // 导入录制数据
  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const json = JSON.parse(reader.result as string);
          const imported = json.sessions || json;
          if (!Array.isArray(imported)) return;
          chrome.runtime.sendMessage({ type: 'IMPORT_SESSIONS', payload: imported }, (res) => {
            if (res?.success) {
              // 刷新历史列表和当前 session
              chrome.runtime.sendMessage({ type: 'GET_SESSIONS' }, (r) => {
                if (r?.sessions) setSessions(r.sessions as RecordingSession[]);
              });
            }
          });
        } catch {}
      };
      reader.readAsText(file);
    };
    input.click();
  };

  // 销毁旧 player
  const destroyPlayer = useCallback(() => {
    if (playerInstanceRef.current) {
      try { (playerInstanceRef.current as any).$destroy?.(); } catch {}
      playerInstanceRef.current = null;
    }
    if (playerContainerRef.current) {
      playerContainerRef.current.innerHTML = '';
    }
  }, []);

  useEffect(() => {
    if (!session || !playerContainerRef.current || session.rrwebEvents.length === 0) return;

    const container = playerContainerRef.current;
    const replayEvents = sanitizeReplayEvents(session.rrwebEvents);
    if (replayEvents.length === 0) return;

    const rafId = requestAnimationFrame(() => {
      const createPlayer = (rrwebPlayer: any) => {
        if (!playerContainerRef.current) return;
        destroyPlayer();

        const vw = session.viewport.width || 1024;
        const vh = session.viewport.height || 768;
        const rect = playerContainerRef.current.getBoundingClientRect();
        const containerW = rect.width;
        const containerH = rect.height;
        if (containerW <= 0 || containerH <= 0) return;

        const scale = Math.min(containerW / vw, containerH / vh, 1);
        const playerW = Math.round(vw * scale);
        const playerH = Math.round(vh * scale);

        playerInstanceRef.current = new rrwebPlayer({
          target: playerContainerRef.current!,
          props: {
            events: replayEvents,
            width: playerW,
            height: playerH,
            autoPlay: false,
            showController: true,
            speed: 1,
            speedOption: [0.5, 1, 2, 4],
          },
        });
      };

      // 使用预加载的模块或 fallback 动态加载
      if (rrwebPlayerModule) {
        createPlayer(rrwebPlayerModule);
      } else {
        import('rrweb-player').then(({ default: P }) => {
          rrwebPlayerModule = P;
          createPlayer(P);
        });
      }
    });

    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [session, panelOpen, destroyPlayer]);

  if (!session) {
    return (
      <div className="page-empty">
        <div className="page-empty-inner">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
            <rect x="4" y="8" width="40" height="28" rx="4" stroke="#d0d5dd" strokeWidth="2" />
            <path d="M20 18L30 24L20 30V18Z" fill="#d0d5dd" />
            <rect x="16" y="38" width="16" height="2" rx="1" fill="#d0d5dd" />
          </svg>
          <h2>暂无录制数据</h2>
          <p>点击浏览器扩展图标开始录制用户操作</p>
        </div>
      </div>
    );
  }

  const duration = session.endTime - session.startTime;
  const pageCount = (session.pages?.length || 1);

  const tabs: { key: TabKey; label: string; count: number }[] = [
    { key: 'timeline', label: '全部时间线', count: getTimelineItems(session).length },
    { key: 'actions', label: '操作记录', count: session.actions.length },
    { key: 'network', label: '网络请求', count: session.networkRequests.length },
    { key: 'console', label: '控制台', count: session.consoleLogs.length },
    { key: 'errors', label: '错误', count: session.errors.length },
  ];

  return (
    <div className="page">
      <nav className="navbar">
        <div className="navbar-brand">
          <div className="brand-icon">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="8" cy="8" r="2.5" fill="currentColor" />
            </svg>
          </div>
          <span className="brand-text">Replay Debug</span>
        </div>

        <div className="navbar-center">
          <span className="page-title">{session.title || session.url}</span>
        </div>

        <div className="navbar-meta">
          <span className="meta-item">{new Date(session.startTime).toLocaleString('zh-CN')}</span>
          <span className="meta-divider">|</span>
          <span className="meta-item">{formatDuration(duration)}</span>
          <span className="meta-divider">|</span>
          <span className="meta-item">{session.viewport.width}x{session.viewport.height}</span>
          {pageCount > 1 && (
            <>
              <span className="meta-divider">|</span>
              <span className="meta-item">{pageCount} 个页面</span>
            </>
          )}
          {session.errors.length > 0 && (
            <>
              <span className="meta-divider">|</span>
              <span className="meta-item meta-error">{session.errors.length} 个错误</span>
            </>
          )}
        </div>
      </nav>

      <div className="workspace">
        {/* 历史记录侧栏 */}
        <aside className={`history-sidebar ${historyOpen ? '' : 'history-sidebar--collapsed'}`}>
          <button className="history-toggle" onClick={() => setHistoryOpen(!historyOpen)} title={historyOpen ? '收起历史记录' : '展开历史记录'}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
            </svg>
          </button>
          {historyOpen && (
            <>
              <div className="history-header">
                <label className="history-select-all">
                  <input
                    type="checkbox"
                    checked={sessions.length > 0 && selectedIds.size === sessions.length}
                    ref={(el) => {
                      if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < sessions.length;
                    }}
                    onChange={() => {
                      if (selectedIds.size === sessions.length) {
                        setSelectedIds(new Set());
                      } else {
                        setSelectedIds(new Set(sessions.map(s => s.id)));
                      }
                    }}
                  />
                  <span>全选</span>
                </label>
                <span className="history-count">{selectedIds.size > 0 ? `已选 ${selectedIds.size}` : `${sessions.length} 条`}</span>
              </div>
              <div className="history-list">
                {sessions.length === 0 ? (
                  <div className="history-empty">暂无录制记录</div>
                ) : (
                  [...sessions].reverse().map((s) => {
                    const dur = s.endTime - s.startTime;
                    const date = new Date(s.startTime).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
                    const isSelected = selectedIds.has(s.id);
                    return (
                      <div
                        key={s.id}
                        className={`history-item ${session?.id === s.id ? 'history-item--active' : ''} ${isSelected ? 'history-item--selected' : ''}`}
                        onClick={() => {
                          window.history.replaceState(null, '', `?id=${s.id}`);
                          loadSession(s.id);
                        }}
                      >
                        <input
                          type="checkbox"
                          className="history-checkbox"
                          checked={isSelected}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => {
                            const next = new Set(selectedIds);
                            if (next.has(s.id)) next.delete(s.id);
                            else next.add(s.id);
                            setSelectedIds(next);
                          }}
                        />
                        <div className="history-item-content">
                          <div className="history-item-title">{s.title || s.url}</div>
                          <div className="history-item-meta">
                            <span>{date}</span>
                            <span>{formatDuration(dur)}</span>
                            {(s.errors?.length || 0) > 0 && <span className="history-item-errors">{s.errors.length} 错误</span>}
                          </div>
                        </div>
                        <button
                          className="history-delete-btn"
                          title="删除"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteOne(s.id);
                          }}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
              <div className="history-actions">
                <button className="sidebar-action-btn" onClick={handleExport} title={selectedIds.size > 0 ? `导出选中的 ${selectedIds.size} 条` : '导出全部'}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
                  导出{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}
                </button>
                <button className="sidebar-action-btn" onClick={handleImport} title="导入录制数据">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                  导入
                </button>
                {selectedIds.size > 0 && (
                  <button className="sidebar-action-btn sidebar-action-btn--danger" onClick={handleBatchDelete} title={`删除选中的 ${selectedIds.size} 条`}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" /></svg>
                    删除 ({selectedIds.size})
                  </button>
                )}
              </div>
            </>
          )}
        </aside>

        <div className={`player-section ${panelOpen ? '' : 'player-full'}`}>
          <div className="player-shell">
            <div className="browser-bar">
              <div className="browser-dots">
                <span className="dot dot-red" />
                <span className="dot dot-yellow" />
                <span className="dot dot-green" />
              </div>
              <div className="browser-url">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="#999" strokeWidth="1.5">
                  <circle cx="8" cy="8" r="6" /><path d="M8 2a6 6 0 010 12" fill="#999" /><line x1="2" y1="8" x2="14" y2="8" /><path d="M8 2c1.5 2 2.5 4 2.5 6s-1 4-2.5 6" /><path d="M8 2c-1.5 2-2.5 4-2.5 6s1 4 2.5 6" />
                </svg>
                <span>{session.url}</span>
              </div>
              <button className="toggle-btn" onClick={() => setPanelOpen(!panelOpen)} title={panelOpen ? '收起面板' : '展开面板'}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  {panelOpen
                    ? <><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" /></>
                    : <><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" /></>
                  }
                </svg>
              </button>
            </div>
            <div className="player-mount" ref={playerContainerRef} />
          </div>
        </div>

        {panelOpen && (
          <aside className="panel">
            <div className="panel-tabs">
              {tabs.map((tab) => (
                <button
                  key={tab.key}
                  className={`panel-tab ${activeTab === tab.key ? 'panel-tab--active' : ''}`}
                  onClick={() => handleTabChange(tab.key)}
                >
                  {tab.label}
                  <span className={`tab-badge ${tab.count > 0 && tab.key === 'errors' ? 'tab-badge--danger' : ''}`}>
                    {tab.count}
                  </span>
                </button>
              ))}
            </div>
            <SearchInput value={filter} onChange={setFilter} placeholder={searchPlaceholder(activeTab)} />
            <div className="panel-body">
              {activeTab === 'timeline' && (
                <TimelinePanel
                  session={session}
                  filter={filter}
                  onSeek={seekToTimestamp}
                  onSelectRequest={setDrawerReq}
                />
              )}
              {activeTab === 'actions' && (
                <ActionsPanel actions={session.actions} pages={session.pages || []} filter={filter} onSeek={seekToTimestamp} />
              )}
              {activeTab === 'network' && (
                <NetworkPanel
                  requests={session.networkRequests}
                  pages={session.pages || []}
                  filter={filter}
                  onSelect={setDrawerReq}
                  onSeek={seekToTimestamp}
                />
              )}
              {activeTab === 'console' && (
                <ConsolePanel logs={session.consoleLogs} pages={session.pages || []} filter={filter} onSeek={seekToTimestamp} />
              )}
              {activeTab === 'errors' && (
                <ErrorsPanel errors={session.errors} pages={session.pages || []} filter={filter} onSeek={seekToTimestamp} />
              )}
            </div>
          </aside>
        )}
      </div>

      {drawerReq && <NetworkDrawer request={drawerReq} onClose={() => setDrawerReq(null)} />}
    </div>
  );
};

/* ============================================================ */
/*  Timeline Panel                                                */
/* ============================================================ */

const TimelinePanel: React.FC<{
  session: RecordingSession;
  filter: string;
  onSeek: (timestamp: number) => void;
  onSelectRequest: (req: NetworkRequest) => void;
}> = ({ session, filter, onSeek, onSelectRequest }) => {
  const [selected, setSelected] = useState<string | null>(null);
  const items = getTimelineItems(session);
  const filtered = filter
    ? items.filter((item) => matchFilter(filter, item.title, item.meta, item.kind, item.page?.url))
    : items;

  if (!items.length) return <PanelEmpty text="暂无时间线记录" />;
  if (!filtered.length) return <PanelEmpty text={`无匹配「${filter}」的记录`} />;

  return (
    <div className="timeline-list">
      {filtered.map((item) => {
        const page = getPageForTimestamp(session.pages || [], item.timestamp);
        const isSelected = selected === item.id;
        return (
          <div
            key={item.id}
            className={`timeline-row timeline-${item.kind} ${item.severity ? `timeline-${item.severity}` : ''} ${isSelected ? 'timeline-row--selected' : ''}`}
            onClick={() => {
              setSelected(isSelected ? null : item.id);
              onSeek(item.timestamp);
              if (item.request) onSelectRequest(item.request);
            }}
          >
            <div className="timeline-rail">
              <span className="timeline-dot" />
            </div>
            <div className="timeline-content">
              <div className="timeline-head">
                <span className="timeline-kind">{timelineKindLabel(item.kind)}</span>
                <span className="timeline-time">{fmtTime(item.timestamp - session.startTime)}</span>
                {item.severity && item.severity !== 'info' && <span className={`issue-chip issue-${item.severity}`}>{item.severity === 'error' ? '异常' : '警告'}</span>}
              </div>
              <div className="timeline-title">{item.title}</div>
              <div className="timeline-meta">{item.meta}</div>
              {page && item.kind !== 'page' && (
                <div className="timeline-page">{shortUrl(page.url)}</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

/* ============================================================ */
/*  Actions Panel                                                 */
/* ============================================================ */

const ActionsPanel: React.FC<{
  actions: UserAction[];
  pages: SessionPage[];
  filter: string;
  onSeek: (timestamp: number) => void;
}> = ({ actions, pages, filter, onSeek }) => {
  const [selected, setSelected] = useState<number | null>(null);
  const filtered = filter
    ? actions.filter((a) =>
        matchFilter(filter, a.text, a.selector, a.value, a.type, a.url, a.role, a.ariaLabel, a.placeholder)
      )
    : actions;

  if (!actions.length) return <PanelEmpty text="暂无操作记录" />;
  if (!filtered.length) return <PanelEmpty text={`无匹配「${filter}」的记录`} />;
  const t0 = actions[0].timestamp;

  return (
    <div className="list">
      {filtered.map((a, idx) => {
        const realIdx = actions.indexOf(a);
        const isNavigate = a.type === 'navigate';
        return (
          <div
            className={`list-row ${selected === realIdx ? 'list-row--selected' : ''} ${isNavigate ? 'list-row--navigate' : ''}`}
            key={realIdx}
            onClick={() => {
              setSelected(selected === realIdx ? null : realIdx);
              onSeek(a.timestamp);
            }}
          >
            <span className={`act-icon act-${a.type}`}>{actIcon(a.type)}</span>
            <div className="list-row-body">
              <span className="list-row-primary">{actionTitle(a)}</span>
              <span className="list-row-sub">{actionMeta(a, pages)}</span>
              {selected === realIdx && (
                <span className="list-row-details">
                  {a.selector}
                  {typeof a.clientX === 'number' && ` · (${a.clientX}, ${a.clientY})`}
                  {a.masked && ' · value masked'}
                </span>
              )}
            </div>
            <span className="list-row-time">{fmtTime(a.timestamp - t0)}</span>
          </div>
        );
      })}
    </div>
  );
};

/* ============================================================ */
/*  Network Panel                                                 */
/* ============================================================ */

const NetworkPanel: React.FC<{
  requests: NetworkRequest[];
  pages: SessionPage[];
  filter: string;
  onSelect: (req: NetworkRequest) => void;
  onSeek: (timestamp: number) => void;
}> = ({ requests, pages, filter, onSelect, onSeek }) => {
  const [selected, setSelected] = useState<number | null>(null);
  const [mode, setMode] = useState<'all' | 'issues' | 'slow'>('all');
  const modeFiltered = requests.filter((r) => {
    if (mode === 'issues') return isProblemRequest(r);
    if (mode === 'slow') return r.duration >= 1000;
    return true;
  });
  const filtered = filter
    ? modeFiltered.filter((r) =>
        matchFilter(filter, r.url, r.method, String(r.status), r.statusText, r.type, r.requestBody, r.responseBody, r.contentType)
      )
    : modeFiltered;

  if (!requests.length) return <PanelEmpty text="暂无网络请求" />;
  if (!filtered.length) return <PanelEmpty text={filter ? `无匹配「${filter}」的请求` : '当前过滤条件下暂无请求'} />;

  return (
    <div className="panel-stack">
      <div className="filter-pills">
        <button className={mode === 'all' ? 'filter-pill filter-pill--active' : 'filter-pill'} onClick={() => setMode('all')}>全部</button>
        <button className={mode === 'issues' ? 'filter-pill filter-pill--active' : 'filter-pill'} onClick={() => setMode('issues')}>问题</button>
        <button className={mode === 'slow' ? 'filter-pill filter-pill--active' : 'filter-pill'} onClick={() => setMode('slow')}>慢请求</button>
      </div>
      <div className="list">
        {filtered.map((r) => {
          const realIdx = requests.indexOf(r);
          const page = getPageForTimestamp(pages, r.timestamp);
          return (
            <div
              className={`list-row list-row--clickable ${selected === realIdx ? 'list-row--selected' : ''} ${isProblemRequest(r) ? 'list-row--issue' : ''}`}
              key={r.id || realIdx}
              onClick={() => {
                setSelected(realIdx);
                onSeek(r.timestamp);
                onSelect(r);
              }}
            >
              <span className={`http-method http-${r.method}`}>{r.method}</span>
              <span className={`http-status http-s${Math.floor((r.status || 0) / 100)}`}>{r.status || 'ERR'}</span>
              <div className="list-row-body">
                <span className="list-row-primary list-row-primary--mono" title={r.url}>{shortUrl(r.url)}</span>
                <span className="list-row-sub">
                  {r.contentType || r.type.toUpperCase()}
                  {page ? ` · ${shortUrl(page.url)}` : ''}
                  {r.truncated ? ' · truncated' : ''}
                </span>
              </div>
              <span className="list-row-ms">{r.duration}ms</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

/* ============================================================ */
/*  Network Drawer                                                */
/* ============================================================ */

const NetworkDrawer: React.FC<{
  request: NetworkRequest;
  onClose: () => void;
}> = ({ request, onClose }) => {
  const [tab, setTab] = useState<'headers' | 'request' | 'response'>('headers');
  const reqJson = tryFormatJson(request.requestBody);
  const resJson = tryFormatJson(request.responseBody);

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <div className="drawer-title">
            <span className={`http-method http-${request.method}`}>{request.method}</span>
            <span className="drawer-url">{request.url}</span>
          </div>
          <div className="drawer-meta">
            <span className={`http-status http-s${Math.floor((request.status || 0) / 100)}`}>{request.status || 'ERR'}</span>
            <span className="drawer-meta-sep">&middot;</span>
            <span>{request.duration}ms</span>
            <span className="drawer-meta-sep">&middot;</span>
            <span>{request.type.toUpperCase()}</span>
          </div>
          <button className="drawer-close" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="drawer-tabs">
          <button className={`drawer-tab ${tab === 'headers' ? 'drawer-tab--active' : ''}`} onClick={() => setTab('headers')}>Headers</button>
          {request.requestBody && (
            <button className={`drawer-tab ${tab === 'request' ? 'drawer-tab--active' : ''}`} onClick={() => setTab('request')}>Request Body</button>
          )}
          {request.responseBody && (
            <button className={`drawer-tab ${tab === 'response' ? 'drawer-tab--active' : ''}`} onClick={() => setTab('response')}>Response Body</button>
          )}
        </div>

        <div className="drawer-body">
          {tab === 'headers' && (
            <div className="drawer-headers">
              <div className="header-section">
                <div className="header-section-title">General</div>
                <div className="header-kv"><span>Request URL</span><span className="header-val--url">{request.url}</span></div>
                <div className="header-kv"><span>Method</span><span>{request.method}</span></div>
                <div className="header-kv"><span>Status Code</span><span className={`http-status http-s${Math.floor((request.status || 0) / 100)}`}>{request.status || 'ERR'} {request.statusText || ''}</span></div>
                <div className="header-kv"><span>Duration</span><span>{request.duration}ms</span></div>
                {request.contentType && <div className="header-kv"><span>Content Type</span><span>{request.contentType}</span></div>}
                {typeof request.requestSize === 'number' && <div className="header-kv"><span>Request Size</span><span>{formatBytes(request.requestSize)}</span></div>}
                {typeof request.responseSize === 'number' && <div className="header-kv"><span>Response Size</span><span>{formatBytes(request.responseSize)}{request.truncated ? ' · truncated' : ''}</span></div>}
                {request.error && <div className="header-kv"><span>Error</span><span className="header-val--error">{request.error}</span></div>}
              </div>
              {request.requestHeaders && Object.keys(request.requestHeaders).length > 0 && (
                <div className="header-section">
                  <div className="header-section-title">Request Headers<CopyBtn text={formatHeaders(request.requestHeaders)} /></div>
                  {Object.entries(request.requestHeaders).map(([k, v]) => (
                    <div className="header-kv" key={k}><span>{k}</span><span>{v}</span></div>
                  ))}
                </div>
              )}
              {request.responseHeaders && Object.keys(request.responseHeaders).length > 0 && (
                <div className="header-section">
                  <div className="header-section-title">Response Headers<CopyBtn text={formatHeaders(request.responseHeaders)} /></div>
                  {Object.entries(request.responseHeaders).map(([k, v]) => (
                    <div className="header-kv" key={k}><span>{k}</span><span>{v}</span></div>
                  ))}
                </div>
              )}
            </div>
          )}
          {tab === 'request' && request.requestBody && (
            <div className="drawer-code-wrap">
              <div className="drawer-code-toolbar"><span className="drawer-code-label">Request Body</span><CopyBtn text={reqJson} /></div>
              <pre className="drawer-code">{reqJson}</pre>
            </div>
          )}
          {tab === 'response' && request.responseBody && (
            <div className="drawer-code-wrap">
              <div className="drawer-code-toolbar"><span className="drawer-code-label">Response Body</span><CopyBtn text={resJson} /></div>
              <pre className="drawer-code">{resJson}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/* ============================================================ */
/*  Console Panel                                                 */
/* ============================================================ */

const ConsolePanel: React.FC<{
  logs: ConsoleLog[];
  pages: SessionPage[];
  filter: string;
  onSeek: (timestamp: number) => void;
}> = ({ logs, pages, filter, onSeek }) => {
  const [selected, setSelected] = useState<number | null>(null);
  const filtered = filter
    ? logs.filter((l) => matchFilter(filter, l.args.join(' '), l.level, l.url, l.stack))
    : logs;

  if (!logs.length) return <PanelEmpty text="暂无控制台日志" />;
  if (!filtered.length) return <PanelEmpty text={`无匹配「${filter}」的日志`} />;

  return (
    <div className="list">
      {filtered.map((l) => {
        const realIdx = logs.indexOf(l);
        const page = getPageForTimestamp(pages, l.timestamp);
        return (
          <div
            className={`list-row list-row--console log-${l.level} ${selected === realIdx ? 'list-row--selected' : ''}`}
            key={realIdx}
            onClick={() => {
              setSelected(selected === realIdx ? null : realIdx);
              onSeek(l.timestamp);
            }}
          >
            <span className={`log-badge log-${l.level}`}>
              {l.level === 'error' ? 'E' : l.level === 'warn' ? 'W' : l.level === 'info' ? 'I' : 'L'}
            </span>
            <div className="console-content">
              <span className="console-text">{l.args.join(' ')}</span>
              <span className="console-loc">
                {l.url ? shortUrl(l.url) : page ? shortUrl(page.url) : ''}
                {l.line ? `:${l.line}:${l.col}` : ''}
              </span>
              {selected === realIdx && l.stack && <pre className="console-stack">{l.stack}</pre>}
            </div>
          </div>
        );
      })}
    </div>
  );
};

/* ============================================================ */
/*  Errors Panel                                                  */
/* ============================================================ */

const ErrorsPanel: React.FC<{
  errors: JSError[];
  pages: SessionPage[];
  filter: string;
  onSeek: (timestamp: number) => void;
}> = ({ errors, pages, filter, onSeek }) => {
  const [selected, setSelected] = useState<number | null>(null);
  const filtered = filter
    ? errors.filter((e) => matchFilter(filter, e.message, e.filename, e.stack, e.type, e.sourceUrl, e.tagName))
    : errors;

  if (!errors.length) return <PanelEmpty text="没有捕获到错误" />;
  if (!filtered.length) return <PanelEmpty text={`无匹配「${filter}」的错误`} />;

  return (
    <div className="list">
      {filtered.map((e) => {
        const realIdx = errors.indexOf(e);
        const page = getPageForTimestamp(pages, e.timestamp);
        return (
          <div
            className={`list-row-wrap list-row-wrap--error ${selected === realIdx ? 'list-row--selected' : ''}`}
            key={realIdx}
            onClick={() => {
              setSelected(selected === realIdx ? null : realIdx);
              onSeek(e.timestamp);
            }}
          >
            <div className="err-head">
              <span className="err-badge">{errorTypeLabel(e)}</span>
              <span className="err-msg">{e.message}</span>
            </div>
            {e.sourceUrl && <div className="err-loc">{e.tagName} · {e.sourceUrl}</div>}
            {e.filename && <div className="err-loc">{shortUrl(e.filename)}{e.lineno ? `:${e.lineno}:${e.colno}` : ''}</div>}
            {page && <div className="err-loc">Page · {shortUrl(page.url)}</div>}
            {e.stack && <pre className="err-stack">{e.stack}</pre>}
          </div>
        );
      })}
    </div>
  );
};

/* ============================================================ */
/*  Copy Button                                                   */
/* ============================================================ */

const CopyBtn: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);

  return (
    <button className="copy-btn" onClick={handleCopy} title="复制">
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2"><polyline points="20 6 9 17 4 12" /></svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
      )}
    </button>
  );
};

/* ============================================================ */
/*  Shared                                                        */
/* ============================================================ */

const PanelEmpty: React.FC<{ text: string }> = ({ text }) => (
  <div className="panel-empty"><p>{text}</p></div>
);

/* ============================================================ */
/*  Helpers                                                       */
/* ============================================================ */

function formatDuration(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}分${s % 60}秒`;
}
function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function fmtTime(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}
function shortUrl(u: string) {
  try {
    const p = new URL(u);
    const t = p.pathname + p.search;
    return t.length > 44 ? t.slice(0, 44) + '...' : t;
  } catch {
    return u.length > 44 ? u.slice(0, 44) + '...' : u;
  }
}
function actIcon(t: string) {
  return ({ click: 'CL', input: 'IN', scroll: 'SC', navigate: 'NV', keypress: 'KY', resize: 'RZ' } as Record<string, string>)[t] || 'EV';
}
function tryFormatJson(s?: string): string {
  if (!s) return '';
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}
function formatHeaders(h: Record<string, string>): string {
  return Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\n');
}
function matchFilter(q: string, ...fields: (string | undefined | null)[]): boolean {
  const lower = q.toLowerCase();
  return fields.some((f) => f && f.toLowerCase().includes(lower));
}
function searchPlaceholder(tab: TabKey): string {
  return ({ timeline: '搜索全部时间线...', actions: '搜索操作...', network: '搜索 URL / Method...', console: '搜索日志...', errors: '搜索错误信息...' })[tab];
}
function getPageForTimestamp(pages: SessionPage[], timestamp: number): SessionPage | null {
  if (!pages.length) return null;
  let current = pages[0];
  for (const page of pages) {
    if (page.timestamp <= timestamp) current = page;
    else break;
  }
  return current;
}
function isProblemRequest(r: NetworkRequest): boolean {
  return Boolean(r.error || !r.status || r.status >= 400);
}
function timelineKindLabel(kind: TimelineKind): string {
  return ({ page: '页面', action: '操作', network: '请求', console: '日志', error: '错误' })[kind];
}
function errorTypeLabel(e: JSError): string {
  if (e.type === 'resourceError') return 'Resource';
  if (e.type === 'promiseError') return 'Promise';
  return 'JS Error';
}
function actionTitle(a: UserAction): string {
  if (a.type === 'navigate') return a.text || a.value || 'Navigate';
  if (a.type === 'input') return `${a.placeholder || a.name || a.selector} changed`;
  if (a.type === 'click') return a.text || a.ariaLabel || a.href || a.selector;
  if (a.type === 'keypress') return `Key ${a.value || ''}`.trim();
  return a.text || a.selector || a.type;
}
function actionMeta(a: UserAction, pages: SessionPage[]): string {
  const parts: string[] = [a.type];
  if (a.tagName) parts.push(a.tagName);
  if (a.value && a.type !== 'navigate') parts.push(a.value);
  const page = getPageForTimestamp(pages, a.timestamp);
  if (page) parts.push(shortUrl(page.url));
  return parts.join(' · ');
}
function getTimelineItems(session: RecordingSession): TimelineItem[] {
  const items: TimelineItem[] = [];

  (session.pages || []).forEach((page, index) => {
    items.push({
      id: `page-${index}-${page.timestamp}`,
      kind: 'page',
      timestamp: page.timestamp,
      title: page.title || shortUrl(page.url),
      meta: `${page.source || 'page'} · ${page.url}`,
      severity: 'info',
      page,
    });
  });

  session.actions.forEach((action, index) => {
    items.push({
      id: `action-${index}-${action.timestamp}`,
      kind: 'action',
      timestamp: action.timestamp,
      title: actionTitle(action),
      meta: actionMeta(action, session.pages || []),
      severity: action.type === 'navigate' ? 'info' : undefined,
      action,
    });
  });

  session.networkRequests.forEach((request, index) => {
    items.push({
      id: `network-${request.id || index}-${request.timestamp}`,
      kind: 'network',
      timestamp: request.timestamp,
      title: `${request.method} ${shortUrl(request.url)}`,
      meta: `${request.status || 'ERR'} ${request.statusText || ''} · ${request.duration}ms${request.contentType ? ` · ${request.contentType}` : ''}`,
      severity: isProblemRequest(request) ? 'error' : request.duration >= 1000 ? 'warn' : undefined,
      request,
    });
  });

  session.consoleLogs.forEach((log, index) => {
    items.push({
      id: `console-${index}-${log.timestamp}`,
      kind: 'console',
      timestamp: log.timestamp,
      title: log.args.join(' '),
      meta: `${log.level}${log.url ? ` · ${shortUrl(log.url)}` : ''}`,
      severity: log.level === 'error' ? 'error' : log.level === 'warn' ? 'warn' : undefined,
      log,
    });
  });

  session.errors.forEach((error, index) => {
    items.push({
      id: `error-${index}-${error.timestamp}`,
      kind: 'error',
      timestamp: error.timestamp,
      title: error.message,
      meta: error.sourceUrl || error.filename || error.type,
      severity: 'error',
      error,
    });
  });

  return items.sort((a, b) => a.timestamp - b.timestamp);
}

export default ReplayApp;
