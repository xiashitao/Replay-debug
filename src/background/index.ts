import type {
  RecordingSession,
  UserAction,
  NetworkRequest,
  ConsoleLog,
  JSError,
} from '../types';

// 当前录制会话
let currentSession: RecordingSession | null = null;
let isRecording = false;
// 开始录制时锁定的 active tab
let recordingTabId: number | null = null;
// 由录制 tab 打开的候选新 tab；激活后才切换录制焦点
const openedFromRecordingTab = new Map<number, number>();

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function isInjectableUrl(url?: string) {
  return !!url && /^(https?|file):/i.test(url);
}

function createSession(tab: chrome.tabs.Tab): RecordingSession {
  const now = Date.now();
  return {
    id: uid(),
    url: tab.url || '',
    title: tab.title || '',
    startTime: now,
    endTime: 0,
    userAgent: navigator.userAgent,
    viewport: {
      width: tab.width || 0,
      height: tab.height || 0,
    },
    rrwebEvents: [],
    actions: [],
    networkRequests: [],
    consoleLogs: [],
    errors: [],
    screenshots: [],
    pages: [{
      url: tab.url || '',
      title: tab.title || '',
      timestamp: now,
      tabId: tab.id,
      windowId: tab.windowId,
      source: 'start',
    }],
  };
}

// ============================================================
// 状态持久化 — 防止 Service Worker 被终止后丢失录制状态
// ============================================================

let autoSaveTimer: ReturnType<typeof setInterval> | null = null;

// 记录上次持久化时已写入的事件数，auto-save 时只追加新增事件，避免全量重写
let lastPersistedEventCount = 0;

async function persistState() {
  await chrome.storage.session.set({
    isRecording: true,
    recordingTabId,
  });
}

// persistSession 只保存 session 元数据 + 增量新事件，避免全量写入造成卡顿
async function persistSession() {
  if (!currentSession) return;
  try {
    const newEvents = currentSession.rrwebEvents.slice(lastPersistedEventCount);
    if (newEvents.length === 0) return;

    // 追加新增事件到独立 key，而不是重写整个 session
    const pendingKey = `session_events_pending_${currentSession.id}`;
    const stored = await chrome.storage.local.get(pendingKey);
    const existing: unknown[] = stored[pendingKey] || [];
    await chrome.storage.local.set({
      [pendingKey]: existing.concat(newEvents),
      // 元数据（无 rrwebEvents）单独保存，用于 SW 重启恢复状态
      activeSessionMeta: { ...currentSession, rrwebEvents: [] },
    });
    lastPersistedEventCount = currentSession.rrwebEvents.length;
  } catch (err) {
    console.error('[ReplayDebug] Failed to persist session:', err);
  }
}

function startAutoSave() {
  stopAutoSave();
  lastPersistedEventCount = 0;
  autoSaveTimer = setInterval(persistSession, 3000);
}

function stopAutoSave() {
  if (autoSaveTimer) {
    clearInterval(autoSaveTimer);
    autoSaveTimer = null;
  }
}

async function clearPersistedState() {
  stopAutoSave();
  lastPersistedEventCount = 0;
  const meta = await chrome.storage.local.get('activeSessionMeta');
  const sessionId = (meta.activeSessionMeta as any)?.id;
  await chrome.storage.session.remove(['isRecording', 'recordingTabId']);
  const keysToRemove: string[] = ['activeSessionMeta'];
  if (sessionId) keysToRemove.push(`session_events_pending_${sessionId}`);
  await chrome.storage.local.remove(keysToRemove);
}

// Service Worker 启动时尝试恢复录制状态
async function restoreState() {
  const state = await chrome.storage.session.get(['isRecording', 'recordingTabId']);
  if (!state.isRecording) return;

  console.log('[ReplayDebug] Restoring recording state, tabId:', state.recordingTabId);
  isRecording = true;
  recordingTabId = state.recordingTabId as number | null;

  const result = await chrome.storage.local.get('activeSessionMeta');
  if (result.activeSessionMeta) {
    currentSession = result.activeSessionMeta as RecordingSession;
    // 从增量存储恢复已持久化的事件
    const pendingKey = `session_events_pending_${currentSession.id}`;
    const eventsResult = await chrome.storage.local.get(pendingKey);
    if (eventsResult[pendingKey]) {
      currentSession.rrwebEvents = eventsResult[pendingKey] as unknown[];
      lastPersistedEventCount = currentSession.rrwebEvents.length;
    }
    console.log('[ReplayDebug] State restored. rrwebEvents:', currentSession.rrwebEvents.length);
    startAutoSave();
  }
}

