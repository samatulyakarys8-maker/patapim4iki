function normalizeText(input) {
  return String(input || '').toLowerCase().trim();
}

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function compactText(input) {
  return String(input || '').replace(/\s+/g, ' ').trim();
}

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getOpenRouterConfig() {
  return {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    model: process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
    endpoint: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1/chat/completions',
    appTitle: process.env.OPENROUTER_APP_TITLE || 'Damumed Sandbox Agent',
    appReferer: process.env.OPENROUTER_APP_REFERER || 'http://localhost:3030'
  };
}

function speakerWeight(fieldKey, speakerTag) {
  const doctorFields = new Set(['tbmedicalfinal', 'recommendations', 'dynamics', 'work-plan']);
  const caregiverFields = new Set(['dynamics', 'planned-sessions', 'completed-sessions']);
  const patientFields = new Set(['tbmedicalfinal']);

  if (speakerTag === 'doctor' && doctorFields.has(fieldKey)) return 0.12;
  if (speakerTag === 'caregiver' && caregiverFields.has(fieldKey)) return 0.1;
  if (speakerTag === 'patient' && patientFields.has(fieldKey)) return 0.08;
  if (speakerTag === 'unknown') return -0.08;
  return 0;
}

function makeIntent(type, screenId, targetEntity, argumentsPayload = {}) {
  return {
    intent_id: makeId(type),
    type,
    screen_id: screenId,
    target_entity: targetEntity,
    arguments: argumentsPayload,
    requires_preview: true,
    safe_to_apply: true
  };
}

export function inferScreenId(screenContext) {
  if (screenContext?.screen_id) return screenContext.screen_id;
  if (screenContext?.visible_actions?.some((action) => /сохранить/i.test(action))) return 'inspection';
  return 'schedule';
}

export function getAppointmentById(runtime, appointmentId) {
  return runtime.appointments[appointmentId] || null;
}

export function getPatientById(runtime, patientId) {
  return runtime.patients.find((patient) => patient.patient_id === patientId) || null;
}

export function searchPatients(runtime, query) {
  const normalized = normalizeText(query);
  if (!normalized) return runtime.patients;
  return runtime.patients.filter((patient) => {
    return normalizeText(patient.full_name).includes(normalized) || String(patient.iin_or_local_id).includes(normalized);
  });
}

function buildSectionPatch(section, values, provenance = 'transcript_chunk', confidence = 0.78) {
  return {
    patch_id: makeId(section.section_key),
    section_key: section.section_key,
    field_key: section.section_key,
    title: section.title,
    value_type: section.kind,
    value: section.kind === 'checkbox-group' ? values : compactText(values),
    provenance,
    confidence,
    status: 'suggested'
  };
}

function buildFieldPatch(fieldKey, value, provenance, confidence) {
  return {
    patch_id: makeId(fieldKey),
    field_key: fieldKey,
    value_type: 'text',
    value: compactText(value),
    provenance,
    confidence,
    status: 'suggested'
  };
}

function optionMatch(optionLabel, text) {
  const raw = normalizeText(optionLabel)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return raw && normalizeText(text).includes(raw);
}

function findSection(appointment, pattern) {
  return appointment.inspection_draft.medical_record_sections.find((section) => pattern.test(normalizeText(section.title)));
}

