import { agentGreeting } from './voice-mode.js';

const screenContextEl = document.querySelector('#screenContext');
const transcriptOutputEl = document.querySelector('#transcriptOutput');
const draftOutputEl = document.querySelector('#draftOutput');
const actionOutputEl = document.querySelector('#actionOutput');
const intentOutputEl = document.querySelector('#intentOutput');
const domProofOutputEl = document.querySelector('#domProofOutput');
const hintsOutputEl = document.querySelector('#hintsOutput');
const speakerOutputEl = document.querySelector('#speakerOutput');
const transcriptInputEl = document.querySelector('#transcriptInput');
const commandInputEl = document.querySelector('#commandInput');
const recordingStateEl = document.querySelector('#recordingState');
const globalStatusEl = document.querySelector('#globalStatus');
const startRecordingEl = document.querySelector('#startRecording');
const stopRecordingEl = document.querySelector('#stopRecording');
const procedureAcceptEl = document.querySelector('#procedureAccept');
const autopilotModeEl = document.querySelector('#autopilotMode');
const autoApplyDraftEl = document.querySelector('#autoApplyDraft');
const quietModeEl = document.querySelector('#quietMode');
const agentSpeechEnabledEl = document.querySelector('#agentSpeechEnabled');

const state = {
  recognition: null,
  isRecording: false,
  currentSession: null,
  mediaStream: null,
  audioContext: null,
  sourceNode: null,
  processorNode: null,
  realtimeSocket: null,
  activeProvider: null,
  currentProcedureDraft: null,
  patapimMode: false,
  speakerRoleMap: {},
  lastSpeakerId: null,
  agentWorkMode: false,
  isAgentSpeaking: false,
  ignoreTranscriptUntil: 0,
  lastAgentSpeech: '',
  lastProcessedVoiceCommandKey: '',
  lastProcessedVoiceCommandAt: 0
};

async function send(message) {
  if (!globalThis.chrome?.runtime?.sendMessage) {
    throw new Error('Side panel открыт не как Chrome Extension. Откройте его через иконку расширения на вкладке http://localhost:3030.');
  }
  return chrome.runtime.sendMessage(message);
}

function renderResult(element, result) {
  if (!element) return;
  element.textContent = JSON.stringify(result, null, 2);
}

function status(message, quietMessage = 'Готово.') {
  const text = (quietModeEl ? quietModeEl.checked : true) ? quietMessage : message;
  globalStatusEl.textContent = text;
}

function pickRussianVoice() {
  const voices = speechSynthesis.getVoices?.() || [];
  return voices.find((voice) => /ru/i.test(voice.lang))
    || voices.find((voice) => /russian|рус/i.test(voice.name))
    || null;
}

function spokenTextLooksLikeAgentEcho(text) {
  const normalizedText = normalizeSpeech(text);
  const normalizedSpeech = normalizeSpeech(state.lastAgentSpeech);
  if (!normalizedText || !normalizedSpeech) return false;
  return normalizedSpeech.includes(normalizedText) || normalizedText.includes(normalizedSpeech.slice(0, 45));
}

function shouldIgnoreAgentEcho(text) {
  return Date.now() < state.ignoreTranscriptUntil || state.isAgentSpeaking || spokenTextLooksLikeAgentEcho(text);
}

function speakAgent(text, { force = false } = {}) {
  const speechEnabled = agentSpeechEnabledEl ? agentSpeechEnabledEl.checked : true;
  if (!force && !speechEnabled) return Promise.resolve();
  if (!globalThis.speechSynthesis) return Promise.resolve();
  state.lastAgentSpeech = text;
  state.isAgentSpeaking = true;
  state.ignoreTranscriptUntil = Date.now() + 1200;
  speechSynthesis.cancel();
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ru-RU';
    utterance.rate = 1.05;
    utterance.pitch = 1;
    utterance.voice = pickRussianVoice();
    utterance.onend = () => {
      state.isAgentSpeaking = false;
      state.ignoreTranscriptUntil = Date.now() + 900;
      resolve();
    };
    utterance.onerror = () => {
      state.isAgentSpeaking = false;
      state.ignoreTranscriptUntil = Date.now() + 500;
      resolve();
    };
    speechSynthesis.speak(utterance);
  });
}

function resetPatapimMode() {
  state.patapimMode = false;
  state.speakerRoleMap = {};
  state.lastSpeakerId = null;
  renderSpeakers();
}