// 启动时立即恢复
restoreState();

// ============================================================
// Content Script 注入
// ============================================================

async function injectAndStart(tabId: number) {
  try {
    // allFrames: true — 将 content script 注入所有 frame（含跨域 iframe），
    // 配合 recordCrossOriginIframes 实现完整页面录制，避免 iframe 区域白屏
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content.js'],
    });
    // 给 content script 一点时间注册消息监听器
    await new Promise((r) => setTimeout(r, 100));
    // START_RECORDING 只需发给主 frame（frameId: 0），
    // 主 frame 的 recorder 会通过 postMessage 协调子 iframe
    const resp = await chrome.tabs.sendMessage(tabId, { type: 'START_RECORDING' }, { frameId: 0 });
    console.log('[ReplayDebug] injectAndStart response:', resp);
  } catch (err) {
    console.error('[ReplayDebug] injectAndStart failed:', err);
  }
}

async function stopTabRecording(tabId: number) {
  try {
    // 通知主 frame 停止（主 frame 会 flush 最后一批事件后才 sendResponse）
    await chrome.tabs.sendMessage(tabId, { type: 'STOP_RECORDING' }, { frameId: 0 });
    // 异步通知所有子 iframe 停止（不等待响应，避免阻塞）
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
      },
    }).catch(() => {});
    // 等待主 frame 最后一批事件传达到 background onMessage 处理
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  } catch {
    // tab 可能已经关闭，或页面还没有 content script
  }
  flushEvents();
  try {
    chrome.action.setBadgeText({ text: '', tabId });
  } catch {
    // 忽略
  }
}

function setRecordingBadge(tabId: number) {
  chrome.action.setBadgeText({ text: 'REC', tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#FF0000', tabId });
}

// ============================================================
// 录制控制
// ============================================================

let rrwebEventCount = 0;
let screenshotCount = 0;
const MAX_SCREENSHOTS = 10;

// rrweb 事件批量缓冲 — 减少高频消息带来的开销
let eventBuffer: unknown[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL = 500; // 每 500ms 批量写入一次

function bufferEvent(event: unknown) {
  eventBuffer.push(event);
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      if (currentSession && eventBuffer.length > 0) {
        currentSession.rrwebEvents.push(...eventBuffer);
      }
      eventBuffer = [];
      flushTimer = null;
    }, FLUSH_INTERVAL);
  }
}

function flushEvents() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (currentSession && eventBuffer.length > 0) {
    currentSession.rrwebEvents.push(...eventBuffer);
  }
  eventBuffer = [];
}

async function saveCompletedSession(session: RecordingSession) {
  // sessions 列表只存元数据，不存 rrwebEvents，避免列表随录制次数线性膨胀导致卡顿
  const sessionMeta: RecordingSession = {
    ...session,
    screenshots: [],
    rrwebEvents: [],
  };
  const savedSessions = await getSessions();
  const dedupedSessions = savedSessions.filter((s) => s.id !== session.id);
  dedupedSessions.push(sessionMeta);

  // rrwebEvents 单独存储，key: session_events_${id}
  // lastSession 保留完整数据，供最近一次录制直接回放
  await chrome.storage.local.set({
    sessions: dedupedSessions,
    [`session_events_${session.id}`]: session.rrwebEvents,
    lastSession: { ...session, screenshots: [] },
  });
}

async function startRecording(tabId: number) {
  if (isRecording) {
    await stopRecording();
  }

  const tab = await chrome.tabs.get(tabId);
  currentSession = createSession(tab);
  isRecording = true;
  recordingTabId = tabId;
  openedFromRecordingTab.clear();
  screenshotCount = 0;
  rrwebEventCount = 0;

  await injectAndStart(tabId);

  // 持久化状态
  await persistState();
  startAutoSave();

  // 更新图标状态
  setRecordingBadge(tabId);
}