function inferStructuredSectionPatches(appointment, text, speakerTag) {
  const lower = normalizeText(text);
  const sections = appointment.inspection_draft.medical_record_sections;
  const patches = [];

  for (const section of sections) {
    if (section.kind !== 'checkbox-group') continue;
    const matchedOptions = section.options.filter((option) => optionMatch(option.label, lower));
    if (matchedOptions.length) {
      patches.push(buildSectionPatch(section, matchedOptions.map((option) => option.option_key), 'transcript_chunk', 0.72 + speakerWeight(section.section_key, speakerTag)));
    }
  }

  const contactSection = findSection(appointment, /контакт|қарым/);
  if (contactSection) {
    if (/не вступает в контакт|контакт не устанавливает/.test(lower)) {
      const option = contactSection.options.find((item) => /не вступает/i.test(item.label));
      if (option) patches.push(buildSectionPatch(contactSection, [option.option_key], 'transcript_chunk', 0.86));
    } else if (/контакт с трудом|не сразу вступает|контакт затруднен/.test(lower)) {
      const option = contactSection.options.find((item) => /не сразу|с трудом/i.test(item.label));
      if (option) patches.push(buildSectionPatch(contactSection, [option.option_key], 'transcript_chunk', 0.84));
    } else if (/контакт установлен|устанавливает контакт|идет на контакт/.test(lower)) {
      const option = contactSection.options.find((item) => /устанавливает контакт/i.test(item.label));
      if (option) patches.push(buildSectionPatch(contactSection, [option.option_key], 'transcript_chunk', 0.86));
    }
  }

  const attentionSection = findSection(appointment, /внимани|зейін/);
  if (attentionSection) {
    if (/низк.*концентрац|не удерживает внимание/.test(lower)) {
      const option = attentionSection.options.find((item) => /низкая концентрация/i.test(item.label));
      if (option) patches.push(buildSectionPatch(attentionSection, [option.option_key], 'transcript_chunk', 0.84));
    } else if (/внимание неустойчив|поверхностн|быстро устает/.test(lower)) {
      const option = attentionSection.options.find((item) => /недостаточно устойчив/i.test(item.label));
      if (option) patches.push(buildSectionPatch(attentionSection, [option.option_key], 'transcript_chunk', 0.84));
    } else if (/внимание устойчив|достаточно устойчив/.test(lower)) {
      const option = attentionSection.options.find((item) => /достаточно устойчив/i.test(item.label));
      if (option) patches.push(buildSectionPatch(attentionSection, [option.option_key], 'transcript_chunk', 0.84));
    }
  }

  const memorySection = findSection(appointment, /памят|есте/);
  if (memorySection) {
    if (/память сниж|забывчив/.test(lower)) {
      const option = memorySection.options.find((item) => /снижена/i.test(item.label));
      if (option) patches.push(buildSectionPatch(memorySection, [option.option_key], 'transcript_chunk', 0.82));
    } else if (/память в норме|возрастной норм/.test(lower)) {
      const option = memorySection.options.find((item) => /возрастной нормы/i.test(item.label));
      if (option) patches.push(buildSectionPatch(memorySection, [option.option_key], 'transcript_chunk', 0.82));
    }
  }

  const speechSection = findSection(appointment, /речевая|сөйлеу/);
  if (speechSection) {
    if (/речь отсутствует/.test(lower)) {
      const option = speechSection.options.find((item) => /отсутствует/i.test(item.label));
      if (option) patches.push(buildSectionPatch(speechSection, [option.option_key], 'transcript_chunk', 0.82));
    } else if (/речь наруш|нарушена речь/.test(lower)) {
      const option = speechSection.options.find((item) => /нарушена/i.test(item.label));
      if (option) patches.push(buildSectionPatch(speechSection, [option.option_key], 'transcript_chunk', 0.82));
    } else if (/речь в норме/.test(lower)) {
      const option = speechSection.options.find((item) => /норма/i.test(item.label));
      if (option) patches.push(buildSectionPatch(speechSection, [option.option_key], 'transcript_chunk', 0.82));
    }
  }

  const deduped = new Map();
  for (const patch of patches) {
    const key = patch.section_key || patch.field_key;
    const current = deduped.get(key);
    if (!current || current.confidence <= patch.confidence) {
      deduped.set(key, patch);
    }
  }
  return [...deduped.values()];
}