function renderHints(hints = []) {
  renderResult(hintsOutputEl, hints.map((hint) => ({
    message: hint.message,
    intent: hint.intent_type,
    severity: hint.severity,
    provenance: hint.provenance
  })));
}

function renderDomProof(previewOrResult) {
  const proof = previewOrResult?.dom_proof
    || previewOrResult?.preview?.dom_proof
    || previewOrResult?.result?.results
    || previewOrResult?.results
    || [];
  renderResult(domProofOutputEl, proof);
}

function looksLikeNavigationCommand(text) {
  return /открой|перейди|вернись|расписани|график|эпикриз|выписк|диагноз|дневник|файл|медицинские записи|мед записи|медкарта|первичный прием|первичный осмотр|сохрани|заверши|отметь/i.test(text);
}

function shouldProcessRealtimeText(text, isFinal) {
  const normalized = normalizeSpeech(text);
  if (!normalized) return false;
  const commandLike = looksLikeNavigationCommand(normalized)
    || looksLikeDirectApplyCommand(normalized)
    || looksLikeProcedureCommand(normalized)
    || looksLikeProcedureConfirmation(normalized);
  if (!isFinal && !commandLike) return false;
  const now = Date.now();
  if (normalized === state.lastProcessedVoiceCommandKey && now - state.lastProcessedVoiceCommandAt < 1800) return false;
  state.lastProcessedVoiceCommandKey = normalized;
  state.lastProcessedVoiceCommandAt = now;
  return true;
}

function renderSpeakers() {
  renderResult(speakerOutputEl, {
    agentWorkMode: state.agentWorkMode,
    patapimMode: state.patapimMode,
    lastSpeakerId: state.lastSpeakerId,
    speakers: state.speakerRoleMap
  });
}

function normalizeSpeech(text) {
  return String(text || '').toLowerCase().replace(/ё/g, 'е').trim();
}

function inferSpeakerRoleFromText(text) {
  const normalized = normalizeSpeech(text);
  if (/режим доктора патапим|режим доктора патапима|доктор патапим/.test(normalized)) return 'doctor';
  if (/я пациент|я пациентка|я больной|я больная|у меня|мне больно|болит|я устал|я устала/.test(normalized)) return 'patient';
  if (/открой|перейди|сохрани|назначаю|рекомендую|заключение|осмотр|продолжить/.test(normalized)) return 'doctor';
  return 'unknown';
}

function speakerIdFromDeepgram(payload) {
  const words = payload?.channel?.alternatives?.[0]?.words || [];
  const wordWithSpeaker = words.find((word) => word.speaker !== undefined && word.speaker !== null);
  return wordWithSpeaker ? String(wordWithSpeaker.speaker) : null;
}

function resolvePatapimSpeaker(text, speakerId = null) {
  const normalized = normalizeSpeech(text);
  const key = speakerId ?? 'single-speaker';
  state.lastSpeakerId = key;

  if (/режим доктора патапим|режим доктора патапима|доктор патапим/.test(normalized)) {
    state.patapimMode = true;
    state.speakerRoleMap[key] = 'doctor';
    for (const existingSpeakerId of Object.keys(state.speakerRoleMap)) {
      if (existingSpeakerId !== key && state.speakerRoleMap[existingSpeakerId] === 'unknown') {
        state.speakerRoleMap[existingSpeakerId] = 'patient';
      }
    }
    renderSpeakers();
    status('Режим доктора Патапима включен. Теперь пациент может сказать: “я пациент”.', 'Режим Патапима включен.');
    speakAgent('Режим доктора Патапима включен. Пациент, скажите: я пациент, и расскажите, что вас беспокоит.');
    return { role: 'doctor', controlOnly: true };
  }

  if (!state.patapimMode) {
    const role = inferSpeakerRoleFromText(text);
    if (role !== 'unknown') state.speakerRoleMap[key] = role;
    renderSpeakers();
    return { role, controlOnly: false };
  }

  if (/я пациент|я пациентка|я больной|я больная/.test(normalized)) {
    state.speakerRoleMap[key] = 'patient';
    for (const existingSpeakerId of Object.keys(state.speakerRoleMap)) {
      if (existingSpeakerId !== key && state.speakerRoleMap[existingSpeakerId] === 'unknown') {
        state.speakerRoleMap[existingSpeakerId] = 'doctor';
      }
    }
    const doctorSpeaker = Object.keys(state.speakerRoleMap).find((id) => id !== key && state.speakerRoleMap[id] === 'doctor');
    if (!doctorSpeaker) {
      const otherId = Object.keys(state.speakerRoleMap).find((id) => id !== key);
      if (otherId) state.speakerRoleMap[otherId] = 'doctor';
    }
    renderSpeakers();
    status('Пациент распознан. Голоса разделяются на врача и пациента.', 'Пациент распознан.');
    speakAgent('Пациент распознан. Расскажите, что вас беспокоит.');
    return { role: 'patient', controlOnly: false };
  }

  if (!state.speakerRoleMap[key]) {
    const inferredRole = inferSpeakerRoleFromText(text);
    state.speakerRoleMap[key] = inferredRole;
    if (inferredRole === 'patient') {
      const doctorSpeaker = Object.keys(state.speakerRoleMap).find((id) => id !== key && state.speakerRoleMap[id] === 'doctor');
      if (!doctorSpeaker) {
        const otherId = Object.keys(state.speakerRoleMap).find((id) => id !== key);
        if (otherId) state.speakerRoleMap[otherId] = 'doctor';
      }
    }
  }

  const mappedRole = state.speakerRoleMap[key] || 'unknown';
  renderSpeakers();
  return { role: mappedRole, controlOnly: false };
}