async function stopRecording() {
  if (!isRecording || !currentSession) return;

  const session = currentSession;
  const tabId = recordingTabId;

  // 通知正在录制的 tab 停止
  if (tabId !== null) {
    await stopTabRecording(tabId);
  }

  // Content Script 停止后会发送最后一批 rrweb 事件，再刷新 background 缓冲
  flushEvents();

  session.endTime = session.endTime || Date.now();

  console.log('[ReplayDebug] Recording stopped. Stats:', {
    rrwebEvents: session.rrwebEvents.length,
    actions: session.actions.length,
    pages: session.pages.length,
  });

  try {
    await saveCompletedSession(session);
  } catch (err) {
    console.error('Failed to save recording:', err);
    currentSession = session;
    isRecording = true;
    recordingTabId = tabId;
    await persistState();
    await persistSession();
    throw err;
  }

  currentSession = null;
  isRecording = false;
  recordingTabId = null;
  openedFromRecordingTab.clear();

  // 保存成功后再清理持久化状态，避免写入失败时丢失 activeSession。
  await clearPersistedState();

  return session;
}

async function getSessions(): Promise<RecordingSession[]> {
  const result = await chrome.storage.local.get('sessions');
  return (result.sessions as RecordingSession[]) || [];
}

async function captureScreenshot() {
  if (!currentSession) return;
  if (screenshotCount >= MAX_SCREENSHOTS) return;
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: 'jpeg', quality: 40 });
    currentSession.screenshots.push({
      timestamp: Date.now(),
      dataUrl,
      trigger: 'action',
    });
    screenshotCount++;
  } catch {
    // 忽略截图失败
  }
}

function enrichWithTab<T extends object>(payload: T, tab?: chrome.tabs.Tab): T & { tabId?: number; windowId?: number } {
  return {
    ...payload,
    tabId: tab?.id,
    windowId: tab?.windowId,
  };
}

function recordNavigation(tab: chrome.tabs.Tab, source: string, timestamp = Date.now(), openerTabId?: number) {
  if (!currentSession) return;

  const url = tab.url || '';
  if (!url || url === 'about:blank') return;

  const title = tab.title || '';
  const lastPage = currentSession.pages[currentSession.pages.length - 1];
  if (lastPage && lastPage.url === url && lastPage.tabId === tab.id) return;

  currentSession.pages.push({
    url,
    title,
    timestamp,
    tabId: tab.id,
    windowId: tab.windowId,
    openerTabId,
    source,
  });

  currentSession.actions.push({
    type: 'navigate',
    timestamp,
    selector: '',
    xpath: '',
    text: `Navigate to ${title || url}`,
    value: url,
    viewportWidth: tab.width || 0,
    viewportHeight: tab.height || 0,
    url,
    tabId: tab.id,
    windowId: tab.windowId,
  });
}

async function switchRecordingToTab(tabId: number, source: string, openerTabId?: number) {
  if (!isRecording || !currentSession) return;
  openedFromRecordingTab.delete(tabId);
  if (recordingTabId === tabId) return;

  const previousTabId = recordingTabId;
  if (previousTabId !== null) {
    await stopTabRecording(previousTabId);
  }

  recordingTabId = tabId;
  await persistState();
  setRecordingBadge(tabId);

  const tab = await chrome.tabs.get(tabId);
  recordNavigation(tab, source, Date.now(), openerTabId);

  if (tab.status === 'complete' && isInjectableUrl(tab.url)) {
    await injectAndStart(tabId);
  }
}

