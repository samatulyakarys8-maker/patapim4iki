import { isBreakModeCommand } from './break-mode.js';
import { createBreakModeWidget } from './break-mode-widget.js';

const chatTimelineEl = document.querySelector('#chatTimeline');
const chatInputEl = document.querySelector('#chatInput');
const globalStatusEl = document.querySelector('#globalStatus');
const voiceToggleEl = document.querySelector('#voiceToggle');
const themeToggleEl = document.querySelector('#themeToggle');
const toolsToggleEl = document.querySelector('#toolsToggle');
const toolsMenuEl = document.querySelector('#toolsMenu');
const toggleAdvisorModeEl = document.querySelector('#toggleAdvisorMode');
const advisorModePillEl = document.querySelector('#advisorModePill');
const advisorIndicatorEl = document.querySelector('#advisorIndicator');
const breakModeTriggerEl = document.querySelector('#breakModeTrigger');
const mainPanelEl = document.querySelector('#mainPanel');
const breakModePanelEl = document.querySelector('#breakModePanel');
const breakModeCanvasEl = document.querySelector('#breakModeCanvas');
const breakModeScoreEl = document.querySelector('#breakModeScore');
const breakModeBestEl = document.querySelector('#breakModeBest');
const breakModeRestartEl = document.querySelector('#breakModeRestart');
const breakModeStatusEl = document.querySelector('#breakModeStatus');
const breakModeCloseEl = document.querySelector('#breakModeClose');

const VOICE_IDLE_ICON = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"></path>
    <path d="M19 10v1a7 7 0 0 1-14 0v-1"></path>
    <path d="M12 18v3"></path>
    <path d="M8 21h8"></path>
  </svg>