function inferFactCandidates(appointment, text, speakerTag) {
  const lower = normalizeText(text);
  const facts = [];

  if (/рекомен|совет|домашн|продолжить занятия|продолжить индивидуальные/.test(lower)) {
    facts.push({
      fact_id: makeId('fact-recommendations'),
      source_type: 'transcript_chunk',
      speaker_tag: speakerTag,
      field_key: 'recommendations',
      normalized_value: compactText(text),
      raw_evidence: text,
      confidence: 0.76 + speakerWeight('recommendations', speakerTag)
    });
  }

  if (/динами|улучш|лучше|положительная|отрицательная/.test(lower)) {
    facts.push({
      fact_id: makeId('fact-dynamics'),
      source_type: 'transcript_chunk',
      speaker_tag: speakerTag,
      field_key: 'dynamics',
      normalized_value: compactText(text),
      raw_evidence: text,
      confidence: 0.74 + speakerWeight('dynamics', speakerTag)
    });
  }

  if (/план|продолжить занятия|работать над|коррекц|трениров/.test(lower)) {
    facts.push({
      fact_id: makeId('fact-work-plan'),
      source_type: 'transcript_chunk',
      speaker_tag: speakerTag,
      field_key: 'work-plan',
      normalized_value: compactText(text),
      raw_evidence: text,
      confidence: 0.72 + speakerWeight('work-plan', speakerTag)
    });
  }

  const plannedMatch = lower.match(/план(?:ируется|ируем|иру).*?(\d+)\s*(занят|сеанс)/i) || lower.match(/(\d+)\s*(занят|сеанс).{0,20}план/i);
  if (plannedMatch) {
    facts.push({
      fact_id: makeId('fact-planned-sessions'),
      source_type: 'transcript_chunk',
      speaker_tag: speakerTag,
      field_key: 'planned-sessions',
      normalized_value: plannedMatch[1],
      raw_evidence: text,
      confidence: 0.8
    });
  }

  const completedMatch = lower.match(/провед(?:ено|енных|ено занятий).*?(\d+)/i) || lower.match(/(\d+)\s*(занят|сеанс).{0,20}провед/i);
  if (completedMatch) {
    facts.push({
      fact_id: makeId('fact-completed-sessions'),
      source_type: 'transcript_chunk',
      speaker_tag: speakerTag,
      field_key: 'completed-sessions',
      normalized_value: completedMatch[1],
      raw_evidence: text,
      confidence: 0.8
    });
  }

  if (/заключ|уровень|наруш|состояние|контакт|внимание|память|мышлен|речь/.test(lower)) {
    facts.push({
      fact_id: makeId('fact-conclusion'),
      source_type: 'transcript_chunk',
      speaker_tag: speakerTag,
      field_key: 'tbmedicalfinal',
      normalized_value: compactText(text),
      raw_evidence: text,
      confidence: 0.78 + speakerWeight('tbmedicalfinal', speakerTag)
    });
  }

  return facts;
}

function factToPatch(fact) {
  return {
    patch_id: makeId(fact.field_key),
    field_key: fact.field_key,
    value_type: 'text',
    value: fact.normalized_value,
    provenance: fact.source_type,
    confidence: fact.confidence,
    status: 'suggested'
  };
}

function sectionPatchFromModel(appointment, modelPatch) {
  const section = appointment.inspection_draft.medical_record_sections.find((item) => item.section_key === modelPatch.section_key || item.section_key === modelPatch.field_key);
  if (!section || section.kind !== 'checkbox-group') return null;
  const allowed = new Set(section.options.map((option) => option.option_key));
  const values = Array.isArray(modelPatch.value)
    ? modelPatch.value.filter((value) => allowed.has(value))
    : [];
  if (!values.length) return null;
  return {
    patch_id: makeId(section.section_key),
    field_key: section.section_key,
    section_key: section.section_key,
    title: section.title,
    value_type: 'checkbox-group',
    value: values,
    provenance: 'openrouter_parser',
    confidence: Number(modelPatch.confidence || 0.76),
    status: 'suggested'
  };
}