// ============================================================
// 消息监听器
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 来自 Content Script 的录制数据
  if (currentSession && recordingTabId !== null && sender.tab?.id === recordingTabId) {
    switch (message.type) {
      case 'RRWEB_EVENT':
        bufferEvent(message.payload);
        break;
      case 'RRWEB_EVENTS_BATCH':
        if (Array.isArray(message.payload)) {
          message.payload.forEach((e: unknown) => bufferEvent(e));
        }
        break;
      case 'USER_ACTION':
        currentSession.actions.push(enrichWithTab(message.payload as UserAction, sender.tab));
        // 截图不阻塞消息处理
        captureScreenshot().catch(() => {});
        break;
      case 'NETWORK_REQUEST':
        currentSession.networkRequests.push(enrichWithTab(message.payload as NetworkRequest, sender.tab));
        break;
      case 'CONSOLE_LOG':
        currentSession.consoleLogs.push(enrichWithTab(message.payload as ConsoleLog, sender.tab));
        break;
      case 'JS_ERROR':
        currentSession.errors.push(enrichWithTab(message.payload as JSError, sender.tab));
        captureScreenshot().catch(() => {});
        break;
      case 'ROUTE_CHANGE':
        if (sender.tab) {
          recordNavigation({
            ...sender.tab,
            url: message.payload?.url || sender.tab.url,
            title: message.payload?.title || sender.tab.title,
          }, message.payload?.source || 'spa', message.payload?.timestamp || Date.now());
        }
        break;
    }
  }

  // 来自 Popup / Replay 的控制消息
  switch (message.type) {
    case 'START_RECORDING':
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          startRecording(tabs[0].id)
            .then(() => sendResponse({ success: true }))
            .catch((err) => sendResponse({ success: false, error: String(err) }));
        } else {
          sendResponse({ success: false, error: 'No active tab' });
        }
      });
      return true;

    case 'STOP_RECORDING':
      stopRecording()
        .then((session) => sendResponse({ success: true, session }))
        .catch((err) => {
          console.error('Stop recording error:', err);
          sendResponse({ success: false, error: String(err) });
        });
      return true;

    case 'RECORDING_STATUS':
      sendResponse({ isRecording, session: currentSession });
      return false;

    case 'GET_SESSIONS':
      getSessions().then((sessions) => sendResponse({ sessions }));
      return true;

    case 'GET_RECORDING':
      (async () => {
        const id = message.payload as string | undefined;
        const lastResult = await chrome.storage.local.get('lastSession');
        const last = lastResult.lastSession as RecordingSession | undefined;

        if (!id) {
          sendResponse({ session: last || null });
          return;
        }

        // 优先使用 lastSession（含完整 rrwebEvents）
        if (last && last.id === id) {
          sendResponse({ session: last });
          return;
        }

        // 历史 session：从 sessions 元数据 + 独立 events key 合并
        const sessions = await getSessions();
        const meta = sessions.find((s) => s.id === id);
        if (meta) {
          const eventsResult = await chrome.storage.local.get(`session_events_${id}`);
          const events: unknown[] = eventsResult[`session_events_${id}`] || [];
          sendResponse({ session: { ...meta, rrwebEvents: events } });
        } else {
          sendResponse({ session: null });
        }
      })();
      return true;

    case 'DELETE_SESSION':
      (async () => {
        const id = message.payload as string;
        const sessions = await getSessions();
        const filtered = sessions.filter((s) => s.id !== id);
        await chrome.storage.local.set({ sessions: filtered });
        await chrome.storage.local.remove(`session_events_${id}`);
        sendResponse({ success: true });
      })();
      return true;

    case 'DELETE_SESSIONS':
      (async () => {
        const idsToDelete = new Set(message.payload as string[]);
        const sessions = await getSessions();
        const filtered = sessions.filter((s) => !idsToDelete.has(s.id));
        await chrome.storage.local.set({ sessions: filtered });
        // 同时清理各 session 的独立 events key
        const eventKeys = Array.from(idsToDelete).map((id) => `session_events_${id}`);
        if (eventKeys.length > 0) await chrome.storage.local.remove(eventKeys);
        sendResponse({ success: true, count: idsToDelete.size });
      })();
      return true;

    case 'OPEN_REPLAY':
      {
        const replayUrl = message.payload
          ? `${chrome.runtime.getURL('replay.html')}?id=${message.payload}`
          : chrome.runtime.getURL('replay.html');
        chrome.tabs.create({ url: replayUrl });
      }
      return false;

    case 'EXPORT_SESSIONS':
      (async () => {
        const sessions = await getSessions();
        // 尝试从 lastSession 补充截图数据
        const result = await chrome.storage.local.get('lastSession');
        const last = result.lastSession as RecordingSession | undefined;
        const enriched = sessions.map((s) => {
          if (last && last.id === s.id) return last;
          return s;
        });
        sendResponse({ sessions: enriched });
      })();
      return true;

    case 'IMPORT_SESSIONS':
      (async () => {
        try {
          const imported = message.payload as RecordingSession[];
          if (!Array.isArray(imported) || imported.length === 0) {
            sendResponse({ success: false, error: '无效数据' });
            return;
          }
          const existing = await getSessions();
          // 按 id 去重：导入的覆盖已有的
          const map = new Map<string, RecordingSession>();
          existing.forEach((s) => map.set(s.id, s));
          imported.forEach((s) => map.set(s.id, s));
          const merged = Array.from(map.values());
          await chrome.storage.local.set({ sessions: merged });
          sendResponse({ success: true, count: imported.length });
        } catch (err) {
          sendResponse({ success: false, error: String(err) });
        }
      })();
      return true;
  }
});