`;
const VOICE_RECORDING_ICON = '<span class="stop-icon" aria-hidden="true"></span>';

const FIELD_LABELS = {
  tbmedicalfinal: 'Заключение',
  recommendations: 'Рекомендации',
  dynamics: 'Динамика развития',
  'work-plan': 'План работы',
  'planned-sessions': 'Планируемые занятия',
  'completed-sessions': 'Проведенные занятия',
  dtpserviceexecutedate: 'Дата выполнения',
  dtpserviceexecutetime: 'Время выполнения',
  ntbdurationminute: 'Длительность приема',
  cmbmedicalform: 'Форма',
  cmbperformerservice: 'Услуга',
  cmbperformerservicemo: 'Услуга из прейскуранта'
};

const EXAMPLES = {
  doctor: 'Врач: рекомендую продолжить индивидуальные занятия. Контакт устанавливает с трудом, внимание недостаточно устойчивое, по игровым навыкам есть положительная динамика.',
  caregiver: 'Родитель: дома ребенок быстро устает, частично понимает инструкцию, нуждается в повторении и лучше удерживает внимание при коротких заданиях.'
};

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
  advisorModeEnabled: false,
  latestScreenContext: null,
  latestSuggestions: [],
  breakModeWidget: null
};

async function send(message) {
  if (!globalThis.chrome?.runtime?.sendMessage) {
    throw new Error('Откройте панель через иконку расширения на вкладке http://localhost:3030.');
  }
  return chrome.runtime.sendMessage(message);
}

function setStatus(message) {
  globalStatusEl.textContent = message;
}

function setTheme(theme) {
  document.body.dataset.theme = theme;
  themeToggleEl.textContent = theme === 'dark' ? 'Светлая' : 'Темная';
  localStorage.setItem('damumed-assistant-theme', theme);
}

function setToolsMenuOpen(isOpen) {
  toolsMenuEl.hidden = !isOpen;
  toolsToggleEl.setAttribute('aria-expanded', String(isOpen));
}

function closeToolsMenu() {
  setToolsMenuOpen(false);
}

function updateAdvisorUi() {
  const enabled = state.advisorModeEnabled;
  advisorIndicatorEl.hidden = !enabled;
  advisorModePillEl.classList.toggle('is-active', enabled);
  advisorModePillEl.setAttribute('aria-pressed', String(enabled));
  toggleAdvisorModeEl.textContent = enabled ? 'Выключить режим советчика' : 'Включить режим советчика';
  toggleAdvisorModeEl.classList.toggle('is-active', enabled);
  toggleAdvisorModeEl.setAttribute('aria-pressed', String(enabled));
  chatInputEl.placeholder = enabled
    ? 'Спросите советчика: что уточнить, какие гипотезы проверить, что заполнить дальше.'
    : 'Вставьте текст приема или надиктуйте фрагмент.';
  setStatus(enabled ? 'Режим советчика включен.' : 'Режим приема: собираю предложения для формы.');
}

function setAdvisorMode(enabled) {
  const changed = state.advisorModeEnabled !== enabled;
  state.advisorModeEnabled = enabled;
  updateAdvisorUi();
  if (changed) {
    appendMessage({
      role: 'system',
      title: enabled ? 'Советчик включен' : 'Советчик выключен',
      body: enabled
        ? 'Теперь сообщения будут уходить советчику для пошагового анализа приема.'
        : 'Теперь сообщения снова будут обрабатываться как текст приема.'
    });
  }
  closeToolsMenu();
}

function clearChat() {
  chatTimelineEl.replaceChildren();
  appendMessage({
    role: 'assistant',
    title: 'Чат очищен',
    body: 'Готов продолжить прием. Данные пациента и предложения формы не удалены.'
  });
  closeToolsMenu();
}

function escapeText(value) {
  return String(value || '');
}

function appendMessage({ role = 'assistant', title = '', body = '', cards = [], tone = '' }) {
  const article = document.createElement('article');
  article.className = ['message', role, tone].filter(Boolean).join(' ');

  if (title) {
    const titleEl = document.createElement('p');
    titleEl.className = 'message-title';
    titleEl.textContent = title;
    article.append(titleEl);
  }

  if (body) {
    const bodyEl = document.createElement('p');
    bodyEl.className = 'message-body';
    bodyEl.textContent = escapeText(body);
    article.append(bodyEl);
  }

  if (cards.length) {
    const stack = document.createElement('div');
    stack.className = 'card-stack';
    for (const card of cards) {
      stack.append(createCard(card));
    }
    article.append(stack);
  }

  chatTimelineEl.append(article);
  chatTimelineEl.scrollTop = chatTimelineEl.scrollHeight;
  return article;
}

function createCard(card) {
  const wrapper = document.createElement('div');
  wrapper.className = ['info-card', card.tone].filter(Boolean).join(' ');

  const title = document.createElement('p');
  title.className = 'card-title';
  title.textContent = card.title || 'Подсказка';
  wrapper.append(title);

  if (card.text) {
    const text = document.createElement('p');
    text.className = 'card-text';
    text.textContent = card.text;
    wrapper.append(text);
  }

  if (Array.isArray(card.tags) && card.tags.length) {
    const tags = document.createElement('div');
    tags.className = 'tag-row';
    for (const tag of card.tags) {
      const tagEl = document.createElement('span');
      tagEl.className = 'tag';
      tagEl.textContent = tag;
      tags.append(tagEl);
    }
    wrapper.append(tags);
  }

  if (card.action) {
    const button = document.createElement('button');
    button.className = card.action.kind === 'primary' ? 'primary-button' : 'ghost-button';
    button.type = 'button';
    button.textContent = card.action.label;
    button.addEventListener('click', card.action.onClick);
    wrapper.append(button);
  }

  return wrapper;
}

function showError(error) {
  const message = error?.message || String(error);
  setStatus(message);
  appendMessage({
    role: 'assistant',
    title: 'Не получилось выполнить действие',
    body: message,
    tone: 'error'
  });
}

function ensureBreakModeWidget() {
  if (!state.breakModeWidget) {
    state.breakModeWidget = createBreakModeWidget({
      root: breakModePanelEl,
      canvas: breakModeCanvasEl,
      scoreEl: breakModeScoreEl,
      bestEl: breakModeBestEl,
      restartButton: breakModeRestartEl,
      statusEl: breakModeStatusEl
    });
  }
  return state.breakModeWidget;
}

async function openBreakMode(trigger = 'command') {
  const widget = ensureBreakModeWidget();
  mainPanelEl.classList.add('break-mode-active');
  widget.show();
  chatInputEl.value = '';
  closeToolsMenu();
  setStatus('Break Mode открыт в боковой панели.');
  appendMessage({
    role: 'system',
    title: 'Break Mode',
    body: trigger === 'chat-command'
      ? 'Открыл встроенную мини-игру прямо в панели.'
      : 'Мини-игра доступна прямо в боковой панели.'
  });
}

function closeBreakMode() {
  mainPanelEl.classList.remove('break-mode-active');
  state.breakModeWidget?.hide();
  setStatus('Break Mode закрыт.');
}

function screenLabel(screenContext) {
  if (screenContext?.screen_id === 'inspection') return 'Открыта форма приема пациента.';
  if (screenContext?.screen_id === 'schedule') return 'Открыто расписание. Выберите пациента и откройте прием.';
  return 'Откройте песочницу Damumed и форму приема пациента.';
}

function fieldLabel(patch) {
  return patch.title || FIELD_LABELS[patch.field_key] || FIELD_LABELS[patch.section_key] || 'Поле формы';
}

function formatConfidence(confidence) {
  const value = Number(confidence);
  if (!Number.isFinite(value)) return 'уверенность не указана';
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}% уверенности`;
}

