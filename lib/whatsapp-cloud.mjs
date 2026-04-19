import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns';
import { Agent } from 'undici';
import { analyzeIntake } from './intake-analyzer.mjs';

const ATTACHMENTS_PROMPT = 'Хотите приложить фото или документы для врача? Отправьте их сейчас. Если вложений нет или вы уже отправили все файлы, напишите "нет" или "готово".';
const ATTACHMENT_DONE_WORDS = new Set(['нет', 'не', 'no', 'готово', 'готов', 'готова', 'все', 'всё', 'пропустить', 'skip']);

const QUESTION_FLOW = [
  { step: 'iin', field: 'iin', prompt: 'Напишите ИИН пациента.' },
  { step: 'fio', field: 'patient_fio', prompt: 'Напишите ФИО пациента полностью.' },
  { step: 'phone', field: 'phone', prompt: 'Напишите контактный номер телефона.' },
  { step: 'complaint', field: 'main_complaint', prompt: 'Опишите основную жалобу: что сейчас беспокоит ребенка?' },
  { step: 'onset', prompt: 'Когда это началось и что изменилось за последние 1-3 месяца?' },
  { step: 'context', prompt: 'Где это проявляется сильнее: дома, в саду или школе, на занятиях или в новых местах?' },
  { step: 'skills', prompt: 'Как сейчас с речью, пониманием инструкций, игрой, вниманием и обучением?' },
  { step: 'sleep_behavior', prompt: 'Как со сном, аппетитом, утомляемостью, истериками, агрессией или тревожностью?' },
  { step: 'helps', prompt: 'Что помогает ребенку успокоиться, удержать внимание или выполнить задание?' },
  { step: 'red_flags', prompt: 'Есть ли резкое ухудшение, регресс навыков, судороги, самоповреждение или опасное поведение?' }
  , { step: 'attachments', prompt: ATTACHMENTS_PROMPT }
];

function getConfig() {
  return {
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || 'damumed-local-whatsapp',
    graphApiVersion: process.env.WHATSAPP_GRAPH_API_VERSION || 'v20.0'
  };
}

function isConfigured() {
  const config = getConfig();
  return Boolean(config.accessToken && config.phoneNumberId);
}

function graphUrl(target) {
  return `https://graph.facebook.com/${getConfig().graphApiVersion}/${target}`;
}

const graphResolver = new dns.Resolver();
graphResolver.setServers([(process.env.GRAPH_API_DNS_SERVER || '1.1.1.1')]);
let graphAddressCache = null;
const GRAPH_API_FORCE_IP = process.env.GRAPH_API_FORCE_IP || '31.13.72.8';

const graphDispatcher = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      if (typeof options === 'function') {
        callback = options;
        options = {};
      }
      if (typeof callback !== 'function') {
        if (hostname === 'graph.facebook.com') {
          return graphResolver.resolve4(hostname).then((addresses) => ({
            address: addresses[0],
            family: 4
          }));
        }
        return dns.promises.lookup(hostname, options || {});
      }
      if (hostname !== 'graph.facebook.com') {
        dns.lookup(hostname, options, callback);
        return;
      }

      const useAddress = (address) => {
        if (options?.all) callback(null, [{ address, family: 4 }]);
        else callback(null, address, 4);
      };

      if (GRAPH_API_FORCE_IP) {
        useAddress(GRAPH_API_FORCE_IP);
        return;
      }

      if (graphAddressCache) {
        useAddress(graphAddressCache);
        return;
      }

      graphResolver.resolve4(hostname)
        .then((addresses) => {
          graphAddressCache = addresses[0] || '';
          if (!graphAddressCache) throw new Error('graph.facebook.com DNS lookup returned no A records.');
          useAddress(graphAddressCache);
        })
        .catch(() => dns.lookup(hostname, options, callback));
    }
  }
});

function currentQuestion(step) {
  return QUESTION_FLOW.find((item) => item.step === step) || QUESTION_FLOW[0];
}