function setRecordingUi(isRecording, message) {
  state.isRecording = isRecording;
  startRecordingEl.disabled = isRecording;
  stopRecordingEl.disabled = !isRecording;
  recordingStateEl.textContent = message;
  globalStatusEl.textContent = message;
}

function showError(error) {
  const message = error?.message || String(error);
  globalStatusEl.textContent = message;
  renderResult(actionOutputEl, { ok: false, error: message });
}

function toBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function downsampleTo16Khz(float32Samples, inputSampleRate) {
  const outputSampleRate = 16000;
  if (inputSampleRate === outputSampleRate) return float32Samples;
  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.round(float32Samples.length / ratio);
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(Math.floor((index + 1) * ratio), float32Samples.length);
    let sum = 0;
    let count = 0;
    for (let inputIndex = start; inputIndex < end; inputIndex += 1) {
      sum += float32Samples[inputIndex];
      count += 1;
    }
    output[index] = count ? sum / count : 0;
  }
  return output;
}

function floatToPcm16(float32Samples) {
  const pcm = new Int16Array(float32Samples.length);
  for (let index = 0; index < float32Samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, float32Samples[index]));
    pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return new Uint8Array(pcm.buffer);
}

async function startPcmAudioPump(sendPcmBytes) {
  state.audioContext = new AudioContext();
  state.sourceNode = state.audioContext.createMediaStreamSource(state.mediaStream);

  if (!state.audioContext.audioWorklet || !globalThis.AudioWorkletNode) {
    throw new Error('AudioWorklet недоступен в этом контексте Chrome. Переключаюсь на browser speech fallback.');
  }

  const workletUrl = chrome.runtime.getURL('audio-worklet.js');
  await state.audioContext.audioWorklet.addModule(workletUrl);
  state.processorNode = new AudioWorkletNode(state.audioContext, 'pcm16-worklet-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 0
  });
  state.processorNode.port.onmessage = (event) => {
    if (!state.isRecording) return;
    sendPcmBytes(event.data);
  };
  state.sourceNode.connect(state.processorNode);
}

function tokenValue(tokenPayload) {
  return tokenPayload?.token || tokenPayload?.single_use_token || tokenPayload?.access_token || tokenPayload?.jwt || tokenPayload?.key;
}

async function refreshContext() {
  try {
    globalStatusEl.textContent = 'Определяю текущий экран.';
    const result = await send({ type: 'refresh-context' });
    renderResult(screenContextEl, result.ok ? (result.screenContext || result) : result);
    renderHints(result.screenContext?.hints || []);
    globalStatusEl.textContent = result.ok ? `Экран: ${result.screenContext?.screen_id || 'unknown'}` : (result.error || 'Не удалось определить экран.');
    return result;
  } catch (error) {
    showError(error);
    return { ok: false, error: error.message };
  }
}