function patchText(patch) {
  if (patch.value_type === 'checkbox-group') {
    const count = Array.isArray(patch.value) ? patch.value.length : 0;
    return count
      ? `Предлагаю отметить ${count} пункт(а) в этом разделе.`
      : 'Предлагаю проверить этот раздел перед сохранением.';
  }
  return String(patch.value || '').trim() || 'Предлагаю заполнить это поле по данным приема.';
}

function suggestionCards(patches) {
  return (patches || []).map((patch) => ({
    title: fieldLabel(patch),
    text: patchText(patch),
    tags: [formatConfidence(patch.confidence), patch.status === 'applied' ? 'уже применено' : 'можно применить'],
    action: patch.status === 'applied'
      ? null
      : {
          kind: 'primary',
          label: 'Применить в форму',
          onClick: applyPreview
        }
  }));
}

function advisorCards(answer) {
  const cards = [];

  if (answer.next_step) {
    cards.push({ title: 'Следующий шаг', text: answer.next_step });
  }

  for (const hypothesis of answer.differential_hypotheses || []) {
    const details = [
      ...(hypothesis.supporting_signs || []).map((item) => `За: ${item}`),
      ...(hypothesis.missing_checks || []).map((item) => `Уточнить: ${item}`),
      ...(hypothesis.cautions || []).map((item) => `Важно: ${item}`)
    ].join('\n');
    cards.push({
      title: hypothesis.name || 'Гипотеза для проверки',
      text: details || 'Недостаточно данных, нужно уточнение.',
      tags: [hypothesis.likelihood ? `вероятность: ${hypothesis.likelihood}` : 'требует проверки']
    });
  }

  if (answer.questions_to_ask?.length) {
    cards.push({
      title: 'Что спросить',
      text: answer.questions_to_ask.map((item) => `- ${item}`).join('\n')
    });
  }

  if (answer.symptoms_to_check?.length) {
    cards.push({
      title: 'Что проверить',
      text: answer.symptoms_to_check.map((item) => `- ${item}`).join('\n')
    });
  }

  if (answer.form_guidance?.length) {
    cards.push({
      title: 'Что можно заполнить',
      text: answer.form_guidance.map((item) => `${item.field_label || 'Поле'}: ${item.suggestion || ''}`).join('\n')
    });
  }

  if (answer.red_flags?.length) {
    cards.push({
      title: 'Красные флаги',
      text: answer.red_flags.map((item) => `- ${item}`).join('\n'),
      tone: 'danger'
    });
  }

  return cards;
}

