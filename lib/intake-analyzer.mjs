const FALLBACK_NOTE = 'Это предварительная структуризация жалоб для врача, не диагноз и не назначение лечения.';

function getOpenRouterConfig() {
  return {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    model: process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
    endpoint: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1/chat/completions',
    appTitle: process.env.OPENROUTER_APP_TITLE || 'Damumed Sandbox Agent',
    appReferer: process.env.OPENROUTER_APP_REFERER || 'http://localhost:3030'
  };
}

function compactMessages(intake) {
  return (intake.messages || [])
    .slice(-18)
    .map((message) => `${message.role}: ${message.text}`)
    .join('\n');
}

function detectRedFlags(text) {
  const source = String(text || '').toLowerCase();
  const flags = [];
  if (/судорог|теряет сознание|обморок/.test(source)) flags.push('Судороги, потеря сознания или обмороки требуют срочной очной оценки.');
  if (/суицид|самоповреж|наносит себе/.test(source)) flags.push('Риск самоповреждения или суицидальные высказывания нужно уточнить немедленно.');
  if (/агресс|опасен|бьет|дерется/.test(source)) flags.push('Выраженная агрессия или риск для окружающих требует оценки безопасности.');
  if (/резко|внезапно|регресс|перестал говорить/.test(source)) flags.push('Резкий регресс навыков или внезапное ухудшение нужно уточнить отдельно.');
  return flags;
}

function attachmentSummary(files = []) {
  if (!files.length) {
    return 'Фото или файлы не приложены.';
  }

  const details = files.map((file, index) => {
    const parts = [
      file.caption ? `подпись: ${file.caption}` : '',
      file.mime_type ? `тип: ${file.mime_type}` : '',
      file.local_path ? `файл: ${file.local_path}` : ''
    ].filter(Boolean);
    return `${index + 1}) ${parts.join(', ') || 'файл без подписи'}`;
  }).join('; ');

  return `Пациент приложил ${files.length} файл(а): ${details}. Фото/документы нужно посмотреть врачу вручную; vision-анализ в этой версии не выполняется.`;
}

function buildFallbackAnalysis(intake) {
  const messageText = compactMessages(intake);
  const redFlags = detectRedFlags(`${intake.main_complaint || ''}\n${messageText}`);
  const legacyAttachmentsNote = intake.files?.length
    ? `Пациент приложил ${intake.files.length} файл(а). Фото нужно посмотреть врачу вручную.`
    : 'Фото или файлы не приложены.';

  void legacyAttachmentsNote;
  const attachmentsNote = attachmentSummary(intake.files || []);

  const answer = {
    summary: [
      intake.patient_fio ? `Пациент: ${intake.patient_fio}.` : '',
      intake.iin ? `ИИН: ${intake.iin}.` : '',
      intake.phone ? `Телефон: ${intake.phone}.` : '',
      intake.main_complaint ? `Основная жалоба: ${intake.main_complaint}.` : 'Основная жалоба требует уточнения.'
    ].filter(Boolean).join(' '),
    possible_problem_area: 'Детская психология: развитие, поведение, внимание, речь и адаптация.',
    differential_hypotheses: [
      {
        name: 'Трудности регуляции внимания и поведения',
        why_consider: 'Есть жалобы, которые требуют уточнения устойчивости внимания, утомляемости и реакции на инструкции.',
        what_to_check: ['длительность концентрации', 'импульсивность', 'поведение дома и на занятиях']
      },
      {
        name: 'Задержка или неравномерность развития навыков',
        why_consider: 'Для детской психологии важно сопоставить речь, игру, обучение и бытовые навыки.',
        what_to_check: ['речь и понимание инструкции', 'игровые навыки', 'динамика за последние месяцы']
      }
    ],
    questions_for_doctor: [
      'Когда впервые заметили проблему и что изменилось за последние 1-3 месяца?',
      'В каких ситуациях симптом выражен сильнее: дома, в саду/школе, на занятиях?',
      'Что помогает ребенку успокоиться, удержать внимание или выполнить инструкцию?',
      'Есть ли резкое ухудшение, регресс навыков, нарушения сна или опасное поведение?'
    ],
    red_flags: redFlags,
    doctor_focus: [
      'Сверить жалобу родителя с наблюдением ребенка на приеме.',
      'Отделить факты от интерпретаций и уточнить частоту/длительность проявлений.',
      'Не формулировать окончательный диагноз только по WhatsApp-анкетированию.'
    ],
    attachments_note: attachmentsNote,
    doctor_note: FALLBACK_NOTE
  };

  return {
    provider: { type: 'heuristic', error: null },
    answer,
    analysis_text: [
      answer.summary,
      `Возможная область: ${answer.possible_problem_area}`,
      `Что уточнить врачу: ${answer.questions_for_doctor.join(' ')}`,
      redFlags.length ? `Красные флаги: ${redFlags.join(' ')}` : 'Красные флаги по анкете не выявлены, но их нужно уточнить очно.',
      attachmentsNote,
      FALLBACK_NOTE
    ].join('\n')
  };
}

function parseJsonObject(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  return JSON.parse(candidate);
}

async function analyzeWithOpenRouter(intake, fallback) {
  const config = getOpenRouterConfig();
  if (!config.apiKey) {
    return {
      ...fallback,
      provider: { type: 'heuristic', error: 'OPENROUTER_API_KEY is not configured on the local backend.' }
    };
  }

  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': config.appReferer,
      'X-Title': config.appTitle
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: 'system',
          content: [
            'Answer in Russian.',
            'You structure WhatsApp pre-intake for a child psychology doctor.',
            'Never provide a final diagnosis or treatment plan.',
            'Use cautious differential hypotheses and questions for the doctor.',
            'Return only JSON with keys: summary, possible_problem_area, differential_hypotheses, questions_for_doctor, red_flags, doctor_focus, attachments_note, doctor_note.'
          ].join(' ')
        },
        {
          role: 'user',
          content: JSON.stringify({
            patient: {
              fio: intake.patient_fio,
              iin: intake.iin,
              phone: intake.phone,
              main_complaint: intake.main_complaint
            },
            messages: intake.messages || [],
            files: (intake.files || []).map((file) => ({
              caption: file.caption,
              mime_type: file.mime_type,
              local_path: file.local_path
            }))
          })
        }
      ],
      temperature: 0.2
    })
  });

  if (!response.ok) {
    return {
      ...fallback,
      provider: { type: 'openrouter', error: await response.text() }
    };
  }

  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content || '';
  try {
    const answer = parseJsonObject(content);
    return {
      provider: { type: 'openrouter', error: null },
      answer,
      analysis_text: [
        answer.summary,
        answer.possible_problem_area ? `Возможная область: ${answer.possible_problem_area}` : '',
        Array.isArray(answer.questions_for_doctor) ? `Что уточнить врачу: ${answer.questions_for_doctor.join(' ')}` : '',
        Array.isArray(answer.red_flags) && answer.red_flags.length ? `Красные флаги: ${answer.red_flags.join(' ')}` : '',
        answer.attachments_note || '',
        answer.doctor_note || FALLBACK_NOTE
      ].filter(Boolean).join('\n')
    };
  } catch {
    return {
      ...fallback,
      provider: { type: 'openrouter', error: 'OpenRouter returned non-JSON intake analysis.' }
    };
  }
}

export async function analyzeIntake(intake) {
  const fallback = buildFallbackAnalysis(intake);
  return analyzeWithOpenRouter(intake, fallback);
}