function textPatchFromModel(modelPatch, allowedTextFields) {
  if (!allowedTextFields.has(modelPatch.field_key)) return null;
  const value = compactText(modelPatch.value);
  if (!value) return null;
  return {
    patch_id: makeId(modelPatch.field_key),
    field_key: modelPatch.field_key,
    value_type: 'text',
    value,
    provenance: 'openrouter_parser',
    confidence: Number(modelPatch.confidence || 0.78),
    status: 'suggested'
  };
}

function buildAllowedFieldContext(appointment) {
  const textFields = [
    { field_key: 'tbmedicalfinal', label: 'Заключение' },
    { field_key: 'recommendations', label: 'Рекомендации' },
    { field_key: 'dynamics', label: 'Динамика развития' },
    { field_key: 'work-plan', label: 'План работы' },
    { field_key: 'planned-sessions', label: 'Количество планируемых занятий' },
    { field_key: 'completed-sessions', label: 'Количество проведенных занятий' }
  ];
  const checkboxSections = appointment.inspection_draft.medical_record_sections
    .filter((section) => section.kind === 'checkbox-group')
    .map((section) => ({
      section_key: section.section_key,
      title: section.title,
      options: section.options.map((option) => ({
        option_key: option.option_key,
        label: option.label
      }))
    }));
  return { textFields, checkboxSections };
}

function parseModelJson(content) {
  const trimmed = String(content || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

async function inferOpenRouterPatches(appointment, patient, text, speakerTag) {
  const config = getOpenRouterConfig();
  if (!config.apiKey) {
    return { patches: [], facts: [], provider: 'heuristic', error: null };
  }

  const allowed = buildAllowedFieldContext(appointment);
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      facts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            field_key: { type: 'string' },
            normalized_value: { type: 'string' },
            raw_evidence: { type: 'string' },
            confidence: { type: 'number' }
          },
          required: ['field_key', 'normalized_value', 'raw_evidence', 'confidence']
        }
      },
      patches: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            field_key: { type: 'string' },
            section_key: { type: 'string' },
            value_type: { type: 'string', enum: ['text', 'checkbox-group'] },
            value: {
              anyOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } }
              ]
            },
            confidence: { type: 'number' }
          },
            required: ['field_key', 'section_key', 'value_type', 'value', 'confidence']
        }
      }
    },
    required: ['facts', 'patches']
  };

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
      temperature: 0.1,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'damumed_transcript_patches',
          strict: true,
          schema
        }
      },
      messages: [
        {
          role: 'system',
          content: [
            'You are a medical form extraction layer for a local Damumed sandbox.',
            'Return JSON only. Never return DOM selectors, HTML, code, markdown, or unknown fields.',
            'Use only allowed field_key, section_key, and option_key values from the provided schema.',
            'For text fields set section_key to an empty string. For checkbox groups set section_key to the selected section_key.',
            'If a fact is uncertain, omit it or lower confidence. Do not invent patient data.',
            'Keep source language as Russian/Kazakh when present.'
          ].join(' ')
        },
        {
          role: 'user',
          content: JSON.stringify({
            task: 'Extract transcript facts into safe draft patches for preview only.',
            patient: {
              patient_id: patient?.patient_id,
              full_name: patient?.full_name,
              birth_date: patient?.birth_date,
              specialty_track: patient?.specialty_track
            },
            speaker_tag: speakerTag,
            transcript: text,
            allowed_fields: allowed.textFields,
            allowed_checkbox_sections: allowed.checkboxSections
          })
        }
      ]
    })
  });

  if (!response.ok) {
    const details = await response.text();
    return { patches: [], facts: [], provider: 'openrouter', error: details || response.statusText };
  }

  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content || '';
  const parsed = parseModelJson(content);
  if (!parsed) {
    return { patches: [], facts: [], provider: 'openrouter', error: 'OpenRouter returned non-JSON content.' };
  }

  const allowedTextFields = new Set(allowed.textFields.map((field) => field.field_key));
  const patches = [];
  for (const modelPatch of parsed.patches || []) {
    const patch = modelPatch.value_type === 'checkbox-group'
      ? sectionPatchFromModel(appointment, modelPatch)
      : textPatchFromModel(modelPatch, allowedTextFields);
    if (patch) patches.push(patch);
  }

  const facts = (parsed.facts || [])
    .filter((fact) => allowedTextFields.has(fact.field_key) || appointment.inspection_draft.medical_record_sections.some((section) => section.section_key === fact.field_key))
    .map((fact) => ({
      fact_id: makeId(`fact-${fact.field_key}`),
      source_type: 'openrouter_parser',
      speaker_tag: speakerTag,
      field_key: fact.field_key,
      normalized_value: compactText(fact.normalized_value),
      raw_evidence: compactText(fact.raw_evidence),
      confidence: Number(fact.confidence || 0.76)
    }));

  return { patches, facts, provider: 'openrouter', error: null };
}