function renderAdvisorAnswer(payload, title = 'Советчик') {
  const answer = payload?.answer || {};
  appendMessage({
    role: 'assistant',
    title,
    body: answer.summary || 'Я собрал доступные данные и подготовил следующий шаг.',
    cards: advisorCards(answer)
  });

  if (answer.doctor_note) {
    appendMessage({
      role: 'system',
      title: 'Важно',
      body: answer.doctor_note
    });
  }
}

function setRecordingUi(isRecording, message) {
  state.isRecording = isRecording;
  voiceToggleEl.classList.toggle('is-active', isRecording);
  voiceToggleEl.setAttribute('aria-pressed', String(isRecording));
  voiceToggleEl.setAttribute('aria-label', isRecording ? 'Остановить запись' : 'Запустить запись');
  voiceToggleEl.title = isRecording ? 'Остановить запись' : 'Запись';
  voiceToggleEl.innerHTML = isRecording ? VOICE_RECORDING_ICON : VOICE_IDLE_ICON;
  setStatus(message);
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

function tokenValue(tokenPayload) {
  return tokenPayload?.token || tokenPayload?.single_use_token || tokenPayload?.access_token || tokenPayload?.jwt || tokenPayload?.key;
}

async function refreshContext({ silent = false } = {}) {
  try {
    setStatus('Проверяю текущий экран.');
    const result = await send({ type: 'refresh-context' });
    if (!result.ok) throw new Error(result.error || 'Не удалось определить экран.');
    state.latestScreenContext = result.screenContext;
    const label = screenLabel(result.screenContext);
    setStatus(label);
    if (!silent) {
      appendMessage({ role: 'assistant', title: 'Контекст обновлен', body: label });
    }
    return result;
  } catch (error) {
    showError(error);
    return { ok: false, error: error.message };
  }
}

async function loadDraft({ silent = false } = {}) {
  try {
    const result = await send({ type: 'get-draft-state' });
    if (!result.ok) throw new Error(result.error || 'Не удалось получить предложения.');
    state.latestScreenContext = result.screenContext;
    state.latestSuggestions = result.draftState?.draft_patches || [];
    const cards = suggestionCards(state.latestSuggestions);
    if (!silent || cards.length) {
      appendMessage({
        role: 'assistant',
        title: cards.length ? 'Предложения для формы' : 'Пока нет предложений',
        body: cards.length
          ? 'Проверьте найденные пункты. В форму ничего не попадет без вашего подтверждения.'
          : 'Запустите запись или вставьте текст приема, чтобы я подготовил предложения.',
        cards
      });
    }
    return result;
  } catch (error) {
    showError(error);
    return { ok: false, error: error.message };
  }
}

async function applyPreview() {
  try {
    setStatus('Применяю подтвержденные предложения в форму.');
    const result = await send({ type: 'apply-preview' });
    if (!result.ok || result.result?.ok === false) {
      throw new Error(result.error || result.result?.failed?.reason || 'Не удалось применить предложения.');
    }
    appendMessage({
      role: 'assistant',
      title: 'Готово',
      body: 'Предложения применены в форму. Проверьте поля перед сохранением.'
    });
    await loadDraft({ silent: true });
  } catch (error) {
    showError(error);
  }
}

function isUnsupportedAdvisorError(resultOrError) {
  const message = resultOrError?.error || resultOrError?.message || String(resultOrError || '');
  return /Unsupported message type:\s*advisor-analyze/i.test(message);
}

async function fetchAdvisorDirect(question) {
  let screenContext = state.latestScreenContext;
  if (!screenContext?.selected_appointment_id || screenContext.screen_id !== 'inspection') {
    const contextResult = await send({ type: 'refresh-context' });
    if (!contextResult.ok) {
      throw new Error(contextResult.error || 'Не удалось получить контекст формы приема.');
    }
    screenContext = contextResult.screenContext;
    state.latestScreenContext = screenContext;
  }

  if (screenContext.screen_id !== 'inspection' || !screenContext.selected_appointment_id) {
    throw new Error('Откройте форму приема пациента, чтобы советчик видел текущий контекст.');
  }

  const response = await fetch('http://localhost:3030/api/advisor/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appointmentId: screenContext.selected_appointment_id,
      question,
      screenContext
    })
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || 'Советчик сейчас недоступен.');
  }
  return { ok: true, screenContext, ...payload };
}