async function loadDraft() {
  const result = await send({ type: 'get-draft-state' });
  renderResult(draftOutputEl, result.ok ? {
    draftStatus: result.draftState?.draft_status,
    transcriptChunks: result.draftState?.transcript_chunks || [],
    draftPatches: result.draftState?.draft_patches || [],
    hints: result.hints || []
  } : result);
  if (result.ok) renderHints(result.hints || []);
  if (result.ok) {
    renderResult(screenContextEl, result.screenContext || {});
  }
}

async function observeCommand(commandOverride = null, metadata = {}) {
  const command = (commandOverride ?? commandInputEl?.value ?? '').trim();
  if (!command) {
    renderResult(intentOutputEl, { ok: false, error: 'Введите голосовую команду или выберите пример.' });
    return;
  }
  status('Агент понимает команду и ищет DOM-цель.', 'Команда принята.');
  const result = await send({
    type: 'voice-command',
    transcript: command,
    sttConfidence: metadata.sttConfidence ?? null,
    speakerTag: metadata.speakerTag ?? null,
    autoExecute: autopilotModeEl ? Boolean(autopilotModeEl.checked) : true
  });
  if (!result.ok) {
    renderResult(intentOutputEl, result.debug || result);
    renderResult(actionOutputEl, result.domExecution || result);
    globalStatusEl.textContent = result.error || 'Не удалось обработать команду.';
    return;
  }
  const preview = result.observation?.preview;
  renderResult(intentOutputEl, {
    command,
    commandResult: result.commandResult,
    agentState: result.observation?.agent_state,
    intents: result.observation?.intents || [],
    explanation: preview?.explanation,
    actionPlan: result.actionPlan,
    domOperations: result.observation?.dom_operations || [],
    debug: result.debug
  });
  renderDomProof(result.domExecution || result.observation);
  renderHints(result.observation?.hints || []);
  renderResult(screenContextEl, result.screenContext || {});
  if (result.domExecution || result.observation?.execution) {
    renderResult(actionOutputEl, result.domExecution || result.observation.execution);
  }
  status(preview?.explanation || 'Команда распознана.', 'Готово.');
  return result;
}

async function applyPreview() {
  const result = await send({ type: 'apply-preview' });
  renderResult(actionOutputEl, result.ok ? (result.result || result) : result);
  renderDomProof(result);
  if (result.ok) {
    await loadDraft();
    if (result.screenContext) renderResult(screenContextEl, result.screenContext);
  }
  return result;
}