function mergeDraftPatches(existingPatches, incomingPatches) {
  const merged = new Map();
  for (const patch of existingPatches) {
    merged.set(patch.section_key || patch.field_key, clone(patch));
  }
  for (const patch of incomingPatches) {
    const key = patch.section_key || patch.field_key;
    const previous = merged.get(key);
    if (!previous || previous.confidence <= patch.confidence) {
      merged.set(key, clone(patch));
    }
  }
  return [...merged.values()];
}

function buildPreviewFromDraftState(runtime, appointmentId) {
  const appointment = getAppointmentById(runtime, appointmentId);
  if (!appointment) throw new Error('Appointment not found');
  const patches = appointment.draft_state.draft_patches || [];
  return {
    intent: makeIntent('preview_changes', 'inspection', appointmentId, {}),
    patches,
    domOperations: patchesToDomOperations(patches),
    explanation: patches.length
      ? 'Черновик подготовлен из накопленного транскрипта. Можно применить его в форму.'
      : 'Черновик пока пустой: явных полей из транскрипта не найдено.',
    hints: buildHints(runtime, { screen_id: 'inspection', selected_appointment_id: appointmentId })
  };
}

export function patchesToDomOperations(patches) {
  const operations = [];
  for (const patch of patches) {
    switch (patch.field_key) {
      case 'dtpserviceexecutedate':
        operations.push({ type: 'set-value', selector: '#dtpServiceExecuteDate', value: patch.value });
        break;
      case 'dtpserviceexecutetime':
        operations.push({ type: 'set-value', selector: '#dtpServiceExecuteTime', value: patch.value });
        break;
      case 'ntbdurationminute':
        operations.push({ type: 'set-value', selector: '#ntbDurationMinute', value: String(patch.value) });
        break;
      case 'cmbmedicalform':
        operations.push({ type: 'set-value', selector: '#cmbMedicalForm', value: patch.value });
        break;
      case 'cmbperformerservice':
        operations.push({ type: 'set-value', selector: '#cmbPerformerService', value: patch.value });
        break;
      case 'cmbperformerservicemo':
        operations.push({ type: 'set-value', selector: '#cmbPerformerServiceMo', value: patch.value });
        break;
      case 'tbmedicalfinal':
        operations.push({ type: 'set-value', selector: '#tbMedicalFinal', value: patch.value });
        break;
      case 'work-plan':
        operations.push({ type: 'set-value', selector: '#supp-workPlan', value: patch.value });
        break;
      case 'planned-sessions':
        operations.push({ type: 'set-value', selector: '#supp-plannedSessions', value: patch.value });
        break;
      case 'completed-sessions':
        operations.push({ type: 'set-value', selector: '#supp-completedSessions', value: patch.value });
        break;
      case 'dynamics':
        operations.push({ type: 'set-value', selector: '#supp-dynamics', value: patch.value });
        break;
      case 'recommendations':
        operations.push({ type: 'set-value', selector: '#supp-recommendations', value: patch.value });
        break;
      default:
        if (patch.value_type === 'checkbox-group') {
          operations.push({
            type: 'set-checkbox-group',
            section_key: patch.section_key,
            selector: `[data-section-key="${patch.section_key}"]`,
            values: patch.value
          });
        }
    }
  }
  return operations;
}