async function askAdvisor(question, { quietUserMessage = false, title = 'Советчик' } = {}) {
  const text = String(question || '').trim();
  if (!text) return;
  try {
    if (!quietUserMessage) {
      appendMessage({ role: 'user', title: 'Врач', body: text });
    }
    setStatus('Советчик анализирует прием.');
    let result = await send({ type: 'advisor-analyze', question: text });
    if (!result.ok && isUnsupportedAdvisorError(result)) {
      result = await fetchAdvisorDirect(text);
    }
    if (!result.ok) throw new Error(result.error || 'Советчик сейчас недоступен.');
    renderAdvisorAnswer(result, title);
    setStatus('Советчик подготовил подсказки.');
  } catch (error) {
    showError(error);
  }
}

async function ingestTranscript(textOverride = null, { fromRecording = false } = {}) {
  const text = String(textOverride ?? chatInputEl.value).trim();
  const speakerTag = document.querySelector('#speakerTag').value;
  if (!text) {
    appendMessage({
      role: 'assistant',
      title: 'Нужен текст',
      body: 'Вставьте фразу приема или запустите запись.'
    });
    return;
  }

  if (!fromRecording) {
    appendMessage({ role: 'user', title: 'Текст приема', body: text });
  }

  try {
    setStatus('Обрабатываю текст приема.');
    const result = await send({ type: 'ingest-transcript', text, speakerTag });
    if (!result.ok) throw new Error(result.error || 'Не удалось обработать текст приема.');

    const chunk = result.transcript?.chunk;
    appendMessage({
      role: 'assistant',
      title: 'Я услышал',
      body: chunk?.text || text,
      cards: chunk?.speaker_tag ? [{ title: 'Говорящий', text: speakerName(chunk.speaker_tag) }] : []
    });

    state.latestScreenContext = result.screenContext;
    state.latestSuggestions = result.transcript?.draftPatches || [];
    const cards = suggestionCards(state.latestSuggestions);
    appendMessage({
      role: 'assistant',
      title: cards.length ? 'Что можно внести в форму' : 'Факты сохранены',
      body: cards.length
        ? 'Я подготовил предложения. Проверьте их перед применением.'
        : 'Я сохранил текст в контексте приема, но пока не нашел надежных полей для заполнения.',
      cards
    });

    chatInputEl.value = '';
    await askAdvisor('Подскажи врачу следующий шаг приема по последнему фрагменту.', {
      quietUserMessage: true,
      title: 'Следующий шаг'
    });
  } catch (error) {
    showError(error);
  }
}

function speakerName(tag) {
  if (tag === 'doctor') return 'Врач';
  if (tag === 'caregiver') return 'Родитель или сопровождающий';
  if (tag === 'patient') return 'Пациент';
  return 'Не удалось определить точно';
}

async function saveInspection() {
  try {
    const result = await send({ type: 'save-inspection' });
    if (!result.ok || result.result?.ok === false) throw new Error(result.error || 'Не удалось сохранить форму.');
    appendMessage({ role: 'assistant', title: 'Сохранено', body: 'Форма сохранена. Проверьте статус в песочнице.' });
    await refreshContext({ silent: true });
  } catch (error) {
    showError(error);
  }
}

async function saveCloseInspection() {
  try {
    const result = await send({ type: 'save-close-inspection' });
    if (!result.ok || result.result?.ok === false) throw new Error(result.error || 'Не удалось сохранить и закрыть форму.');
    appendMessage({ role: 'assistant', title: 'Сохранено и закрыто', body: 'Прием завершен в песочнице.' });
    await refreshContext({ silent: true });
  } catch (error) {
    showError(error);
  }
}

function createRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    throw new Error('Web Speech API недоступен в этой сборке Chrome. Можно вставить текст приема вручную.');
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
      chatInputEl.value = text;
      await ingestTranscript(text, { fromRecording: true });
    }
  };

  recognition.onerror = async (event) => {
    appendMessage({ role: 'assistant', title: 'Ошибка записи', body: `Chrome Speech Recognition: ${event.error}`, tone: 'error' });
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

async function startElevenLabsRealtime() {
  const tokenResult = await send({ type: 'get-realtime-token' });
  if (!tokenResult.ok) throw new Error(tokenResult.error || 'Realtime token недоступен.');
  const token = tokenValue(tokenResult.token);
  if (!token) throw new Error('Backend не вернул одноразовый realtime token.');

  state.mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });

  const model = tokenResult.token?.model || 'scribe_v2_realtime';
  const url = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=${encodeURIComponent(model)}&language_code=ru&audio_format=pcm_16000&commit_strategy=vad&token=${encodeURIComponent(token)}`;
  const socket = new WebSocket(url);
  state.realtimeSocket = socket;
  state.activeProvider = 'elevenlabs-realtime';

  socket.onmessage = async (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    const text = extractTranscriptFromRealtimeMessage(payload).trim();
    const isFinal = payload.is_final || payload.final || /committed|final/i.test(payload.message_type || payload.type || '');
    if (!text) return;
    chatInputEl.value = text;
    if (isFinal) await ingestTranscript(text, { fromRecording: true });
  };

  socket.onerror = async () => {
    appendMessage({
      role: 'assistant',
      title: 'Переключаю запись',
      body: 'ElevenLabs realtime недоступен. Пробую встроенное распознавание Chrome.',
      tone: 'error'
    });
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

  state.audioContext = new AudioContext();
  state.sourceNode = state.audioContext.createMediaStreamSource(state.mediaStream);
  state.processorNode = state.audioContext.createScriptProcessor(4096, 1, 1);
  state.processorNode.onaudioprocess = (event) => {
    if (!state.isRecording || socket.readyState !== WebSocket.OPEN) return;
    const input = event.inputBuffer.getChannelData(0);
    const downsampled = downsampleTo16Khz(input, state.audioContext.sampleRate);
    const pcmBytes = floatToPcm16(downsampled);
    socket.send(JSON.stringify({
      message_type: 'input_audio_chunk',
      audio_base_64: toBase64(pcmBytes),
      sample_rate: 16000
    }));
  };
  state.sourceNode.connect(state.processorNode);
  state.processorNode.connect(state.audioContext.destination);
  setRecordingUi(true, 'Идет запись через realtime STT.');
}

async function startRecording() {
  setRecordingUi(true, 'Проверяю форму и запускаю запись.');
  try {
    const result = await send({ type: 'start-live-session' });
    if (!result.ok) throw new Error(result.error || 'Запись доступна только на форме приема.');
    state.currentSession = result.session;
    state.latestScreenContext = result.screenContext;
    appendMessage({ role: 'assistant', title: 'Запись началась', body: 'Говорите свободно. Я покажу врачу только понятные итоги и предложения.' });
    try {
      await startElevenLabsRealtime();
    } catch (error) {
      appendMessage({ role: 'assistant', title: 'Использую резервную запись', body: error.message });
      await stopRealtimeAudioOnly();
      await startBrowserSpeechFallback();
    }
  } catch (error) {
    setRecordingUi(false, 'Запись не запущена.');
    showError(error);
  }
}

async function stopRealtimeAudioOnly() {
  if (state.processorNode) {
    state.processorNode.disconnect();
    state.processorNode.onaudioprocess = null;
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
      state.realtimeSocket.send(JSON.stringify({ message_type: 'commit' }));
    }
    state.realtimeSocket.close();
    state.realtimeSocket = null;
  }
}

async function stopRecording() {
  try {
    if (state.recognition) {
      const recognition = state.recognition;
      state.recognition = null;
      recognition.onend = null;
      recognition.stop();
    }
    await stopRealtimeAudioOnly();
    if (state.currentSession) {
      const result = await send({ type: 'stop-live-session' });
      if (!result.ok) throw new Error(result.error || 'Не удалось остановить запись.');
      state.currentSession = null;
      appendMessage({ role: 'assistant', title: 'Запись остановлена', body: 'Я обновил предложения по приему.' });
      await loadDraft({ silent: true });
    }
  } catch (error) {
    showError(error);
  } finally {
    state.activeProvider = null;
    setRecordingUi(false, 'Запись остановлена.');
  }
}

async function toggleRecording() {
  if (state.isRecording) {
    await stopRecording();
    return;
  }
  await startRecording();
}

async function handleSubmit(event) {
  event.preventDefault();
  const text = chatInputEl.value.trim();
  if (!text) return;
  if (isBreakModeCommand(text)) {
    await openBreakMode('chat-command');
    return;
  }
  if (state.advisorModeEnabled) {
    chatInputEl.value = '';
    await askAdvisor(text);
    return;
  }
  await ingestTranscript(text);
}

function initEvents() {
  document.querySelector('#refreshContext').addEventListener('click', () => refreshContext());
  document.querySelector('#loadDraft').addEventListener('click', () => loadDraft());
  document.querySelector('#applyPreview').addEventListener('click', applyPreview);
  document.querySelector('#saveInspection').addEventListener('click', saveInspection);
  document.querySelector('#saveCloseInspection').addEventListener('click', saveCloseInspection);
  voiceToggleEl.addEventListener('click', toggleRecording);
  document.querySelector('#composer').addEventListener('submit', handleSubmit);
  toolsToggleEl.addEventListener('click', () => setToolsMenuOpen(toolsMenuEl.hidden));
  advisorModePillEl.addEventListener('click', () => setAdvisorMode(!state.advisorModeEnabled));
  toggleAdvisorModeEl.addEventListener('click', () => setAdvisorMode(!state.advisorModeEnabled));
  document.querySelector('#clearChat').addEventListener('click', clearChat);
  document.querySelector('#exampleDoctor').addEventListener('click', () => {
    document.querySelector('#speakerTag').value = 'doctor';
    chatInputEl.value = EXAMPLES.doctor;
    setAdvisorMode(false);
    closeToolsMenu();
  });
  document.querySelector('#exampleCaregiver').addEventListener('click', () => {
    document.querySelector('#speakerTag').value = 'caregiver';
    chatInputEl.value = EXAMPLES.caregiver;
    setAdvisorMode(false);
    closeToolsMenu();
  });
  breakModeTriggerEl.addEventListener('click', () => {
    openBreakMode('hidden-button').catch(showError);
  });
  breakModeCloseEl.addEventListener('click', closeBreakMode);
  themeToggleEl.addEventListener('click', () => {
    setTheme(document.body.dataset.theme === 'dark' ? 'light' : 'dark');
  });
  document.addEventListener('click', (event) => {
    if (!toolsMenuEl.hidden && !event.target.closest('.tools-wrap')) {
      closeToolsMenu();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (state.breakModeWidget?.isVisible()) {
        closeBreakMode();
      } else {
        closeToolsMenu();
      }
    }
    if (event.code === 'Space' && document.activeElement !== chatInputEl && state.breakModeWidget?.isVisible()) {
      event.preventDefault();
      state.breakModeWidget.jump();
    }
  });
}

function init() {
  setTheme(localStorage.getItem('damumed-assistant-theme') || 'light');
  updateAdvisorUi();
  initEvents();
  appendMessage({
    role: 'assistant',
    title: 'Готов к приему',
    body: 'Я буду показывать только понятные подсказки: что услышал, что можно заполнить и какой следующий шаг проверить врачу.'
  });
  refreshContext({ silent: true }).catch(showError);
}

init();
