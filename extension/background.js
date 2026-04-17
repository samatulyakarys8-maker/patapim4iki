const API_BASE = 'http://localhost:3030';
const previewCache = new Map();
const speechSessionCache = new Map();

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function askContent(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

function isSandboxUrl(url) {
  return typeof url === 'string' && (url.startsWith('http://localhost:3030') || url.startsWith('http://127.0.0.1:3030'));
}

async function ensureSandboxTab(tab) {
  if (!tab?.id) {
    throw new Error('Активная вкладка не найдена.');
  }
  if (!isSandboxUrl(tab.url)) {
    throw new Error('Откройте вкладку http://localhost:3030 и запускайте extension поверх песочницы Damumed.');
  }
}

async function ensureContentScript(tabId) {
  try {
    await askContent(tabId, { type: 'ping' });
    return;
  } catch (error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
    await askContent(tabId, { type: 'ping' });
  }
}

async function getScreenContext(tabId) {
  await ensureContentScript(tabId);
  return askContent(tabId, { type: 'get-screen-context' });
}

async function cacheAndHighlight(tabId, preview) {
  previewCache.set(tabId, preview);
  await askContent(tabId, { type: 'highlight-preview', domOperations: preview.domOperations || [] });
}

chrome.runtime.onInstalled.addListener(async () => {
  if (chrome.sidePanel?.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const tab = await getActiveTab();
    await ensureSandboxTab(tab);

    if (message.type === 'refresh-context') {
      const screenContext = await getScreenContext(tab.id);
      sendResponse({ ok: true, screenContext });
      return;
    }

    if (message.type === 'preview-command') {
      const screenContext = await getScreenContext(tab.id);
      const preview = await fetch(`${API_BASE}/api/agent/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: message.command, screenContext })
      }).then((response) => response.json());
      await cacheAndHighlight(tab.id, preview);
      sendResponse({ ok: true, screenContext, preview });
      return;
    }

    if (message.type === 'apply-preview') {
      const screenContext = await getScreenContext(tab.id);
      const preview = previewCache.get(tab.id) || await fetch(`${API_BASE}/api/drafts/${screenContext.selected_appointment_id}/apply-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }).then((response) => response.json()).then((payload) => payload.preview);
      if (!preview) throw new Error('Сначала получите черновик из транскрипта.');
      const result = await askContent(tab.id, { type: 'apply-preview', domOperations: preview.domOperations || [] });
      if (result.ok) {
        await fetch(`${API_BASE}/api/drafts/${screenContext.selected_appointment_id}/mark-applied`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ patchIds: (preview.patches || []).map((patch) => patch.patch_id) })
        }).then((response) => response.json()).catch(() => null);
      }
      await fetch(`${API_BASE}/api/audit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actorType: 'extension',
          actionType: 'apply_preview',
          screenId: preview.intent?.screen_id || 'unknown',
          entityRefs: { appointment_id: preview.intent?.target_entity || null },
          payload: preview,
          result: result.ok ? 'applied' : 'apply_failed'
        })
      });
      sendResponse({ ok: true, result });
      return;
    }

    if (message.type === 'get-draft-state') {
      const screenContext = await getScreenContext(tab.id);
      if (screenContext.screen_id !== 'inspection') {
        throw new Error('Перейдите в форму назначения, чтобы получить черновик.');
      }
      const payload = await fetch(`${API_BASE}/api/drafts/${screenContext.selected_appointment_id}`).then((response) => response.json());
      previewCache.set(tab.id, payload.preview);
      sendResponse({ ok: true, screenContext, ...payload });
      return;
    }

    if (message.type === 'start-live-session') {
      const screenContext = await getScreenContext(tab.id);
      if (screenContext.screen_id !== 'inspection') {
        throw new Error('Запись доступна только на экране назначения.');
      }
      const payload = await fetch(`${API_BASE}/api/speech/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appointmentId: screenContext.selected_appointment_id,
          provider: 'browser-web-speech'
        })
      }).then((response) => response.json());
      speechSessionCache.set(tab.id, payload.session);
      sendResponse({ ok: true, screenContext, session: payload.session });
      return;
    }

    if (message.type === 'get-realtime-token') {
      const tokenPayload = await fetch(`${API_BASE}/api/speech/elevenlabs/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }).then(async (response) => {
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || 'Не удалось получить realtime token.');
        }
        return payload;
      });
      sendResponse({ ok: true, token: tokenPayload });
      return;
    }

    if (message.type === 'stop-live-session') {
      const session = speechSessionCache.get(tab.id);
      if (!session) {
        throw new Error('Активная запись не найдена.');
      }
      const payload = await fetch(`${API_BASE}/api/speech/session/${session.session_id}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }).then((response) => response.json());
      speechSessionCache.delete(tab.id);
      if (payload.draftState?.last_preview) {
        previewCache.set(tab.id, payload.draftState.last_preview);
      }
      sendResponse({ ok: true, session: payload.session, draftState: payload.draftState });
      return;
    }

    if (message.type === 'ingest-transcript') {
      const screenContext = await getScreenContext(tab.id);
      if (screenContext.screen_id !== 'inspection') {
        throw new Error('Перейдите в форму назначения, затем отправляйте транскрипт.');
      }
      const activeSession = speechSessionCache.get(tab.id);
      const result = await fetch(`${API_BASE}/api/transcripts/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appointmentId: screenContext.selected_appointment_id,
          sessionId: activeSession?.session_id,
          text: message.text,
          speakerTag: message.speakerTag
        })
      }).then((response) => response.json());
      const preview = {
        intent: {
          type: 'transcript_draft',
          screen_id: 'inspection',
          target_entity: screenContext.selected_appointment_id
        },
        patches: result.draftPatches || [],
        domOperations: result.domOperations || [],
        explanation: result.draftPatches?.length
          ? 'Черновик построен из транскрипта. Можно применить его в форму.'
          : 'Транскрипт сохранен, но явных полей для заполнения не найдено.',
        hints: result.hints || []
      };
      await cacheAndHighlight(tab.id, preview);
      sendResponse({ ok: true, screenContext, transcript: result, preview });
      return;
    }

    if (message.type === 'save-close-inspection') {
      const screenContext = await getScreenContext(tab.id);
      if (screenContext.screen_id !== 'inspection') {
        throw new Error('Сохранение доступно только на экране назначения.');
      }
      const result = await askContent(tab.id, {
        type: 'apply-preview',
        domOperations: [{ type: 'click', selector: '#btnSaveAndCloseInspectionResult' }]
      });
      await fetch(`${API_BASE}/api/audit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actorType: 'extension',
          actionType: 'save_close_inspection',
          screenId: 'inspection',
          entityRefs: { appointment_id: screenContext.selected_appointment_id || null },
          payload: {},
          result: result.ok ? 'saved' : 'save_failed'
        })
      });
      sendResponse({ ok: true, screenContext, result });
      return;
    }

    if (message.type === 'save-inspection') {
      const screenContext = await getScreenContext(tab.id);
      if (screenContext.screen_id !== 'inspection') {
        throw new Error('Сохранение доступно только на экране назначения.');
      }
      const result = await askContent(tab.id, {
        type: 'apply-preview',
        domOperations: [{ type: 'click', selector: '#btnSaveInspectionResult' }]
      });
      await fetch(`${API_BASE}/api/audit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actorType: 'extension',
          actionType: 'save_inspection',
          screenId: 'inspection',
          entityRefs: { appointment_id: screenContext.selected_appointment_id || null },
          payload: {},
          result: result.ok ? 'saved' : 'save_failed'
        })
      });
      sendResponse({ ok: true, screenContext, result });
      return;
    }

    throw new Error(`Unsupported message type: ${message.type}`);
  })().then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: error.message });
  });
  return true;
});