async function ingestTranscript(textOverride = null, speakerOverride = null, speakerIdOverride = null, metadata = {}) {
  const text = (textOverride ?? transcriptInputEl?.value ?? '').trim();
  const speakerTag = speakerOverride || document.querySelector('#speakerTag')?.value || 'auto';
  if (!text) {
    renderResult(transcriptOutputEl, { ok: false, error: 'Добавьте текст транскрипта или запустите запись.' });
    return;
  }
  const speakerContext = speakerOverride
    ? { role: speakerOverride, controlOnly: false }
    : resolvePatapimSpeaker(text, speakerIdOverride);
  const resolvedSpeakerTag = speakerOverride || speakerContext.role || speakerTag;
  if (speakerContext.controlOnly) return;

  if (resolvedSpeakerTag !== 'doctor' && (looksLikeNavigationCommand(text) || looksLikeDirectApplyCommand(text) || looksLikeProcedureCommand(text))) {
    status('Команда проигнорирована: ее сказал не врач.', 'Команда не от врача.');
    renderResult(transcriptOutputEl, { ignored: true, reason: 'non_doctor_command', speakerTag: resolvedSpeakerTag, text });
    return;
  }

  if (looksLikeDirectApplyCommand(text)) {
    await applyPreview();
    status('Применяю текущий черновик в форму.', 'Форма обновлена.');
    return;
  }
  if (looksLikeProcedureCommand(text)) {
    await previewProcedureSchedule();
    return;
  }
  if (looksLikeProcedureConfirmation(text)) {
    await acceptProcedureSchedule();
    return;
  }
  if (looksLikeNavigationCommand(text)) {
    const observed = await observeCommand(text, { ...metadata, speakerTag: resolvedSpeakerTag });
    if ((autopilotModeEl ? autopilotModeEl.checked : true) && observed?.ok) {
      renderResult(actionOutputEl, {
        mode: 'voice-autopilot',
        command: text,
        applied: observed.domExecution || observed.observation?.execution || null,
        debug: observed.debug || null
      });
      status('Голосовая команда выполнена через DOM.', 'Выполнено.');
    }
    return;
  }
  if (resolvedSpeakerTag !== 'patient') {
    const commandAttempt = await observeCommand(text, { ...metadata, speakerTag: resolvedSpeakerTag });
    const intent = commandAttempt?.commandResult?.intent || commandAttempt?.debug?.parsedCommand?.intent;
    const failureReason = commandAttempt?.verification?.reason || commandAttempt?.domExecution?.failed?.reason;
    if (commandAttempt?.ok || (intent && intent !== 'unknown' && failureReason !== 'intent_not_found')) {
      renderResult(actionOutputEl, {
        mode: 'llm-command-attempt',
        command: text,
        result: commandAttempt?.domExecution || commandAttempt,
        debug: commandAttempt?.debug || null
      });
      status('Голосовая команда обработана.', commandAttempt?.ok ? 'Выполнено.' : 'Команда обработана.');
      return;
    }
  }
  const result = await send({ type: 'ingest-transcript', text, speakerTag: resolvedSpeakerTag });
  renderResult(transcriptOutputEl, result.ok ? {
    chunk: result.transcript?.chunk,
    parser: result.transcript?.parser,
      draftPatches: result.transcript?.draftPatches || [],
      hints: result.transcript?.hints || [],
      speakerTag: resolvedSpeakerTag
  } : result);
  if (result.ok) {
    renderResult(draftOutputEl, {
      draftStatus: result.transcript?.draftState?.draft_status,
      transcriptChunks: result.transcript?.draftState?.transcript_chunks || [],
      draftPatches: result.transcript?.draftState?.draft_patches || []
    });
    renderDomProof(result.preview);
    renderHints(result.transcript?.hints || []);
    renderResult(screenContextEl, result.screenContext || {});
    if ((autoApplyDraftEl ? autoApplyDraftEl.checked : true) && (result.preview?.domOperations || []).length) {
      const applied = await applyPreview();
      renderResult(actionOutputEl, {
        mode: 'voice-auto-fill',
        transcript: text,
        applied: applied?.result || applied
      });
      status('Медицинская фраза внесена в форму через черновик.', 'Черновик применен.');
    } else {
      status('Медицинская фраза добавлена в черновик.', 'Черновик обновлен.');
    }
  }
}

function looksLikeDirectApplyCommand(text) {
  return /примен|заполни форму|внеси в форму|перенеси черновик/i.test(text);
}

function looksLikeProcedureCommand(text) {
  return /сформир.*расписани|созд.*расписани|состав.*план процедур|график занятий|расписание процедур/i.test(text);
}

function looksLikeProcedureConfirmation(text) {
  return state.currentProcedureDraft && /^(да|подтверждаю|можно|принять|принимаю|окей|хорошо)\b/i.test(text.trim());
}

async function saveInspection() {
  const result = await send({ type: 'save-inspection' });
  renderResult(actionOutputEl, result.ok ? (result.result || result) : result);
  renderDomProof(result);
  await refreshContext();
}

async function saveCloseInspection() {
  const result = await send({ type: 'save-close-inspection' });
  renderResult(actionOutputEl, result.ok ? (result.result || result) : result);
  renderDomProof(result);
  await refreshContext();
}

async function previewProcedureSchedule() {
  const result = await send({ type: 'procedure-schedule-preview' });
  if (!result.ok) {
    renderResult(hintsOutputEl, result);
    return;
  }
  state.currentProcedureDraft = result.draft;
  if (procedureAcceptEl) procedureAcceptEl.disabled = false;
  renderResult(hintsOutputEl, {
    message: 'Осмотр заполнен. Сформировать расписание процедур для пациента?',
    draft: result.draft
  });
  globalStatusEl.textContent = 'Сформирован preview расписания процедур. Нажмите "Принять расписание", если врач подтверждает.';
}

async function acceptProcedureSchedule() {
  if (!state.currentProcedureDraft?.draft_id) {
    renderResult(hintsOutputEl, { ok: false, error: 'Сначала сформируйте preview расписания процедур.' });
    return;
  }
  const result = await send({ type: 'procedure-schedule-accept', draftId: state.currentProcedureDraft.draft_id });
  renderResult(hintsOutputEl, result.ok ? result.draft : result);
  if (result.ok) {
    if (procedureAcceptEl) procedureAcceptEl.disabled = true;
    globalStatusEl.textContent = 'Расписание процедур принято в sandbox state.';
  }
}

function createRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    throw new Error('Web Speech API недоступен в этой сборке Chrome. Можно использовать fallback через вставку транскрипта.');
  }
  const recognition = new SpeechRecognition();
  recognition.lang = 'ru-RU';
  recognition.continuous = true;
  recognition.interimResults = false;
  return recognition;
}

async function startBrowserSpeechFallback() {
  const recognition = createRecognition();
  state.recognition = recognition;
  state.activeProvider = 'browser-web-speech';
  setRecordingUi(true, 'Идет запись через Chrome Speech Recognition.');

  recognition.onresult = async (event) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const entry = event.results[index];
      if (!entry.isFinal) continue;
      const text = entry[0]?.transcript?.trim();
      if (!text) continue;
      if (shouldIgnoreAgentEcho(text)) continue;
      if (transcriptInputEl) transcriptInputEl.value = text;
      await ingestTranscript(text);
    }
  };

  recognition.onerror = async (event) => {
    renderResult(actionOutputEl, { ok: false, error: `Ошибка записи: ${event.error}` });
    await stopRecording();
  };

  recognition.onend = () => {
    if (state.isRecording) recognition.start();
  };

  recognition.start();
}

function extractTranscriptFromRealtimeMessage(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return payload.text || payload.transcript || payload.committed_transcript || payload.final_transcript || payload?.transcription?.text || '';
}

function extractDeepgramTranscript(payload) {
  return payload?.channel?.alternatives?.[0]?.transcript || '';
}

function deepgramWordConfidence(payload) {
  const words = payload?.channel?.alternatives?.[0]?.words || [];
  const confidences = words
    .map((word) => Number(word.confidence))
    .filter((value) => Number.isFinite(value));
  if (!confidences.length) return null;
  return Number((confidences.reduce((sum, value) => sum + value, 0) / confidences.length).toFixed(3));
}

async function handleDeepgramUtterance(payload) {
  const text = extractDeepgramTranscript(payload).trim();
  if (!text) return;
  if (shouldIgnoreAgentEcho(text)) {
    renderResult(transcriptOutputEl, {
      ignored: true,
      reason: 'agent_voice_echo',
      transcript: text
    });
    return;
  }
  const speakerId = speakerIdFromDeepgram(payload);
  const sttConfidence = deepgramWordConfidence(payload);
  const speakerContext = resolvePatapimSpeaker(text, speakerId);
  if (transcriptInputEl) transcriptInputEl.value = text;
  status(`Слышу: ${text}`, `Слышу: ${text}`);
  renderResult(transcriptOutputEl, quietModeEl?.checked ? {
    provider: state.activeProvider,
    speakerId,
    speakerTag: speakerContext.role,
    sttConfidence,
    transcript: text
  } : {
    provider: state.activeProvider,
    speakerId,
    speakerTag: speakerContext.role,
    realtimeEvent: payload
  });
  if (speakerContext.controlOnly) return;
  await ingestTranscript(text, speakerContext.role, speakerId, { sttConfidence });
}

async function openMicrophone() {
  state.mediaStream ||= await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });
  return state.mediaStream;
}

async function startDeepgramRealtime() {
  const configResult = await send({ type: 'get-deepgram-config' });
  if (!configResult.ok) throw new Error(configResult.error || 'Deepgram config недоступен.');
  const config = configResult.config;
  if (!config?.apiKey || !config?.url) throw new Error('Backend не вернул Deepgram realtime config.');
  if (config.realtimeUsable === false) {
    const reason = config.permissionCheck?.reason || 'Deepgram realtime недоступен для этого ключа.';
    throw new Error(`Deepgram realtime недоступен: ${reason}`);
  }

  await openMicrophone();
  const socket = new WebSocket(config.url, ['token', config.apiKey]);
  state.realtimeSocket = socket;
  state.activeProvider = 'deepgram-realtime';
  let lastSocketError = 'Deepgram WebSocket error.';

  socket.onmessage = async (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    const isFinal = Boolean(payload.is_final || payload.speech_final);
    if (payload.type === 'UtteranceEnd' && !extractDeepgramTranscript(payload).trim()) return;
    const text = extractDeepgramTranscript(payload).trim();
    if (!shouldProcessRealtimeText(text, isFinal)) {
      if (text) {
        status(`Слышу: ${text}`, `Слышу: ${text}`);
        renderResult(transcriptOutputEl, { provider: state.activeProvider, partial: true, transcript: text });
      }
      return;
    }
    await handleDeepgramUtterance(payload);
  };

  socket.onerror = () => {
    lastSocketError = 'Deepgram WebSocket не открылся.';
  };

  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onclose = (event) => {
      if (!state.isRecording) return;
      reject(new Error(`${lastSocketError} close=${event.code}${event.reason ? ` reason=${event.reason}` : ''}`));
    };
  });

  await startPcmAudioPump((pcmBytes) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(pcmBytes);
  });
  setRecordingUi(true, 'Идет запись через Deepgram realtime voice navigator.');
}