export function buildHints(runtime, screenContext) {
  const screenId = inferScreenId(screenContext);
  if (screenId === 'schedule') {
    const currentDay = runtime.scheduleDays.find((day) => day.date === runtime.currentDate) || runtime.scheduleDays[0];
    const nextScheduled = currentDay?.slots.find((slot) => slot.status === 'scheduled');
    const patient = nextScheduled ? getPatientById(runtime, nextScheduled.patient_id) : null;
    return [
      {
        hint_id: 'hint-schedule-next-patient',
        screen_id: 'schedule',
        patient_id: patient?.patient_id || null,
        intent_type: 'open_patient_selector',
        severity: 'info',
        provenance: 'scheduler',
        message: nextScheduled
          ? `Следующий пациент на ${nextScheduled.start_time}: ${patient?.full_name}. Откройте запись и начните заполнение во время приема.`
          : 'На текущий день нет активных записей.',
        suggested_patches: nextScheduled ? [{ slot_id: nextScheduled.slot_id, appointment_id: nextScheduled.appointment_id }] : []
      },
      {
        hint_id: 'hint-schedule-nine-days',
        screen_id: 'schedule',
        patient_id: null,
        intent_type: 'change_schedule_day',
        severity: 'info',
        provenance: 'scheduler',
        message: `Доступно ${runtime.scheduleDays.length} рабочих дней. Можно переключать график по дням.`,
        suggested_patches: []
      }
    ];
  }

  const appointment = getAppointmentById(runtime, screenContext?.selected_appointment_id);
  if (!appointment) return [];

  const missing = [];
  if (!appointment.inspection_draft.conclusion_text) missing.push('Заключение');
  if (!appointment.inspection_draft.supplemental?.recommendations) missing.push('Рекомендации');
  if (!appointment.inspection_draft.supplemental?.dynamics) missing.push('Динамика');

  const draftPatchCount = appointment.draft_state?.draft_patches?.length || 0;
  return [
    {
      hint_id: 'hint-inspection-listening',
      screen_id: 'inspection',
      patient_id: appointment.patient_id,
      intent_type: 'preview_changes',
      severity: draftPatchCount ? 'info' : 'warning',
      provenance: 'draft_state',
      message: draftPatchCount
        ? `В черновике уже ${draftPatchCount} предложенных обновлений. Можно применить их в форму.`
        : 'Форма пока медицински пустая. Запустите запись или вставьте транскрипт, чтобы собрать черновик.',
      suggested_patches: appointment.draft_state?.draft_patches || []
    },
    {
      hint_id: 'hint-inspection-missing',
      screen_id: 'inspection',
      patient_id: appointment.patient_id,
      intent_type: 'show_hint',
      severity: missing.length ? 'warning' : 'success',
      provenance: 'form_validation',
      message: missing.length ? `Пока не заполнены ключевые поля: ${missing.join(', ')}.` : 'Ключевые поля формы заполнены. Можно сохранять.',
      suggested_patches: []
    }
  ];
}

