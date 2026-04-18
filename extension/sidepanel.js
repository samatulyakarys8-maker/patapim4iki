import { isBreakModeCommand } from './break-mode.js';
import { createBreakModeWidget } from './break-mode-widget.js';

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason?.message || event.reason || '';
  if (/patient_not_found|advisor_context_missing/i.test(String(reason))) {
    event.preventDefault();
  }
}, { capture: true });

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
const EXTENSION_BUILD_ID = 'voice-router-break-merge-2026-04-19-0015';

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
  mediaRecorder: null,
  openAiTranscribeInFlight: false,
  openAiAudioChunks: [],
  openAiPcmChunks: [],
  lastOpenAiSubmittedBytes: 0,
  lastOpenAiTranscript: '',
  lastOpenAiError: '',
  realtimeSocket: null,
  activeProvider: null,
  advisorModeEnabled: false,
  latestScreenContext: null,
  latestSuggestions: [],
  lastProcessedSpeechKey: '',
  lastProcessedSpeechAt: 0,
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
  const message = advisorErrorMessage(error);
  setStatus(message);
  appendMessage({
    role: 'assistant',
    title: 'Не получилось выполнить действие',
    body: message,
    tone: 'error'
  });
}

function advisorErrorMessage(resultOrError) {
  const code = resultOrError?.error || resultOrError?.code || '';
  const message = resultOrError?.message || resultOrError?.details || resultOrError?.error || String(resultOrError || '');
  if (/patient_slot_not_found/i.test(code) || /patient_slot_not_found/i.test(message)) {
    return 'Пациент распознан, но в текущем расписании нет открываемого приема для этого имени.';
  }
  if (/advisor_context_missing|patient_not_found|appointment_not_found/i.test(code)
    || /advisor_context_missing|patient_not_found/i.test(message)) {
    return 'Откройте карточку пациента или форму приема, чтобы советчик видел медицинский контекст.';
  }
  return message || 'Советчик сейчас недоступен.';
}

window.addEventListener('unhandledrejection', (event) => {
  const message = advisorErrorMessage(event.reason);
  if (/карточку пациента|форму приема|Советчик|patient_not_found|advisor_context_missing/i.test(message)) {
    event.preventDefault();
    showError(new Error(message));
  }
});

window.addEventListener('error', (event) => {
  const message = advisorErrorMessage(event.error || event.message);
  if (/карточку пациента|форму приема|patient_not_found|advisor_context_missing/i.test(message)) {
    event.preventDefault();
    showError(new Error(message));
  }
});

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

function compactJson(value) {
  if (value == null) return '';
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > 420 ? `${text.slice(0, 417)}...` : text;
  } catch {
    return String(value);
  }
}

function patientCandidateText(candidate) {
  if (!candidate?.patient) return 'Кандидат недоступен';
  const reasons = Array.isArray(candidate.reasons) && candidate.reasons.length
    ? `\n${candidate.reasons.join(', ')}`
    : '';
  return `${candidate.patient.full_name} • score ${candidate.score}${reasons}`;
}

