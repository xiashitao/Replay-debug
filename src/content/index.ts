import { record } from 'rrweb';
import type {
  UserAction,
  NetworkRequest,
  ConsoleLog,
  JSError,
  InjectedNetworkMessage,
} from '../types';

type ReplayDebugGlobal = typeof globalThis & {
  __replayDebugContentInstalled?: boolean;
};

const replayDebugGlobal = globalThis as ReplayDebugGlobal;

// 是否在顶层 frame（非 iframe）
const isTopFrame = window.self === window.top;

let stopRecording: (() => void) | null = null;
let isRecording = false;
let userActionListenersInstalled = false;
let injectedScriptNonce: string | null = null;

// rrweb 事件批量缓冲 — 减少 chrome.runtime.sendMessage 调用频率
let eventBuffer: unknown[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function sendRuntimeMessage(message: unknown): Promise<void> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, () => {
      if (chrome.runtime.lastError) {
        console.warn('[ReplayDebug] Failed to send message:', chrome.runtime.lastError.message);
      }
      resolve();
    });
  });
}

function bufferedSend(type: string, payload: unknown) {
  if (type === 'RRWEB_EVENT') {
    eventBuffer.push(payload);
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        if (eventBuffer.length > 0) {
          const events = eventBuffer;
          eventBuffer = [];
          void sendRuntimeMessage({ type: 'RRWEB_EVENTS_BATCH', payload: events });
        }
        flushTimer = null;
      }, 300);
    }
  } else {
    void sendRuntimeMessage({ type, payload });
  }
}

async function flushEventBuffer() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (eventBuffer.length > 0) {
    const events = eventBuffer;
    eventBuffer = [];
    await sendRuntimeMessage({ type: 'RRWEB_EVENTS_BATCH', payload: events });
  }
}

// 生成唯一 ID
function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function getInjectedScriptNonce(): string {
  if (!injectedScriptNonce) {
    injectedScriptNonce = crypto.randomUUID?.() || uid();
  }
  return injectedScriptNonce;
}

// 获取元素的可读选择器
function getSelector(el: Element): string {
  if (el.id) return `#${el.id}`;
  if (el.className && typeof el.className === 'string') {
    const classes = el.className.trim().split(/\s+/).slice(0, 2).join('.');
    return `${el.tagName.toLowerCase()}.${classes}`;
  }
  return el.tagName.toLowerCase();
}

// 获取元素的 XPath
function getXPath(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;
  while (current && current.nodeType === Node.ELEMENT_NODE) {
    let index = 1;
    let sibling = current.previousSibling;
    while (sibling) {
      if (sibling.nodeType === Node.ELEMENT_NODE && (sibling as Element).tagName === current.tagName) {
        index++;
      }
      sibling = sibling.previousSibling;
    }
    const tag = current.tagName.toLowerCase();
    parts.unshift(`${tag}[${index}]`);
    current = current.parentElement;
  }
  return '/' + parts.join('/');
}

function getElementContext(el: Element) {
  const input = el as HTMLInputElement;
  const anchor = el.closest('a') as HTMLAnchorElement | null;
  return {
    tagName: el.tagName.toLowerCase(),
    role: el.getAttribute('role') || undefined,
    ariaLabel: el.getAttribute('aria-label') || undefined,
    placeholder: input.placeholder || undefined,
    name: input.name || el.getAttribute('name') || undefined,
    inputType: input.type || undefined,
    href: anchor?.href,
    disabled: Boolean((el as HTMLButtonElement | HTMLInputElement).disabled),
    checked: typeof input.checked === 'boolean' ? input.checked : undefined,
  };
}

function getSafeInputValue(target: HTMLInputElement): { value: string; masked?: boolean } {
  const sensitiveTypes = new Set(['password', 'email', 'tel']);
  if (sensitiveTypes.has(target.type)) {
    return { value: target.value ? '[masked]' : '', masked: Boolean(target.value) };
  }
  return { value: target.value };
}

// 发送消息到 Background（rrweb 事件走批量缓冲）
function sendMessage(type: string, payload: unknown) {
  bufferedSend(type, payload);
}

// 监听来自页面注入脚本的消息
function handleInjectedMessage(event: MessageEvent) {
  if (!isRecording) return;
  if (event.source !== window) return;

  const data = event.data;
  if (!data || typeof data.type !== 'string') return;
  if (data.__replayDebugNonce !== injectedScriptNonce) return;

  if (data.type === '__record_fetch' || data.type === '__record_xhr') {
    const networkReq: NetworkRequest = {
      id: uid(),
      timestamp: Date.now(),
      method: data.method || 'GET',
      url: data.url,
      status: data.status,
      responseBody: data.body,
      requestBody: data.requestBody,
      requestHeaders: data.requestHeaders,
      responseHeaders: data.responseHeaders,
      statusText: data.statusText,
      contentType: data.contentType,
      requestSize: data.requestSize,
      responseSize: data.responseSize,
      truncated: data.truncated,
      duration: data.duration || 0,
      type: data.type === '__record_fetch' ? 'fetch' : 'xhr',
      error: data.error,
    };
    sendMessage('NETWORK_REQUEST', networkReq);
  }

  if (data.type === '__record_console') {
    const log: ConsoleLog = {
      timestamp: data.timestamp,
      level: data.level,
      args: data.args,
      url: data.url,
      stack: data.stack,
    };
    sendMessage('CONSOLE_LOG', log);
  }

  if (data.type === '__record_error') {
    const error: JSError = {
      timestamp: data.timestamp,
      type: data.errorType,
      message: data.message,
      filename: data.filename,
      lineno: data.lineno,
      colno: data.colno,
      stack: data.stack,
      tagName: data.tagName,
      sourceUrl: data.sourceUrl,
    };
    sendMessage('JS_ERROR', error);
  }

  if (data.type === '__record_route') {
    sendMessage('ROUTE_CHANGE', {
      source: data.source,
      url: data.url,
      title: data.title,
      timestamp: data.timestamp,
    });
  }
}