export function previewCommand({ command, runtime, screenContext }) {
  const normalized = normalizeText(command);
  const screenId = inferScreenId(screenContext);

  if (!command) {
    return {
      intent: makeIntent('show_hint', screenId, null, {}),
      patches: [],
      domOperations: [],
      hints: buildHints(runtime, screenContext),
      explanation: 'Команда пустая, показываю подсказки.'
    };
  }

  if (screenId === 'schedule') {
    if (/next|следующ|келесі/.test(normalized)) {
      return {
        intent: makeIntent('change_schedule_day', 'schedule', null, { direction: 'next' }),
        patches: [],
        domOperations: [{ type: 'click', selector: '#btnNextDay' }],
        hints: buildHints(runtime, screenContext),
        explanation: 'Подготовлен переход на следующий рабочий день.'
      };
    }
    if (/prev|предыдущ|алдыңғы/.test(normalized)) {
      return {
        intent: makeIntent('change_schedule_day', 'schedule', null, { direction: 'prev' }),
        patches: [],
        domOperations: [{ type: 'click', selector: '#btnPrevDay' }],
        hints: buildHints(runtime, screenContext),
        explanation: 'Подготовлен переход на предыдущий рабочий день.'
      };
    }
  }

  const appointment = getAppointmentById(runtime, screenContext?.selected_appointment_id);
  if (!appointment) {
    return {
      intent: makeIntent('show_hint', screenId, null, {}),
      patches: [],
      domOperations: [],
      hints: buildHints(runtime, screenContext),
      explanation: 'Активная запись не найдена.'
    };
  }

  return buildPreviewFromDraftState(runtime, appointment.appointment_id);
}

export function inferSpeakerTag(rawSpeaker, text) {
  if (rawSpeaker && rawSpeaker !== 'auto') return rawSpeaker;
  const normalized = normalizeText(text);
  if (/врач:|doctor:|специалист:/i.test(text)) return 'doctor';
  if (/мама:|папа:|родитель:|parent:|caregiver:/i.test(text)) return 'caregiver';
  if (/пациент:|ребенок:|patient:/i.test(text)) return 'patient';
  if (/жалуется|болит|не хочу|устал|хочу/i.test(normalized)) return 'patient';
  if (/рекомендую|назначаю|продолжить|наблюдается/i.test(normalized)) return 'doctor';
  return 'unknown';
}

export function startSpeechSession(runtime, appointmentId, provider = 'browser-web-speech') {
  const appointment = getAppointmentById(runtime, appointmentId);
  if (!appointment) throw new Error('Appointment not found for speech session');
  const session = {
    session_id: makeId('session'),
    appointment_id: appointmentId,
    status: 'listening',
    started_at: nowIso(),
    provider
  };
  runtime.speechSessions[session.session_id] = session;
  appointment.draft_state.draft_status = 'listening';
  appointment.draft_state.updated_at = nowIso();
  return session;
}

export async function ingestTranscript(runtime, { appointmentId, sessionId, text, speakerTag }) {
  const appointment = getAppointmentById(runtime, appointmentId);
  if (!appointment) {
    throw new Error('Appointment not found for transcript ingestion');
  }

  const patient = getPatientById(runtime, appointment.patient_id);
  const inferredSpeaker = inferSpeakerTag(speakerTag, text);
  const activeSessionId = sessionId || `session-${appointmentId}`;
  const chunk = {
    chunk_id: makeId('chunk'),
    session_id: activeSessionId,
    start_ms: Date.now(),
    end_ms: Date.now() + 2500,
    text,
    speaker_tag: inferredSpeaker,
    confidence: inferredSpeaker === 'unknown' ? 0.55 : 0.86
  };

  const factCandidates = inferFactCandidates(appointment, text, inferredSpeaker);
  const structuredPatches = inferStructuredSectionPatches(appointment, text, inferredSpeaker);
  const fieldPatches = factCandidates.map(factToPatch);
  const openRouterResult = await inferOpenRouterPatches(appointment, patient, text, inferredSpeaker);
  const incomingPatches = [...fieldPatches, ...structuredPatches, ...openRouterResult.patches];
  const allFactCandidates = [...factCandidates, ...openRouterResult.facts];

  appointment.draft_state.transcript_chunks.push(chunk);
  appointment.draft_state.fact_candidates.push(...allFactCandidates);
  appointment.draft_state.draft_patches = mergeDraftPatches(appointment.draft_state.draft_patches, incomingPatches);
  appointment.draft_state.draft_status = appointment.draft_state.draft_patches.length ? 'ready_for_apply' : 'listening';
  appointment.draft_state.updated_at = nowIso();
  appointment.draft_state.last_preview = buildPreviewFromDraftState(runtime, appointmentId);

  runtime.transcriptSessions[activeSessionId] ||= [];
  runtime.transcriptSessions[activeSessionId].push(chunk);

  return {
    chunk,
    factCandidates: allFactCandidates,
    draftPatches: appointment.draft_state.draft_patches,
    domOperations: appointment.draft_state.last_preview.domOperations,
    parser: {
      provider: openRouterResult.provider,
      used_openrouter: openRouterResult.provider === 'openrouter' && !openRouterResult.error,
      error: openRouterResult.error
    },
    hints: buildHints(runtime, { screen_id: 'inspection', selected_appointment_id: appointmentId }),
    draftState: clone(appointment.draft_state)
  };
}