function nextQuestion(step) {
  const index = QUESTION_FLOW.findIndex((item) => item.step === step);
  return QUESTION_FLOW[index + 1] || null;
}

function findDoctorInText(store, text) {
  const source = String(text || '');
  return (store.listDoctors?.() || []).find((doctor) => doctor.qr_token && source.includes(doctor.qr_token)) || null;
}

function stripDoctorToken(text, token = '') {
  return String(text || '').replace(token, '').trim();
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

function parseOneShotIntake(text, token = '') {
  const source = stripDoctorToken(text, token);
  const fields = {};

  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^([^:：-]{2,42})[:：-]\s*(.+)$/);
    if (!match) continue;
    const label = match[1].toLowerCase();
    const value = match[2].trim();
    if (!value) continue;

    if (/фио|имя|пациент|ребен|ребён|name/.test(label)) fields.patient_fio ||= value;
    else if (/иин|iin/.test(label)) fields.iin ||= value;
    else if (/тел|phone|номер/.test(label)) fields.phone ||= value;
    else if (/жалоб|проблем|complaint/.test(label)) fields.main_complaint ||= value;
  }

  fields.patient_fio ||= firstMatch(source, [
    /(?:фио|имя пациента|пациент)\s*[:：-]\s*([^\n]+)/i
  ]);
  fields.iin ||= firstMatch(source, [
    /(?:иин|iin)\s*[:：-]\s*([0-9\s-]{10,20})/i,
    /\b(\d{12})\b/
  ]);
  fields.phone ||= firstMatch(source, [
    /(?:телефон|номер|phone)\s*[:：-]\s*([+0-9\s()-]{7,24})/i
  ]);
  fields.main_complaint ||= firstMatch(source, [
    /(?:жалоба|проблема|что беспокоит)\s*[:：-]\s*([^\n]+)/i
  ]);

  const hasCore = Boolean(fields.patient_fio && fields.iin && fields.phone && fields.main_complaint);
  return { hasCore, fields, rawText: source };
}

