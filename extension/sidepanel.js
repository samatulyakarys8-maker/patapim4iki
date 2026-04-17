const screenContextEl = document.querySelector('#screenContext');
const transcriptOutputEl = document.querySelector('#transcriptOutput');
const draftOutputEl = document.querySelector('#draftOutput');
const actionOutputEl = document.querySelector('#actionOutput');
const transcriptInputEl = document.querySelector('#transcriptInput');
const recordingStateEl = document.querySelector('#recordingState');
const globalStatusEl = document.querySelector('#globalStatus');
const startRecordingEl = document.querySelector('#startRecording');
const stopRecordingEl = document.querySelector('#stopRecording');

const state = {
  recognition: null,
  isRecording: false,
  currentSession: null,
  mediaStream: null,
  audioContext: null,
  sourceNode: null,
  processorNode: null,
  realtimeSocket: null,
  activeProvider: null
};

async function send(message) {
  if (!globalThis.chrome?.runtime?.sendMessage) {
    throw new Error('Side panel открыт не как Chrome Extension. Откройте его через иконку расширения на вкладке http://localhost:3030.');
  }
  return chrome.runtime.sendMessage(message);
}

function renderResult(element, result) {
  element.textContent = JSON.stringify(result, null, 2);
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

function tokenValue(tokenPayload) {
  return tokenPayload?.token || tokenPayload?.single_use_token || tokenPayload?.access_token || tokenPayload?.jwt || tokenPayload?.key;
}

async function refreshContext() {
  try {
    globalStatusEl.textContent = 'Определяю текущий экран.';
    const result = await send({ type: 'refresh-context' });
    renderResult(screenContextEl, result.ok ? (result.screenContext || result) : result);
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
  if (result.ok) {
    renderResult(screenContextEl, result.screenContext || {});
  }
}

async function applyPreview() {
  const result = await send({ type: 'apply-preview' });
  renderResult(actionOutputEl, result.ok ? (result.result || result) : result);
  if (result.ok) {
    await loadDraft();
  }
}

async function ingestTranscript(textOverride = null) {
  const text = (textOverride ?? transcriptInputEl.value).trim();
  const speakerTag = document.querySelector('#speakerTag').value;
  if (!text) {
    renderResult(transcriptOutputEl, { ok: false, error: 'Добавьте текст транскрипта или запустите запись.' });
    return;
  }
  const result = await send({ type: 'ingest-transcript', text, speakerTag });
  renderResult(transcriptOutputEl, result.ok ? {
    chunk: result.transcript?.chunk,
    parser: result.transcript?.parser,
    draftPatches: result.transcript?.draftPatches || [],
    hints: result.transcript?.hints || []
  } : result);
  if (result.ok) {
    renderResult(draftOutputEl, {
      draftStatus: result.transcript?.draftState?.draft_status,
      transcriptChunks: result.transcript?.draftState?.transcript_chunks || [],
      draftPatches: result.transcript?.draftState?.draft_patches || []
    });
    renderResult(screenContextEl, result.screenContext || {});
  }
}

async function saveInspection() {
  const result = await send({ type: 'save-inspection' });
  renderResult(actionOutputEl, result.ok ? (result.result || result) : result);
  await refreshContext();
}

async function saveCloseInspection() {
  const result = await send({ type: 'save-close-inspection' });
  renderResult(actionOutputEl, result.ok ? (result.result || result) : result);
  await refreshContext();
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
      transcriptInputEl.value = text;
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
    } catch (error) {
      return;
    }
    const text = extractTranscriptFromRealtimeMessage(payload).trim();
    const isFinal = payload.is_final || payload.final || /committed|final/i.test(payload.message_type || payload.type || '');
    if (!text) return;
    transcriptInputEl.value = text;
    renderResult(transcriptOutputEl, { provider: state.activeProvider, realtimeEvent: payload });
    if (isFinal) await ingestTranscript(text);
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
  setRecordingUi(true, 'Идет запись через ElevenLabs realtime STT.');
}

async function startRecording() {
  setRecordingUi(true, 'Кнопка нажата. Проверяю экран и запускаю запись.');
  try {
    const result = await send({ type: 'start-live-session' });
    if (!result.ok) {
      renderResult(actionOutputEl, result);
      return;
    }
    state.currentSession = result.session;
    setRecordingUi(true, 'Подключаю realtime STT.');
    try {
      await startElevenLabsRealtime();
    } catch (error) {
      renderResult(actionOutputEl, { ok: false, provider: 'elevenlabs-realtime', error: error.message, fallback: 'browser-web-speech' });
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

document.querySelector('#refreshContext').addEventListener('click', refreshContext);
document.querySelector('#loadDraft').addEventListener('click', loadDraft);
document.querySelector('#applyPreview').addEventListener('click', applyPreview);
document.querySelector('#ingestTranscript').addEventListener('click', () => ingestTranscript());
document.querySelector('#saveInspection').addEventListener('click', saveInspection);
document.querySelector('#saveCloseInspection').addEventListener('click', saveCloseInspection);
document.querySelector('#startRecording').addEventListener('click', startRecording);
document.querySelector('#stopRecording').addEventListener('click', stopRecording);
document.querySelector('#exampleDoctor').addEventListener('click', () => {
  document.querySelector('#speakerTag').value = 'doctor';
  transcriptInputEl.value = 'Врач: рекомендую продолжить индивидуальные занятия, положительная динамика по игровым навыкам, контакт устанавливает с трудом, внимание недостаточно устойчивое.';
});
document.querySelector('#exampleCaregiver').addEventListener('click', () => {
  document.querySelector('#speakerTag').value = 'caregiver';
  transcriptInputEl.value = 'Родитель: дома ребенок лучше удерживает внимание, но быстро устает, частично понимает инструкцию и нуждается в повторении.';
});

refreshContext().catch(showError);