export function stopSpeechSession(runtime, sessionId) {
  const session = runtime.speechSessions[sessionId];
  if (!session) throw new Error('Speech session not found');
  session.status = 'stopped';
  session.stopped_at = nowIso();
  const appointment = getAppointmentById(runtime, session.appointment_id);
  if (appointment && appointment.draft_state.draft_status === 'listening') {
    appointment.draft_state.draft_status = appointment.draft_state.draft_patches.length ? 'ready_for_apply' : 'idle';
    appointment.draft_state.updated_at = nowIso();
  }
  return session;
}

export function getDraftState(runtime, appointmentId) {
  const appointment = getAppointmentById(runtime, appointmentId);
  if (!appointment) throw new Error('Appointment not found');
  return clone(appointment.draft_state);
}

export function buildApplyPreview(runtime, appointmentId) {
  const appointment = getAppointmentById(runtime, appointmentId);
  if (!appointment) throw new Error('Appointment not found');
  const preview = buildPreviewFromDraftState(runtime, appointmentId);
  appointment.draft_state.last_preview = clone(preview);
  appointment.draft_state.updated_at = nowIso();
  return preview;
}

export function markPreviewApplied(runtime, appointmentId, patchIds = []) {
  const appointment = getAppointmentById(runtime, appointmentId);
  if (!appointment) throw new Error('Appointment not found');
  const ids = patchIds.length ? patchIds : (appointment.draft_state.draft_patches || []).map((patch) => patch.patch_id);
  appointment.draft_state.applied_patch_ids = [...new Set([...(appointment.draft_state.applied_patch_ids || []), ...ids])];
  appointment.draft_state.draft_status = 'applied';
  appointment.draft_state.updated_at = nowIso();
  appointment.draft_state.draft_patches = appointment.draft_state.draft_patches.map((patch) => (
    ids.includes(patch.patch_id) ? { ...patch, status: 'applied' } : patch
  ));
  return clone(appointment.draft_state);
}

export function createAuditEntry({ actorType, actionType, screenId, entityRefs, payload, result }) {
  return {
    entry_id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: nowIso(),
    actor_type: actorType,
    action_type: actionType,
    screen_id: screenId,
    entity_refs: entityRefs,
    payload,
    result
  };
}

export function applyInspectionSave(runtime, appointmentId, payload) {
  const appointment = getAppointmentById(runtime, appointmentId);
  if (!appointment) {
    throw new Error('Appointment not found');
  }

  appointment.inspection_draft = {
    ...appointment.inspection_draft,
    ...payload,
    supplemental: {
      ...appointment.inspection_draft.supplemental,
      ...(payload.supplemental || {})
    }
  };
  appointment.status = 'completed';
  appointment.executed_at = `${payload.execute_date}T${payload.execute_time}:00`;
  appointment.draft_state.draft_status = 'applied';
  appointment.draft_state.updated_at = nowIso();

  for (const day of runtime.scheduleDays) {
    for (const slot of day.slots) {
      if (slot.appointment_id === appointmentId) {
        slot.status = 'completed';
      }
    }
  }

  return appointment;
}
