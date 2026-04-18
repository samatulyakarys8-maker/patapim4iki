import { shouldCreateBackendSpeechSession, transcriptRouteForScreen } from './voice-mode.js';

const API_BASE = 'http://localhost:3030';
const previewCache = new Map();
const speechSessionCache = new Map();

function advisorStageLabel(stage = '') {
  if (stage === 'complaints') return 'Жалобы';
  if (stage === 'anamnesis') return 'Анамнез / динамика';
  if (stage === 'functional_impact') return 'Функциональное влияние';
  return '';
}

function isNavigationIntent(type = '') {
  return /^open_|^switch_|return_to_schedule|navigate|save_record/.test(type);
}

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

function normalizeExtensionErrorMessage(error) {
  const message = error?.message || String(error || '');
  if (/advisor_context_missing|patient_not_found/i.test(message)) {
    return 'Откройте карточку пациента или форму приема, чтобы советчик видел медицинский контекст.';
  }
  return message;
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

async function notifyInspectionPageUpdated(tabId, reason = 'advisor') {
  return askContent(tabId, { type: 'refresh-inspection-page-data', reason }).catch(() => null);
}

async function syncAdvisorQuestionOverlay(tabId, payload, screenContext) {
  const visible = Boolean(
    screenContext?.screen_id === 'inspection'
    && screenContext?.selected_appointment_id
    && payload?.interview_reasoning?.next_best_question
  );
  return askContent(tabId, {
    type: 'update-advisor-question-overlay',
    payload: {
      visible: visible || Boolean(payload?.interview_reasoning?.advisor_complete),
      mode: payload?.interview_reasoning?.advisor_complete ? 'completed' : 'question',
      question: visible ? payload.interview_reasoning.next_best_question : '',
      stageLabel: visible ? advisorStageLabel(payload?.interview_reasoning?.stage) : '',
      completionTitle: payload?.interview_reasoning?.completion_title || 'Сбор данных завершен',
      completionMessage: payload?.interview_reasoning?.completion_message || 'Черновик формы подготовлен. Проверьте и подтвердите заполнение.'
    }
  }).catch(() => null);
}

async function postJson(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || payload.details || `Backend request failed: ${response.status}`);
  }
  return payload;
}