async function safeSendWhatsAppMessage(to, text) {
  try {
    return await sendWhatsAppMessage(to, text);
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function extFromMime(mimeType) {
  if (/jpeg|jpg/i.test(mimeType)) return '.jpg';
  if (/png/i.test(mimeType)) return '.png';
  if (/pdf/i.test(mimeType)) return '.pdf';
  if (/webp/i.test(mimeType)) return '.webp';
  return '.bin';
}

async function graphRequest(target, { method = 'GET', body, headers = {} } = {}) {
  const config = getConfig();
  if (!config.accessToken) {
    throw new Error('WHATSAPP_ACCESS_TOKEN is not configured.');
  }

  const response = await fetch(graphUrl(target), {
    method,
    dispatcher: graphDispatcher,
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
      ...headers
    },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const responseText = await response.text();
  let payload;
  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch {
    throw new Error(`Graph API returned non-JSON response: ${responseText.slice(0, 180)}`);
  }
  if (!response.ok) {
    throw new Error(payload.error?.message || `Graph API request failed: ${response.status}`);
  }
  return payload;
}

export function verifyWhatsAppWebhook(searchParams) {
  const mode = searchParams.get('hub.mode') || '';
  const token = searchParams.get('hub.verify_token') || '';
  const challenge = searchParams.get('hub.challenge') || '';
  const expected = getConfig().verifyToken;

  if (mode === 'subscribe' && token && token === expected) {
    return { ok: true, challenge };
  }

  return { ok: false, challenge: '' };
}

export async function sendWhatsAppMessage(to, text) {
  if (!isConfigured()) {
    return { ok: true, skipped: true, reason: 'WHATSAPP_ACCESS_TOKEN is not configured.' };
  }
  return graphRequest(`${getConfig().phoneNumberId}/messages`, {
    method: 'POST',
    body: {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    }
  });
}

export async function sendWhatsAppTemplate(to, templateName = 'hello_world', languageCode = 'en_US', components = []) {
  if (!isConfigured()) {
    return { ok: true, skipped: true, reason: 'WHATSAPP_ACCESS_TOKEN is not configured.' };
  }
  const template = {
    name: templateName,
    language: { code: languageCode }
  };
  if (components.length) {
    template.components = components;
  }
  return graphRequest(`${getConfig().phoneNumberId}/messages`, {
    method: 'POST',
    body: {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template
    }
  });
}

export async function downloadWhatsAppMedia(mediaId, targetDir, fallbackContent = '', mimeType = '') {
  await fs.mkdir(targetDir, { recursive: true });

  if (!isConfigured()) {
    const localPath = path.join(targetDir, `${mediaId || 'mock-media'}${extFromMime(mimeType || 'text/plain')}`);
    await fs.writeFile(localPath, fallbackContent || 'Mock WhatsApp media placeholder', mimeType.startsWith('image/') ? undefined : 'utf8');
    return { localPath, mimeType: mimeType || 'text/plain' };
  }

  const meta = await graphRequest(mediaId);
  const response = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${getConfig().accessToken}` }
  });
  if (!response.ok) {
    throw new Error(`Failed to download WhatsApp media: ${response.status}`);
  }

  const resolvedMimeType = meta.mime_type || mimeType || response.headers.get('content-type') || '';
  const localPath = path.join(targetDir, `${mediaId}${extFromMime(resolvedMimeType)}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(localPath, bytes);
  return { localPath, mimeType: resolvedMimeType };
}

async function finishIntake(store, intake) {
  const fresh = store.getIntake(intake.intake_id);
  const analysis = await analyzeIntake(fresh);
  store.updateIntake(fresh.intake_id, {
    status: 'new',
    conversation_step: 'done',
    analysis_json: JSON.stringify(analysis.answer),
    analysis_text: analysis.analysis_text
  });
  return [
    'Спасибо. Я сохранил обращение для врача.',
    'Когда придете на прием, врач увидит summary и вложения в расширении.',
    'Это предварительная анкета, а не диагноз.'
  ].join('\n');
}

async function processText({ store, intake, text }) {
  const question = currentQuestion(intake.conversation_step);
  const oneShot = parseOneShotIntake(text);

  if (oneShot.hasCore) {
    store.updateIntake(intake.intake_id, {
      ...oneShot.fields,
      conversation_step: 'attachments'
    });
    store.appendMessage(intake.intake_id, 'patient', oneShot.rawText || text);
    return finishIntake(store, store.getIntake(intake.intake_id));
  }

  if (question.step === 'attachments') {
    store.appendMessage(intake.intake_id, 'patient', text);
    const normalized = String(text || '').trim().toLowerCase();
    const readableDoneWords = ['нет', 'не', 'no', 'готово', 'готов', 'готова', 'все', 'всё', 'пропустить', 'skip'];
    if (ATTACHMENT_DONE_WORDS.has(normalized) || readableDoneWords.includes(normalized)) {
      return finishIntake(store, intake);
    }
    return 'Если хотите, отправьте фото или документ. Если вложений больше нет, напишите "готово" или "нет".';
  }

  if (question.field) {
    store.updateIntake(intake.intake_id, { [question.field]: text });
  }
  store.appendMessage(intake.intake_id, 'patient', text);
  const next = nextQuestion(question.step);
  if (!next) {
    return finishIntake(store, intake);
  }
  store.updateIntake(intake.intake_id, { conversation_step: next.step });
  return next.prompt;
}

function contactNameFor(value, waId) {
  const contact = (value?.contacts || []).find((item) => item.wa_id === waId) || value?.contacts?.[0] || null;
  return contact?.profile?.name || contact?.wa_id || '';
}

function mediaDescriptor(message) {
  if (message?.image?.id) {
    return {
      mediaId: message.image.id,
      mimeType: message.image.mime_type || 'image/jpeg',
      caption: message.image.caption || ''
    };
  }
  if (message?.document?.id) {
    return {
      mediaId: message.document.id,
      mimeType: message.document.mime_type || '',
      caption: message.document.caption || ''
    };
  }
  return null;
}

async function handleIncomingMessage({ store, value, message, uploadRoot }) {
  const waId = String(message?.from || '');
  const contactName = contactNameFor(value, waId);
  const text = String(message?.text?.body || '').trim();
  const media = mediaDescriptor(message);
  const replies = [];

  if (text) {
    const doctor = store.getDoctorByToken(text) || findDoctorInText(store, text);
    if (doctor) {
      const intake = store.createOrActivateDoctorIntake({
        waId,
        contactName,
        doctorId: doctor.doctor_id
      });
      const oneShot = parseOneShotIntake(text, doctor.qr_token);
      if (oneShot.hasCore) {
        store.updateIntake(intake.intake_id, {
          ...oneShot.fields,
          conversation_step: 'attachments'
        });
        store.appendMessage(intake.intake_id, 'patient', oneShot.rawText || text);
        const reply = await finishIntake(store, store.getIntake(intake.intake_id));
        replies.push(reply);
        await safeSendWhatsAppMessage(waId, reply);
        return { ok: true, intake: store.getIntake(intake.intake_id), replies, one_shot: true };
      }
      const prompt = currentQuestion(intake.conversation_step).prompt;
      replies.push(prompt);
      await safeSendWhatsAppMessage(waId, prompt);
      return { ok: true, intake, replies };
    }
  }

  let intake = store.getActiveIntakeByWhatsAppUser(waId);

  if (media) {
    intake ||= store.getLatestIntakeByWhatsAppUser(waId);
    if (!intake) {
      const reply = 'Сначала откройте чат по QR врача и отправьте подготовленное сообщение.';
      replies.push(reply);
      await safeSendWhatsAppMessage(waId, reply);
      return { ok: false, replies, error: 'doctor_token_required' };
    }
    const targetDir = path.join(uploadRoot, intake.intake_id);
    const downloaded = await downloadWhatsAppMedia(media.mediaId, targetDir, media.caption, media.mimeType);
    store.saveAttachment({
      intakeId: intake.intake_id,
      whatsappMediaId: media.mediaId,
      localPath: downloaded.localPath,
      caption: media.caption,
      mimeType: downloaded.mimeType || media.mimeType
    });
    store.appendMessage(intake.intake_id, 'patient', media.caption || 'Пациент отправил вложение.');
    const latest = store.getIntake(intake.intake_id);
    const mediaReply = latest.conversation_step === 'attachments'
      ? 'Файл сохранён. Можно отправить ещё фото/документы или написать "готово".'
      : `Файл сохранён. Продолжим анкету.\n\n${currentQuestion(latest.conversation_step).prompt}`;
    replies.push(mediaReply);
    await safeSendWhatsAppMessage(waId, mediaReply);
    return { ok: true, intake: latest, replies };
    /*
    store.appendMessage(intake.intake_id, 'patient', media.caption || 'Пациент отправил вложение.');
    const reply = 'Фото или файл сохранен. Врач увидит его вместе с summary.';
    replies.push(reply);
    await safeSendWhatsAppMessage(waId, reply);
    return { ok: true, intake: store.getIntake(intake.intake_id), replies };
    */
  }

  if (!intake) {
    const reply = 'Сначала отсканируйте QR врача и отправьте подготовленное сообщение в WhatsApp.';
    replies.push(reply);
    await safeSendWhatsAppMessage(waId, reply);
    return { ok: false, replies, error: 'doctor_token_required' };
  }

  if (!text) {
    const prompt = currentQuestion(intake.conversation_step).prompt;
    replies.push(prompt);
    await safeSendWhatsAppMessage(waId, prompt);
    return { ok: true, intake, replies };
  }

  const reply = await processText({ store, intake, text });
  replies.push(reply);
  await safeSendWhatsAppMessage(waId, reply);
  return { ok: true, intake: store.getIntake(intake.intake_id), replies };
}

export async function handleWhatsAppWebhook({ store, body, uploadRoot }) {
  const processed = [];

  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value || {};
      for (const message of value?.messages || []) {
        processed.push(await handleIncomingMessage({ store, value, message, uploadRoot }));
      }
    }
  }

  return { ok: true, processed };
}