// 监听用户 DOM 交互
function listenUserActions() {
  if (userActionListenersInstalled) return;
  userActionListenersInstalled = true;

  // 点击
  document.addEventListener('click', (e) => {
    if (!isRecording) return;
    const target = e.target as Element;
    if (!target) return;

    const action: UserAction = {
      type: 'click',
      timestamp: Date.now(),
      selector: getSelector(target),
      xpath: getXPath(target),
      text: target.textContent?.slice(0, 100) || '',
      clientX: e.clientX,
      clientY: e.clientY,
      pageX: e.pageX,
      pageY: e.pageY,
      ...getElementContext(target),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      url: location.href,
    };
    sendMessage('USER_ACTION', action);
  }, true);

  // 输入
  document.addEventListener('input', (e) => {
    if (!isRecording) return;
    const target = e.target as HTMLInputElement;
    if (!target) return;
    const safeValue = getSafeInputValue(target);

    const action: UserAction = {
      type: 'input',
      timestamp: Date.now(),
      selector: getSelector(target),
      xpath: getXPath(target),
      text: '',
      value: safeValue.value,
      masked: safeValue.masked,
      ...getElementContext(target),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      url: location.href,
    };
    sendMessage('USER_ACTION', action);
  }, true);

  // 滚动（节流）
  let scrollTimer: ReturnType<typeof setTimeout> | null = null;
  document.addEventListener('scroll', () => {
    if (!isRecording) return;
    if (scrollTimer) return;
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      const action: UserAction = {
        type: 'scroll',
        timestamp: Date.now(),
        selector: 'window',
        xpath: '',
        text: '',
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        url: location.href,
      };
      sendMessage('USER_ACTION', action);
    }, 200);
  }, true);

  // 键盘
  document.addEventListener('keydown', (e) => {
    if (!isRecording) return;
    // 只记录特殊按键（Enter、Tab、Escape 等）
    if (!['Enter', 'Tab', 'Escape', 'Backspace', 'Delete'].includes(e.key)) return;

    const target = e.target as Element;
    const action: UserAction = {
      type: 'keypress',
      timestamp: Date.now(),
      selector: target ? getSelector(target) : '',
      xpath: target ? getXPath(target) : '',
      text: '',
      value: e.key,
      ...(target ? getElementContext(target) : {}),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      url: location.href,
    };
    sendMessage('USER_ACTION', action);
  }, true);
}

// 注入网络拦截脚本到页面主世界
function injectScripts(nonce: string) {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject.js');
  script.dataset.replayDebugNonce = nonce;
  script.onload = () => script.remove();
  script.onerror = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}

// 开始录制
function startRecording() {
  if (isRecording) return;
  isRecording = true;
  console.log('[ReplayDebug] Content script: startRecording on', location.href, 'isTopFrame:', isTopFrame);

  if (isTopFrame) {
    // 主 frame：注入网络/控制台拦截脚本，启动带跨域 iframe 支持的完整录制
    injectScripts(getInjectedScriptNonce());

    stopRecording = record({
      emit(event) {
        sendMessage('RRWEB_EVENT', event);
      },
      recordCanvas: true,
      recordCrossOriginIframes: true,
    });

    listenUserActions();
  } else {
    // 跨域子 iframe：将 rrweb 事件 postMessage 给父 frame，
    // 父 frame 的 rrweb recorder（recordCrossOriginIframes: true）会自动收集
    stopRecording = record({
      emit(event) {
        try {
          window.parent.postMessage({ type: 'rrweb', event }, '*');
        } catch {
          // 父 frame 已关闭或不可访问
        }
      },
    });
  }
}

// 停止录制：先停 rrweb，再 flush，确保最后一批事件被发送后才响应
async function stop() {
  isRecording = false;
  if (stopRecording) {
    stopRecording();
    stopRecording = null;
  }
  if (isTopFrame) {
    await flushEventBuffer();
    // 额外等待一个宏任务周期，确保 sendRuntimeMessage 的异步回调已入队
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

// 监听来自 Background 的消息
function handleRuntimeMessage(
  message: { type?: string },
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) {
  if (message.type === 'START_RECORDING') {
    startRecording();
    sendResponse({ success: true });
  } else if (message.type === 'STOP_RECORDING') {
    stop().then(() => {
      sendResponse({ success: true });
    });
    return true;
  } else if (message.type === 'RECORDING_STATUS') {
    sendResponse({ isRecording });
  }
}

if (!replayDebugGlobal.__replayDebugContentInstalled) {
  replayDebugGlobal.__replayDebugContentInstalled = true;
  window.addEventListener('message', handleInjectedMessage);
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
}