async function getJson(path) {
  const response = await fetch(`${API_BASE}${path}`);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || payload.details || `Backend request failed: ${response.status}`);
  }
  return payload;
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

    if (message.type === 'get-patient-assets') {
      const screenContext = await getScreenContext(tab.id);
      const params = new URLSearchParams();
      if (message.patientId || screenContext.selected_patient_id) {
        params.set('patientId', message.patientId || screenContext.selected_patient_id);
      }
      if (message.appointmentId || screenContext.selected_appointment_id) {
        params.set('appointmentId', message.appointmentId || screenContext.selected_appointment_id);
      }
      const payload = await getJson(`/api/patient-assets?${params.toString()}`);
      sendResponse({ ok: true, screenContext, ...payload });
      return;
    }

    if (message.type === 'upload-patient-assets') {
      const screenContext = await getScreenContext(tab.id);
      const payload = await postJson('/api/patient-assets/upload', {
        patientId: message.patientId || screenContext.selected_patient_id,
        appointmentId: message.appointmentId || screenContext.selected_appointment_id,
        files: message.files || []
      });
      sendResponse({ ok: true, screenContext, ...payload });
      return;
    }

    if (message.type === 'get-patient-presets') {
      const screenContext = await getScreenContext(tab.id);
      const appointmentId = message.appointmentId || screenContext.selected_appointment_id;
      if (!appointmentId) {
        throw new Error('Откройте форму приема пациента, чтобы получить пресеты.');
      }
      const payload = await getJson(`/api/appointments/${appointmentId}/presets`);
      sendResponse({ ok: true, screenContext, ...payload });
      return;
    }

    if (message.type === 'apply-patient-preset') {
      const screenContext = await getScreenContext(tab.id);
      const appointmentId = message.appointmentId || screenContext.selected_appointment_id;
      if (!appointmentId) {
        throw new Error('Откройте форму приема пациента, чтобы применить пресет.');
      }
      const payload = await postJson(`/api/appointments/${appointmentId}/preset-preview`, {
        presetId: message.presetId
      });
      if (payload.preview) {
        await cacheAndHighlight(tab.id, payload.preview);
      }
      sendResponse({ ok: true, screenContext, ...payload });
      return;
    }

    if (message.type === 'preview-command') {
      const screenContext = await getScreenContext(tab.id);
      const preview = await postJson('/api/agent/preview', { command: message.command, screenContext });
      await cacheAndHighlight(tab.id, preview);
      sendResponse({ ok: true, screenContext, preview });
      return;
    }

    if (message.type === 'observe-agent') {
      const screenContext = await getScreenContext(tab.id);
      const observation = await postJson('/api/agent/observe', {
        command: message.command,
        transcriptDelta: message.transcriptDelta,
        screenContext
      });
      if (observation.preview) {
        await cacheAndHighlight(tab.id, observation.preview);
      }
      let execution = null;
      let refreshedContext = screenContext;
      if (message.autoExecute) {
        if (observation.actionPlan) {
          execution = await askContent(tab.id, {
            type: 'execute-action-plan',
            actionPlan: observation.actionPlan
          });
        } else if ((observation.preview?.domOperations || []).length) {
          execution = await askContent(tab.id, {
            type: 'apply-preview',
            domOperations: observation.preview.domOperations || []
          });
        }
        refreshedContext = await getScreenContext(tab.id).catch(() => screenContext);
      }
      sendResponse({ ok: true, screenContext: refreshedContext, observation: { ...observation, execution } });
      return;
    }

    if (message.type === 'voice-command') {
      const screenContext = await getScreenContext(tab.id);
      const observation = await postJson('/api/agent/observe', {
        command: message.transcript,
        transcriptDelta: message.transcript,
        screenContext
      });
      if (observation.preview) {
        await cacheAndHighlight(tab.id, observation.preview);
      }

      const commandResult = observation.commandResult || observation.preview?.commandResult || null;
      const actionPlan = observation.actionPlan || observation.preview?.actionPlan || null;
      let domExecution = null;
      let auditResult = 'not_executed';
      let refreshedContext = screenContext;

      if (!commandResult || commandResult.intent === 'unknown') {
        domExecution = {
          ok: false,
          verification: { ok: false, reason: 'intent_not_found' },
          failed: { reason: 'intent_not_found' }
        };
        auditResult = 'intent_not_found';
      } else if (commandResult.intent === 'generate_schedule') {
        if (!screenContext.selected_appointment_id) {
          domExecution = {
            ok: false,
            verification: { ok: false, reason: 'appointment_not_open' },
            failed: { reason: 'appointment_not_open' }
          };
          auditResult = 'appointment_not_open';
        } else {
          const draftPayload = await postJson('/api/procedure-schedule/preview', {
            appointmentId: screenContext.selected_appointment_id
          });
          domExecution = {
            ok: true,
            mode: 'backend-action',
            action: 'procedure_schedule_preview',
            draft: draftPayload.draft,
            verification: { ok: true, reason: 'procedure_schedule_preview_created' }
          };
          auditResult = 'executed';
        }
      } else if (commandResult.needsLlmFallback && !(actionPlan?.operations || []).length) {
        domExecution = {
          ok: false,
          verification: { ok: false, reason: commandResult.fallbackReason || 'llm_fallback_required' },
          failed: { reason: commandResult.fallbackReason || 'llm_fallback_required' }
        };
        auditResult = commandResult.fallbackReason || 'llm_fallback_required';
      } else if (commandResult.fallbackReason === 'patient_slot_not_found' && !(actionPlan?.operations || []).length) {
        domExecution = {
          ok: false,
          verification: { ok: false, reason: 'patient_slot_not_found' },
          failed: {
            reason: 'patient_slot_not_found',
            matchedPatient: commandResult.matchedPatient || null
          }
        };
        auditResult = 'patient_slot_not_found';
      } else if (actionPlan) {
        domExecution = await askContent(tab.id, {
          type: 'execute-action-plan',
          actionPlan
        });
        auditResult = domExecution.ok ? 'executed' : (domExecution.failed?.reason || domExecution.verification?.reason || 'execution_failed');
        refreshedContext = await getScreenContext(tab.id).catch(() => screenContext);
      } else if (observation.preview?.domOperations?.length) {
        domExecution = await askContent(tab.id, {
          type: 'apply-preview',
          domOperations: observation.preview.domOperations || []
        });
        auditResult = domExecution.ok ? 'executed' : 'execution_failed';
        refreshedContext = await getScreenContext(tab.id).catch(() => screenContext);
      } else {
        domExecution = {
          ok: false,
          verification: { ok: false, reason: commandResult.fallbackReason || 'llm_fallback_required' },
          failed: { reason: commandResult.fallbackReason || 'llm_fallback_required' }
        };
        auditResult = commandResult.fallbackReason || 'llm_fallback_required';
      }

      const debug = {
        rawTranscript: message.transcript,
        normalizedTranscript: commandResult?.debug?.normalization?.normalizedText || commandResult?.debug?.normalizedTranscript || null,
        sttProvider: message.sttProvider || null,
        sttConfidence: message.sttConfidence || null,
        speaker: message.speakerTag || null,
        deterministicCommandResult: observation.deterministicCommandResult || null,
        finalCommandResult: commandResult,
        patientQuery: commandResult?.patientQuery || null,
        patientCandidates: commandResult?.matchCandidates || [],
        llmFallbackInvoked: Boolean(commandResult?.debug?.llmFallbackInvoked),
        llmFallbackReason: commandResult?.debug?.llmFallbackReason || commandResult?.fallbackReason || null,
        finalActionPlan: actionPlan || null,
        blockReason: domExecution?.failed?.reason || domExecution?.verification?.reason || null,
        domExecution,
        verification: domExecution?.verification || null
      };

      const audit = await postJson('/api/audit', {
        actorType: 'extension',
        actionType: 'voice_command',
        screenId: screenContext.screen_id || 'unknown',
        entityRefs: {
          appointment_id: screenContext.selected_appointment_id || commandResult?.matchedPatient?.appointment_id || null,
          patient_id: screenContext.selected_patient_id || commandResult?.matchedPatient?.patient_id || null
        },
        payload: debug,
        result: auditResult
      }).catch((error) => ({ ok: false, error: error.message }));

      sendResponse({
        ok: Boolean(domExecution?.ok),
        screenContext: refreshedContext,
        observation,
        commandResult,
        actionPlan,
        domExecution,
        verification: domExecution?.verification || null,
        audit,
        debug: { ...debug, audit }
      });
      return;
    }

    if (message.type === 'apply-preview') {
      const screenContext = await getScreenContext(tab.id);
      if (!previewCache.has(tab.id) && !screenContext.selected_appointment_id) {
        throw new Error('Откройте прием пациента или сначала получите черновик, чтобы применить изменения.');
      }
      const preview = previewCache.get(tab.id) || await fetch(`${API_BASE}/api/drafts/${screenContext.selected_appointment_id}/apply-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }).then((response) => response.json()).then((payload) => payload.preview);
      if (!preview) throw new Error('Сначала получите черновик из транскрипта.');
      const result = await askContent(tab.id, { type: 'apply-preview', domOperations: preview.domOperations || [] });
      if (result.ok && screenContext.selected_appointment_id && (preview.patches || []).length) {
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
      const refreshedContext = await getScreenContext(tab.id).catch(() => null);
      sendResponse({ ok: true, result, preview, screenContext: refreshedContext || screenContext });
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
      if (shouldCreateBackendSpeechSession(screenContext.screen_id)) {
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
      const session = {
        session_id: `schedule-session-${Date.now()}`,
        appointment_id: null,
        status: 'listening',
        started_at: new Date().toISOString(),
        provider: 'browser-web-speech'
      };
      speechSessionCache.set(tab.id, session);
      sendResponse({ ok: true, screenContext, session });
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

    if (message.type === 'get-deepgram-config') {
      const config = await postJson('/api/speech/deepgram/config', {});
      sendResponse({ ok: true, config });
      return;
    }

    if (message.type === 'get-openai-stt-config') {
      const config = await postJson('/api/speech/openai/config', {});
      sendResponse({ ok: true, config });
      return;
    }

    if (message.type === 'openai-transcribe-audio') {
      const screenContext = await getScreenContext(tab.id);
      const payload = await postJson('/api/speech/openai/transcribe', {
        audioBase64: message.audioBase64,
        mimeType: message.mimeType,
        language: message.language || 'ru',
        screenContext
      });
      sendResponse({ ok: true, screenContext, ...payload });
      return;
    }

    if (message.type === 'stop-live-session') {
      const session = speechSessionCache.get(tab.id);
      if (!session) {
        throw new Error('Активная запись не найдена.');
      }
      if (!session.appointment_id) {
        speechSessionCache.delete(tab.id);
        sendResponse({ ok: true, session: { ...session, status: 'stopped', stopped_at: new Date().toISOString() }, draftState: null });
        return;
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
      const route = transcriptRouteForScreen(screenContext.screen_id);
      if (route === 'observe') {
        const observation = await postJson('/api/agent/observe', {
          command: message.text,
          transcriptDelta: message.text,
          screenContext
        });
        if (observation.preview) {
          await cacheAndHighlight(tab.id, observation.preview);
        }
        if (screenContext.screen_id === 'inspection' && screenContext.selected_appointment_id) {
          await notifyInspectionPageUpdated(tab.id, 'voice-observe');
        }
        sendResponse({
          ok: true,
          screenContext,
          transcript: {
            chunk: {
              text: message.text,
              speaker_tag: message.speakerTag,
              source: 'voice_command'
            },
            parser: { provider: 'observe', used_openrouter: false, error: null },
            draftPatches: observation.draft_patches || [],
            hints: observation.hints || []
          },
          preview: observation.preview
        });
        return;
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
      if (screenContext.screen_id === 'inspection' && screenContext.selected_appointment_id) {
        await notifyInspectionPageUpdated(tab.id, 'transcript-ingest');
      }
      sendResponse({ ok: true, screenContext, transcript: result, preview });
      return;
    }

    if (message.type === 'advisor-analyze') {
      const screenContext = await getScreenContext(tab.id);
      const normalizedScreenId = String(screenContext.screen_id || '').replace(/-/g, '_');
      const isInspectionContext = normalizedScreenId === 'inspection' && screenContext.selected_appointment_id;
      const isPatientCardContext = ['patient_card', 'patient', 'patient_profile'].includes(normalizedScreenId)
        && screenContext.selected_patient_id;
      if (!isInspectionContext && !isPatientCardContext) {
        throw new Error('Откройте карточку пациента или форму приема, чтобы советчик видел медицинский контекст.');
      }
      const payload = await postJson('/api/advisor/analyze', {
        appointmentId: screenContext.selected_appointment_id || null,
        question: message.question,
        screenContext
      });
      if (payload.preview) {
        previewCache.set(tab.id, payload.preview);
      }
      await syncAdvisorQuestionOverlay(tab.id, payload, screenContext);
      if (normalizedScreenId === 'inspection' && screenContext.selected_appointment_id) {
        await notifyInspectionPageUpdated(tab.id, 'advisor-analyze');
      }
      sendResponse({ ok: true, screenContext, ...payload });
      return;
    }

    if (message.type === 'procedure-schedule-preview') {
      const screenContext = await getScreenContext(tab.id);
      if (!screenContext.selected_appointment_id) {
        throw new Error('Откройте назначение пациента, чтобы сформировать расписание процедур.');
      }
      const payload = await postJson('/api/procedure-schedule/preview', {
        appointmentId: screenContext.selected_appointment_id
      });
      sendResponse({ ok: true, screenContext, ...payload });
      return;
    }

    if (message.type === 'procedure-schedule-accept') {
      const payload = await postJson('/api/procedure-schedule/accept', {
        draftId: message.draftId
      });
      sendResponse({ ok: true, ...payload });
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
    sendResponse({ ok: false, error: normalizeExtensionErrorMessage(error) });
  });
  return true;
});