// Tab 关闭时停止录制
chrome.tabs.onRemoved.addListener((tabId) => {
  openedFromRecordingTab.delete(tabId);
  if (currentSession && isRecording && tabId === recordingTabId) {
    stopRecording();
  }
});

function rememberOpenedTab(tabId: number, openerTabId: number) {
  openedFromRecordingTab.set(tabId, openerTabId);
}

// target=_blank / window.open 打开的新 tab：如果来自当前录制 tab，激活后切换录制焦点
chrome.tabs.onCreated.addListener((tab) => {
  if (!isRecording || recordingTabId === null || tab.id === undefined) return;
  if (tab.openerTabId !== recordingTabId) return;

  rememberOpenedTab(tab.id, tab.openerTabId);
  if (tab.active) {
    switchRecordingToTab(tab.id, 'new-tab', tab.openerTabId).catch((err) => {
      console.error('[ReplayDebug] Failed to switch recording tab:', err);
    });
  }
});

// 有些 noopener 场景 tabs.onCreated 拿不到 openerTabId，webNavigation 会给 sourceTabId
chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  if (!isRecording || recordingTabId === null) return;
  if (details.sourceTabId !== recordingTabId) return;

  rememberOpenedTab(details.tabId, details.sourceTabId);
  chrome.tabs.get(details.tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    if (!tab.active) return;
    switchRecordingToTab(details.tabId, 'new-tab', details.sourceTabId).catch((err) => {
      console.error('[ReplayDebug] Failed to switch recording tab:', err);
    });
  });
});

// 如果新 tab 是后台打开的，等用户切到这个由录制页打开的 tab 时再继续录制
chrome.tabs.onActivated.addListener((activeInfo) => {
  const openerTabId = openedFromRecordingTab.get(activeInfo.tabId);
  if (!isRecording || openerTabId === undefined) return;

  openedFromRecordingTab.delete(activeInfo.tabId);
  switchRecordingToTab(activeInfo.tabId, 'activated-new-tab', openerTabId).catch((err) => {
    console.error('[ReplayDebug] Failed to switch recording tab:', err);
  });
});

// 跨页面录制：Tab 导航时重新注入 Content Script
// 使用 async 监听器，支持从 storage 恢复状态
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;

  // 如果内存状态丢失，尝试从 storage 恢复
  if (!isRecording || !currentSession || recordingTabId === null) {
    const state = await chrome.storage.session.get(['isRecording', 'recordingTabId']);
    if (!state.isRecording || state.recordingTabId !== tabId) return;

    // 恢复状态：从元数据 + 增量事件分别读取
    const metaResult = await chrome.storage.local.get('activeSessionMeta');
    if (metaResult.activeSessionMeta) {
      currentSession = metaResult.activeSessionMeta as RecordingSession;
      const pendingKey = `session_events_pending_${currentSession.id}`;
      const eventsResult = await chrome.storage.local.get(pendingKey);
      currentSession.rrwebEvents = eventsResult[pendingKey] || [];
      lastPersistedEventCount = currentSession.rrwebEvents.length;
      isRecording = true;
      recordingTabId = state.recordingTabId as number;
      screenshotCount = currentSession.screenshots?.length || 0;
      startAutoSave();
      console.log('[ReplayDebug] Restored state in onUpdated. Events so far:', currentSession.rrwebEvents.length);
    } else {
      return;
    }
  }

  // 状态检查
  if (tabId !== recordingTabId || !isRecording || !currentSession) return;

  console.log('[ReplayDebug] Tab navigated during recording:', tab.url);
  recordNavigation(tab, 'page-load');

  // 重新注入 Content Script 并继续录制
  if (isInjectableUrl(tab.url)) {
    await injectAndStart(tabId);
  }
});