async function startElevenLabsRealtime() {
  const tokenResult = await send({ type: 'get-realtime-token' });
  if (!tokenResult.ok) throw new Error(tokenResult.error || 'Realtime token недоступен.');
  const token = tokenValue(tokenResult.token);
  if (!token) throw new Error('Backend не вернул одноразовый realtime token.');

  await openMicrophone();

  const model = tokenResult.token?.model || 'scribe_v2_realtime';
  const url = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=${encodeURIComponent(model)}&language_code=ru&audio_format=pcm_16000&commit_strategy=vad&token=${encodeURIComponent(token)}`;
  const socket = new WebSocket(url);
  state.realtimeSocket = socket;
  state.activeProvider = 'elevenlabs-realtime';

  socket.onmessage = async (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch (error) {
      return;
    }
    const text = extractTranscriptFromRealtimeMessage(payload).trim();
    const isFinal = payload.is_final || payload.final || /committed|final/i.test(payload.message_type || payload.type || '');
    if (!text) return;
    if (shouldIgnoreAgentEcho(text)) return;
    if (transcriptInputEl) transcriptInputEl.value = text;
    status(`Слышу: ${text}`, `Слышу: ${text}`);
    renderResult(transcriptOutputEl, { provider: state.activeProvider, realtimeEvent: payload });
    if (shouldProcessRealtimeText(text, isFinal)) await ingestTranscript(text);
  };

  socket.onerror = async () => {
    renderResult(actionOutputEl, { ok: false, error: 'Ошибка ElevenLabs realtime WebSocket. Переключаюсь на fallback, если возможно.' });
    await stopRealtimeAudioOnly();
    await startBrowserSpeechFallback();
  };

  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onclose = (event) => {
      if (!state.isRecording) return;
      reject(new Error(`Realtime socket closed: ${event.code}`));
    };
  });

  await startPcmAudioPump((pcmBytes) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      message_type: 'input_audio_chunk',
      audio_base_64: toBase64(pcmBytes),
      sample_rate: 16000
    }));
  });
  setRecordingUi(true, 'Идет запись через ElevenLabs realtime STT.');
}

async function startRecording() {
  setRecordingUi(true, 'Подключаю голосовой режим агента.');
  try {
    const result = await send({ type: 'start-live-session' });
    if (!result.ok) {
      renderResult(actionOutputEl, result);
      return;
    }
    state.currentSession = result.session;
    setRecordingUi(true, 'Подключаю Deepgram realtime voice navigator.');
    try {
      await startDeepgramRealtime();
    } catch (error) {
      const skipElevenLabs = /insufficient permissions|realtime недоступен/i.test(error.message);
      renderResult(actionOutputEl, {
        ok: false,
        provider: 'deepgram-realtime',
        error: error.message,
        fallback: skipElevenLabs ? 'browser-web-speech' : 'elevenlabs/browser-web-speech'
      });
      await stopRealtimeAudioOnly();
      if (skipElevenLabs) {
        await startBrowserSpeechFallback();
        return;
      }
      await startElevenLabsRealtime().catch(async (fallbackError) => {
        renderResult(actionOutputEl, {
          ok: false,
          provider: 'elevenlabs-realtime',
          error: fallbackError.message,
          fallback: 'browser-web-speech'
        });
        await stopRealtimeAudioOnly();
        await startBrowserSpeechFallback();
      });
    }
  } catch (error) {
    setRecordingUi(false, 'Запись не запущена.');
    showError(error);
  }
}

async function startAgentWorkMode() {
  if (state.isRecording) return;
  state.agentWorkMode = true;
  resetPatapimMode();
  renderResult(actionOutputEl, {
    mode: 'agent_work_mode',
    instruction: 'Врач говорит: режим доктора Патапима. Пациент говорит: я пациент.'
  });
  await refreshContext();
  await speakAgent(agentGreeting(), { force: true });
  await startRecording();
}

async function stopRealtimeAudioOnly() {
  if (state.processorNode) {
    state.processorNode.disconnect();
    if (state.processorNode.port) state.processorNode.port.onmessage = null;
    state.processorNode = null;
  }
  if (state.sourceNode) {
    state.sourceNode.disconnect();
    state.sourceNode = null;
  }
  if (state.audioContext) {
    await state.audioContext.close().catch(() => null);
    state.audioContext = null;
  }
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach((track) => track.stop());
    state.mediaStream = null;
  }
  if (state.realtimeSocket) {
    if (state.realtimeSocket.readyState === WebSocket.OPEN) {
      if (state.activeProvider === 'deepgram-realtime') {
        state.realtimeSocket.send(JSON.stringify({ type: 'CloseStream' }));
      } else {
        state.realtimeSocket.send(JSON.stringify({ message_type: 'commit' }));
      }
    }
    state.realtimeSocket.close();
    state.realtimeSocket = null;
  }
}

async function stopRecording() {
  try {
    globalThis.speechSynthesis?.cancel?.();
    state.agentWorkMode = false;
    state.isAgentSpeaking = false;
    if (state.recognition) {
      const recognition = state.recognition;
      state.recognition = null;
      recognition.onend = null;
      recognition.stop();
    }
    await stopRealtimeAudioOnly();
    if (state.currentSession) {
      const result = await send({ type: 'stop-live-session' });
      renderResult(actionOutputEl, result.ok ? result : result);
      state.currentSession = null;
      await loadDraft();
    }
  } catch (error) {
    renderResult(actionOutputEl, { ok: false, error: error.message });
  } finally {
    state.activeProvider = null;
    setRecordingUi(false, 'Запись остановлена.');
  }
}

document.querySelector('#refreshContext')?.addEventListener('click', refreshContext);
document.querySelector('#loadDraft')?.addEventListener('click', loadDraft);
document.querySelector('#applyPreview')?.addEventListener('click', applyPreview);
document.querySelector('#observeCommand')?.addEventListener('click', () => observeCommand());
document.querySelector('#applyCommand')?.addEventListener('click', applyPreview);
document.querySelector('#ingestTranscript')?.addEventListener('click', () => ingestTranscript());
document.querySelector('#saveInspection')?.addEventListener('click', saveInspection);
document.querySelector('#saveCloseInspection')?.addEventListener('click', saveCloseInspection);
document.querySelector('#startRecording')?.addEventListener('click', startAgentWorkMode);
document.querySelector('#stopRecording')?.addEventListener('click', stopRecording);
document.querySelector('#procedurePreview')?.addEventListener('click', previewProcedureSchedule);
document.querySelector('#procedureAccept')?.addEventListener('click', acceptProcedureSchedule);
document.querySelectorAll('.quick-command').forEach((button) => {
  button.addEventListener('click', () => {
    if (commandInputEl) commandInputEl.value = button.dataset.command;
    observeCommand(button.dataset.command).catch(showError);
  });
});
document.querySelector('#exampleDoctor')?.addEventListener('click', () => {
  const speakerTagEl = document.querySelector('#speakerTag');
  if (speakerTagEl) speakerTagEl.value = 'doctor';
  if (transcriptInputEl) transcriptInputEl.value = 'Врач: рекомендую продолжить индивидуальные занятия, положительная динамика по игровым навыкам, контакт устанавливает с трудом, внимание недостаточно устойчивое.';
});
document.querySelector('#exampleCaregiver')?.addEventListener('click', () => {
  const speakerTagEl = document.querySelector('#speakerTag');
  if (speakerTagEl) speakerTagEl.value = 'caregiver';
  if (transcriptInputEl) transcriptInputEl.value = 'Родитель: дома ребенок лучше удерживает внимание, но быстро устает, частично понимает инструкцию и нуждается в повторении.';
});

renderSpeakers();
refreshContext().catch(showError);