function commandDebugCards(debug = {}, result = {}) {
  const cards = [];
  if (debug.rawTranscript || debug.normalizedTranscript) {
    cards.push({
      title: 'Транскрипт',
      text: [
        debug.rawTranscript ? `Сырой: ${debug.rawTranscript}` : null,
        debug.normalizedTranscript ? `Нормализованный: ${debug.normalizedTranscript}` : null
      ].filter(Boolean).join('\n'),
      tags: [
        debug.sttProvider || 'stt: n/a',
        debug.sttConfidence != null ? formatConfidence(debug.sttConfidence) : 'confidence: n/a'
      ]
    });
  }
  if (debug.deterministicCommandResult) {
    cards.push({
      title: 'Детерминированный разбор',
      text: compactJson({
        intent: debug.deterministicCommandResult.intent,
        actionTarget: debug.deterministicCommandResult.actionTarget,
        patientQuery: debug.deterministicCommandResult.patientQuery,
        confidence: debug.deterministicCommandResult.confidence,
        fallbackReason: debug.deterministicCommandResult.fallbackReason
      }),
      tags: [debug.deterministicCommandResult.debug?.provider || 'deterministic']
    });
  }
  if (Array.isArray(debug.patientCandidates) && debug.patientCandidates.length) {
    cards.push({
      title: 'Кандидаты пациента',
      text: debug.patientCandidates.slice(0, 3).map(patientCandidateText).join('\n\n'),
      tags: [debug.patientQuery || 'без patientQuery']
    });
  }
  if (debug.finalCommandResult?.matchedPatient) {
    cards.push({
      title: 'Распознанный пациент',
      text: `${debug.finalCommandResult.matchedPatient.full_name}${debug.finalCommandResult.matchedPatient.patient_id ? ` • ${debug.finalCommandResult.matchedPatient.patient_id}` : ''}`,
      tags: [
        debug.finalCommandResult.fallbackReason || 'patient matched',
        debug.finalActionPlan?.operations?.length ? 'есть DOM-операции' : 'DOM-операций нет'
      ]
    });
  }
  cards.push({
    title: 'Fallback и итог',
    text: compactJson({
      llmFallbackInvoked: Boolean(debug.llmFallbackInvoked),
      llmFallbackReason: debug.llmFallbackReason || null,
      finalIntent: result?.intent || debug.finalCommandResult?.intent || null,
      actionTarget: result?.actionTarget || debug.finalActionPlan?.actionTarget || null,
      verification: debug.verification?.reason || null,
      blockReason: debug.blockReason || null
    }),
    tags: [
      Boolean(debug.llmFallbackInvoked) ? 'LLM fallback' : 'без LLM',
      debug.verification?.ok ? 'verify ok' : 'verify blocked'
    ]
  });
  return cards;
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

function advisorContextLabel(scope) {
  if (scope === 'inspection') return 'форма приема';
  if (scope === 'patient_card') return 'карточка пациента';
  return scope || 'неизвестно';
}

function advisorReasoningCards(payload) {
  const reasoning = payload?.interview_reasoning;
  if (!reasoning) return [];
  const context = payload?.advisor_context || {};
  const debug = payload?.advisor_debug || {};
  const facts = (reasoning.new_facts || [])
    .map((fact) => `- ${fact.field}: ${fact.value}`)
    .join('\n') || 'Новых фактов нет.';
  const missing = (reasoning.missing_fields || [])
    .map((field) => `- ${field}`)
    .join('\n') || 'Обязательные поля текущего этапа покрыты.';
  const cards = [
    {
      title: 'Разбор советчика',
      text: [
        `Контекст: ${advisorContextLabel(context.screen_scope)}`,
        `Стадия: ${reasoning.stage || 'не определена'}`,
        `Следующий вопрос: ${reasoning.next_best_question || 'не выбран'}`,
        `Почему: ${reasoning.question_reason || 'причина не указана'}`,
        `Стадия завершена: ${reasoning.stage_complete ? 'да' : 'нет'}`,
        `Можно обновлять черновик формы: ${context.can_patch_draft ? 'да' : 'нет'}`,
        debug.model ? `Модель: ${debug.model}` : null,
        `Fallback: ${debug.fallback_used ? 'да' : 'нет'}`
      ].filter(Boolean).join('\n')
    }
  ];
  if (debug.raw_deepgram_transcript || debug.normalized_transcript) {
    cards.push({
      title: 'Транскрипт для анализа',
      text: [
        `Raw: ${debug.raw_deepgram_transcript || ''}`,
        `Normalized: ${debug.normalized_transcript || ''}`
      ].join('\n')
    });
  }
  cards.push(
    {
      title: 'Новые факты',
      text: facts
    },
    {
      title: 'Чего не хватает',
      text: missing
    }
  );
  return cards;
}

function renderAdvisorAnswer(payload, title = 'Советчик') {
  const answer = payload?.answer || {};
  const reasoning = payload?.interview_reasoning || {};
  const context = payload?.advisor_context || {};
  const onPageQuestion = context.screen_scope === 'inspection' && reasoning.next_best_question;
  const onPageCompletion = context.screen_scope === 'inspection' && reasoning.advisor_complete;
  appendMessage({
    role: 'assistant',
    title,
    body: onPageCompletion
      ? 'Сбор данных завершен. Финальный preview вынесен в рабочий экран.'
      : onPageQuestion
      ? 'Уточняющий вопрос вынесен в центр страницы приема.'
      : (answer.next_step || answer.summary || 'Я собрал доступные данные и подготовил следующий шаг.'),
    cards: onPageCompletion
      ? [
          {
            title: 'Статус',
            text: reasoning.completion_message || 'Черновик формы подготовлен. Проверьте и подтвердите заполнение.'
          },
          {
            title: 'Контекст',
            text: `Стадия: завершено\nЧерновик формы ${context.can_patch_draft ? 'готов к проверке' : 'недоступен для прямого обновления'}`
          }
        ]
      : onPageQuestion
      ? [
          {
            title: 'Вопрос на странице',
            text: reasoning.next_best_question
          },
          {
            title: 'Контекст',
            text: `Стадия: ${reasoning.stage || 'не определена'}\nЧерновик формы ${context.can_patch_draft ? 'можно обновлять' : 'пока не обновляется'}`
          }
        ]
      : [
          ...advisorCards(answer),
          ...advisorReasoningCards(payload)
        ]
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

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return toBase64(bytes);
}

function normalizeSpeech(text) {
  return String(text || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

function looksLikeVoiceCommand(text) {
  return /открой|перейди|вернись|назад|расписани|график|эпикриз|выписк|диагноз|дневник|файл|мед.?запис|медкарта|назначен|первичн|прием|осмотр|сохрани|заверши|отметь|пациент/i.test(String(text || ''));
}

function shouldHandleSpokenText(text, { isFinal = true } = {}) {
  const normalized = normalizeSpeech(text);
  if (!normalized) return false;
  if (!isFinal && !looksLikeVoiceCommand(normalized)) return false;
  const now = Date.now();
  if (normalized === state.lastProcessedSpeechKey && now - state.lastProcessedSpeechAt < 1800) {
    return false;
  }
  state.lastProcessedSpeechKey = normalized;
  state.lastProcessedSpeechAt = now;
  return true;
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

function concatByteArrays(chunks) {
  const totalLength = chunks.reduce((sum, chunk) => sum + (chunk?.length || 0), 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    if (!chunk?.length) continue;
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function pcm16ToWavBytes(pcmBytes, sampleRate = 16000, channels = 1, bitsPerSample = 16) {
  const headerSize = 44;
  const wav = new Uint8Array(headerSize + pcmBytes.length);
  const view = new DataView(wav.buffer);
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;

  wav.set([82, 73, 70, 70], 0); // RIFF
  view.setUint32(4, 36 + pcmBytes.length, true);
  wav.set([87, 65, 86, 69], 8); // WAVE
  wav.set([102, 109, 116, 32], 12); // fmt
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  wav.set([100, 97, 116, 97], 36); // data
  view.setUint32(40, pcmBytes.length, true);
  wav.set(pcmBytes, headerSize);
  return wav;
}

function tokenValue(tokenPayload) {
  return tokenPayload?.token || tokenPayload?.single_use_token || tokenPayload?.access_token || tokenPayload?.jwt || tokenPayload?.key;
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

async function startPcmAudioPump(sendPcmBytes) {
  state.audioContext = new AudioContext();
  state.sourceNode = state.audioContext.createMediaStreamSource(state.mediaStream);

  if (!state.audioContext.audioWorklet || !globalThis.AudioWorkletNode) {
    throw new Error('AudioWorklet недоступен в этом контексте Chrome.');
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

function isAdvisorSupportedContext(screenContext) {
  const screenId = String(screenContext?.screen_id || '').replace(/-/g, '_');
  return (screenId === 'inspection' && screenContext?.selected_appointment_id)
    || (['patient_card', 'patient', 'patient_profile'].includes(screenId) && screenContext?.selected_patient_id);
}

async function fetchAdvisorDirect(question) {
  let screenContext = state.latestScreenContext;
  if (!isAdvisorSupportedContext(screenContext)) {
    const contextResult = await send({ type: 'refresh-context' });
    if (!contextResult.ok) {
      return {
        ok: false,
        error: 'advisor_context_missing',
        message: contextResult.error || 'Не удалось получить медицинский контекст.'
      };
    }
    screenContext = contextResult.screenContext;
    state.latestScreenContext = screenContext;
  }

  if (!isAdvisorSupportedContext(screenContext)) {
    return {
      ok: false,
      screenContext,
      error: 'advisor_context_missing',
      message: 'Откройте карточку пациента или форму приема, чтобы советчик видел медицинский контекст.'
    };
  }

  try {
    const response = await fetch('http://localhost:3030/api/advisor/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appointmentId: screenContext.selected_appointment_id || null,
        question,
        screenContext
      })
    });
    const payload = await response.json();
    if (!response.ok || payload.ok === false) {
      return {
        ok: false,
        screenContext,
        ...payload,
        error: advisorErrorMessage(payload)
      };
    }
    return { ok: true, screenContext, ...payload };
  } catch (error) {
    return {
      ok: false,
      screenContext,
      error: advisorErrorMessage(error)
    };
  }
}

async function askAdvisor(question, { quietUserMessage = false, title = 'Советчик' } = {}) {
  const text = String(question || '').trim();
  if (!text) return { ok: false, error: 'empty_question' };
  if (!quietUserMessage) {
    appendMessage({ role: 'user', title: 'Врач', body: text });
  }
  setStatus('Советчик анализирует прием.');

  const initialResult = await send({ type: 'advisor-analyze', question: text })
    .catch((error) => ({ ok: false, error: advisorErrorMessage(error) }));
  const result = !initialResult.ok && isUnsupportedAdvisorError(initialResult)
    ? await fetchAdvisorDirect(text)
    : initialResult;

  if (!result.ok) {
    showError(new Error(advisorErrorMessage(result)));
    return result;
  }

  renderAdvisorAnswer(result, title);
  setStatus('Советчик подготовил подсказки.');
  return result;
}

async function handleVoiceCommand(text, { fromRecording = false, sttConfidence = null, speakerTag = null } = {}) {
  const spoken = String(text || '').trim();
  if (!spoken) return;
  if (!fromRecording) {
    appendMessage({ role: 'user', title: 'Команда врача', body: spoken });
  }
  setStatus('Выполняю голосовую команду по DOM.');
  const result = await send({
    type: 'voice-command',
    transcript: spoken,
    sttProvider: state.activeProvider || 'manual',
    sttConfidence,
    speakerTag: speakerTag || document.querySelector('#speakerTag').value || 'auto',
    autoExecute: true
  });
  if (!result.ok) {
    appendMessage({
      role: 'assistant',
      title: 'Команда заблокирована',
      body: result.error || result.domExecution?.failed?.reason || result.verification?.reason || 'Голосовая команда не выполнена.',
      tone: 'error',
      cards: commandDebugCards(result.debug || {}, result.commandResult || {})
    });
    setStatus('Голосовая команда заблокирована.');
    return result;
  }

  const finalAction = result.actionPlan?.actionTarget || result.commandResult?.actionTarget || result.commandResult?.intent || 'действие';
  appendMessage({
    role: 'assistant',
    title: 'Команда выполнена',
    body: `Сделано: ${finalAction}.`,
    cards: [
      {
        title: 'Результат',
        text: result.verification?.reason || result.domExecution?.verification?.reason || 'DOM-действие выполнено',
        tags: [
          result.commandResult?.intent || 'voice-command',
          result.commandResult?.confidence != null ? formatConfidence(result.commandResult.confidence) : 'без confidence'
        ]
      },
      ...commandDebugCards(result.debug || {}, result.commandResult || {})
    ]
  });
  if (result.screenContext) {
    state.latestScreenContext = result.screenContext;
  }
  setStatus('Голосовая команда выполнена.');
  return result;
}

async function routeSpokenText(text, { fromRecording = false, sttConfidence = null, speakerTag = null } = {}) {
  const normalized = normalizeSpeech(text);
  if (!normalized) return;
  if (looksLikeVoiceCommand(normalized)) {
    return handleVoiceCommand(text, { fromRecording, sttConfidence, speakerTag });
  }
  return ingestTranscript(text, { fromRecording });
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
      if (!shouldHandleSpokenText(text, { isFinal: true })) continue;
      await routeSpokenText(text, { fromRecording: true, speakerTag: document.querySelector('#speakerTag').value || 'auto' });
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

function extractDeepgramTranscript(payload) {
  return payload?.channel?.alternatives?.[0]?.transcript || '';
}

function deepgramWordConfidence(payload) {
  const words = payload?.channel?.alternatives?.[0]?.words || [];
  const confidences = words.map((word) => Number(word.confidence)).filter((value) => Number.isFinite(value));
  if (!confidences.length) return null;
  return Number((confidences.reduce((sum, value) => sum + value, 0) / confidences.length).toFixed(3));
}

async function startDeepgramRealtime() {
  const configResult = await send({ type: 'get-deepgram-config' });
  if (!configResult.ok) throw new Error(configResult.error || 'Deepgram config недоступен.');
  const config = configResult.config;
  if (!config?.apiKey || !config?.url) throw new Error('Backend не вернул Deepgram realtime config.');
  if (config.realtimeUsable === false) {
    const reason = config.permissionCheck?.reason || 'Deepgram realtime недоступен.';
    throw new Error(`Deepgram realtime недоступен: ${reason}`);
  }

  await openMicrophone();
  const socket = new WebSocket(config.url, ['token', config.apiKey]);
  state.realtimeSocket = socket;
  state.activeProvider = 'deepgram-realtime';
  let lastSocketError = 'Deepgram WebSocket не открылся.';

  socket.onmessage = async (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    const text = extractDeepgramTranscript(payload).trim();
    const isFinal = Boolean(payload.is_final || payload.speech_final || payload.type === 'UtteranceEnd');
    if (!text) return;
    setStatus(`Слышу: ${text}`);
    if (!shouldHandleSpokenText(text, { isFinal })) return;
    chatInputEl.value = text;
    await routeSpokenText(text, {
      fromRecording: true,
      sttConfidence: deepgramWordConfidence(payload),
      speakerTag: document.querySelector('#speakerTag').value || 'auto'
    });
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
  setRecordingUi(true, 'Идет запись через Deepgram realtime.');
}

async function handleOpenAiPcmChunk(pcmBytes) {
  if (!state.isRecording || !pcmBytes?.length) return;
  state.openAiPcmChunks.push(new Uint8Array(pcmBytes));
  const combinedPcm = concatByteArrays(state.openAiPcmChunks);
  const unsentBytes = combinedPcm.length - state.lastOpenAiSubmittedBytes;
  if (state.openAiTranscribeInFlight || combinedPcm.length < 32000 || unsentBytes < 32000) return;
  state.openAiTranscribeInFlight = true;
  try {
    const wavBytes = pcm16ToWavBytes(combinedPcm);
    const result = await send({
      type: 'openai-transcribe-audio',
      audioBase64: toBase64(wavBytes),
      mimeType: 'audio/wav'
    });
    if (!result.ok) throw new Error(result.error || 'OpenAI transcription failed.');
    state.lastOpenAiError = '';
    state.lastOpenAiSubmittedBytes = combinedPcm.length;
    const fullText = String(result.text || '').trim();
    if (!fullText) return;
    const previousText = state.lastOpenAiTranscript;
    const deltaText = previousText && fullText.startsWith(previousText)
      ? fullText.slice(previousText.length).trim()
      : fullText;
    state.lastOpenAiTranscript = fullText;
    if (!deltaText) {
      setStatus(`OpenAI услышал: ${fullText}`);
      return;
    }
    chatInputEl.value = fullText;
    setStatus(`OpenAI услышал: ${deltaText}`);
    if (shouldHandleSpokenText(deltaText, { isFinal: true })) {
      try {
        await routeSpokenText(deltaText, {
          fromRecording: true,
          speakerTag: document.querySelector('#speakerTag').value || 'auto'
        });
      } catch (error) {
        showError(error);
      }
    }
  } catch (error) {
    const message = error.message || 'Не удалось распознать аудио через OpenAI.';
    if (message !== state.lastOpenAiError) {
      state.lastOpenAiError = message;
      appendMessage({
        role: 'assistant',
        title: 'OpenAI STT недоступен',
        body: message,
        tone: 'error'
      });
    }
  } finally {
    state.openAiTranscribeInFlight = false;
  }
}

async function startOpenAiChunkedTranscription() {
  const configResult = await send({ type: 'get-openai-stt-config' });
  if (!configResult.ok || !configResult.config?.apiKeyConfigured) {
    throw new Error('OPENAI_API_KEY не настроен на локальном backend.');
  }
  await openMicrophone();
  state.openAiAudioChunks = [];
  state.openAiPcmChunks = [];
  state.lastOpenAiSubmittedBytes = 0;
  state.lastOpenAiTranscript = '';
  state.lastOpenAiError = '';
  state.activeProvider = 'openai-transcribe';
  await startPcmAudioPump((pcmChunk) => {
    handleOpenAiPcmChunk(pcmChunk).catch((error) => showError(error));
  });
  setRecordingUi(true, `Идет запись через OpenAI ${configResult.config.model || 'transcribe'}.`);
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
    } catch {
      return;
    }
    const text = extractTranscriptFromRealtimeMessage(payload).trim();
    const isFinal = payload.is_final || payload.final || /committed|final/i.test(payload.message_type || payload.type || '');
    if (!text) return;
    chatInputEl.value = text;
    if (!shouldHandleSpokenText(text, { isFinal })) return;
    await routeSpokenText(text, {
      fromRecording: true,
      speakerTag: document.querySelector('#speakerTag').value || 'auto'
    });
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

  await startPcmAudioPump((pcmBytes) => {
    if (!state.isRecording || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      message_type: 'input_audio_chunk',
      audio_base_64: toBase64(pcmBytes),
      sample_rate: 16000
    }));
  });
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
    const openAiConfig = await send({ type: 'get-openai-stt-config' }).catch(() => ({ ok: false }));
    if (openAiConfig.ok && openAiConfig.config?.apiKeyConfigured && openAiConfig.config?.preferred) {
      await startOpenAiChunkedTranscription();
      return;
    }
    try {
      await startDeepgramRealtime();
    } catch (error) {
      appendMessage({ role: 'assistant', title: 'Переключаю запись', body: `${error.message} Перехожу на резервный режим.` });
      await stopRealtimeAudioOnly();
      await startOpenAiChunkedTranscription().catch(async () => {
        await stopRealtimeAudioOnly();
        await startElevenLabsRealtime().catch(async () => {
          await stopRealtimeAudioOnly();
          await startBrowserSpeechFallback();
        });
      });
    }
  } catch (error) {
    setRecordingUi(false, 'Запись не запущена.');
    showError(error);
  }
}

async function stopRealtimeAudioOnly() {
  if (state.mediaRecorder) {
    const recorder = state.mediaRecorder;
    state.mediaRecorder = null;
    if (recorder.state !== 'inactive') {
      recorder.stop();
    }
  }
  state.openAiTranscribeInFlight = false;
  state.openAiAudioChunks = [];
  state.openAiPcmChunks = [];
  state.lastOpenAiSubmittedBytes = 0;
  state.lastOpenAiTranscript = '';
  state.lastOpenAiError = '';
  if (state.processorNode) {
    state.processorNode.disconnect();
    if (state.processorNode.port) state.processorNode.port.onmessage = null;
    if ('onaudioprocess' in state.processorNode) state.processorNode.onaudioprocess = null;
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
  try {
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
    await routeSpokenText(text, { fromRecording: false, speakerTag: document.querySelector('#speakerTag').value || 'auto' });
    chatInputEl.value = '';
  } catch (error) {
    showError(error);
  }
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
  document.body.dataset.buildId = EXTENSION_BUILD_ID;
  appendMessage({
    role: 'assistant',
    title: 'Готов к приему',
    body: 'Я буду показывать только понятные подсказки: что услышал, что можно заполнить и какой следующий шаг проверить врачу.',
    cards: [{ title: 'Версия расширения', text: EXTENSION_BUILD_ID }]
  });
  refreshContext({ silent: true }).catch(showError);
}

init();
