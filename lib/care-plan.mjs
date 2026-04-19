import { randomUUID } from 'node:crypto';

const DEFAULT_WINDOW_DAYS = 9;
const VALID_WINDOW_DAYS = new Set([7, 9]);
const SLOT_STEP_MIN = 30;

const STATUS_LABELS = {
  draft: 'Черновик',
  confirmed: 'Подтвержден',
  suggested: 'Предложено',
  scheduled: 'Назначено',
  in_progress: 'В работе',
  completed: 'Выполнено',
  cancelled: 'Отменено',
  missed: 'Не явился'
};

function nowIso() {
  return new Date().toISOString();
}

function normalizeWindowDays(value) {
  const parsed = Number(value || DEFAULT_WINDOW_DAYS);
  return VALID_WINDOW_DAYS.has(parsed) ? parsed : DEFAULT_WINDOW_DAYS;
}

function normalizeDate(value) {
  const date = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
}

function addDays(dateValue, amount) {
  const date = new Date(`${normalizeDate(dateValue)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function minutes(value) {
  const [hours, mins] = String(value || '00:00').split(':').map(Number);
  return (hours || 0) * 60 + (mins || 0);
}

function timeFromMinutes(total) {
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

function endTime(start, durationMin) {
  return timeFromMinutes(minutes(start) + Number(durationMin || SLOT_STEP_MIN));
}

function overlaps(left, right) {
  if (left.date !== right.date) return false;
  return Math.max(minutes(left.start_time || left.start), minutes(right.start_time || right.start))
    < Math.min(minutes(left.end_time || left.end), minutes(right.end_time || right.end));
}

function specialtyKind(provider = {}) {
  const haystack = `${provider.care_role || ''} ${provider.specialty || ''} ${provider.schedule_name || ''}`.toLowerCase();
  if (/primary|первич|ведущ|основ/.test(haystack)) return 'primary';
  if (/therap|терап/.test(haystack)) return 'therapist';
  if (/mass|масс/.test(haystack)) return 'massage';
  if (/psych|псих/.test(haystack)) return 'psychology';
  return 'secondary';
}

function providerLabel(provider = {}) {
  return provider.short_name || provider.full_name || provider.provider_id || 'Специалист';
}

function ensureRuntimeCarePlans(runtime) {
  if (!runtime.carePlans || typeof runtime.carePlans !== 'object' || Array.isArray(runtime.carePlans)) {
    runtime.carePlans = {};
  }
  return runtime.carePlans;
}

function allSlots(runtime) {
  return (runtime.scheduleDays || []).flatMap((day) => day.slots || []);
}

function findSlot(runtime, { provider_id, date, start_time }) {
  return allSlots(runtime).find((slot) =>
    slot.provider_id === provider_id
    && slot.date === date
    && slot.start_time === start_time
  ) || null;
}

function findProvider(runtime, providerId) {
  return (runtime.providers || []).find((provider) => provider.provider_id === providerId) || null;
}

function findPatient(runtime, patientId) {
  return (runtime.patients || []).find((patient) => patient.patient_id === patientId) || null;
}

function appointmentDate(runtime, appointmentId) {
  const appointment = runtime.appointments?.[appointmentId];
  const slot = appointment?.schedule_slot_id
    ? allSlots(runtime).find((item) => item.slot_id === appointment.schedule_slot_id)
    : null;
  return slot?.date || appointment?.inspection_draft?.execute_date || runtime.currentDate || '';
}

function appointmentPrimaryProvider(runtime, appointmentId) {
  return runtime.appointments?.[appointmentId]?.provider_id || runtime.providers?.[0]?.provider_id || '';
}

function windowDates(startDate, planningWindowDays) {
  return Array.from({ length: normalizeWindowDays(planningWindowDays) }, (_, index) => addDays(startDate, index));
}

function itemBase({ patientId, appointmentId, provider, date, start, durationMin, serviceName, reason }) {
  return {
    item_id: `cpi_${randomUUID()}`,
    source_appointment_id: appointmentId || '',
    patient_id: patientId,
    provider_id: provider.provider_id,
    provider_name: providerLabel(provider),
    specialty: provider.specialty || provider.schedule_name || specialtyKind(provider),
    provider_kind: specialtyKind(provider),
    service_name: serviceName,
    date,
    start_time: start,
    end_time: endTime(start, durationMin),
    duration_min: Number(durationMin || SLOT_STEP_MIN),
    status: 'suggested',
    reason,
    appointment_id: '',
    slot_id: '',
    result_note: '',
    updated_at: nowIso()
  };
}

function pickProviders(runtime) {
  const providers = runtime.providers || [];
  const byKind = (kind) => providers.filter((provider) => specialtyKind(provider) === kind);
  return {
    therapist: byKind('therapist'),
    psychology: byKind('psychology'),
    massage: byKind('massage'),
    secondary: providers.filter((provider) => specialtyKind(provider) !== 'primary')
  };
}

function slotIsAvailable(runtime, slot, pending = []) {
  if (!slot || slot.status !== 'available' || slot.patient_id) return false;
  return !pending.some((item) => item.provider_id === slot.provider_id && overlaps(item, slot));
}

function findAvailableSlot(runtime, providers, dates, preferredTimes, durationMin, pending = []) {
  for (const date of dates) {
    for (const time of preferredTimes) {
      for (const provider of providers) {
        const slot = findSlot(runtime, { provider_id: provider.provider_id, date, start_time: time });
        if (slotIsAvailable(runtime, slot, pending)) {
          return { provider, slot };
        }
      }
    }
  }
  return null;
}

function buildSuggestionSpecs(runtime, patient, appointmentId, planningWindowDays) {
  const startDate = normalizeDate(appointmentDate(runtime, appointmentId)) || normalizeDate(runtime.currentDate);
  const dates = windowDates(startDate, planningWindowDays);
  const providers = pickProviders(runtime);
  const complaintText = [
    runtime.appointments?.[appointmentId]?.inspection_draft?.complaints_text,
    runtime.appointments?.[appointmentId]?.inspection_draft?.anamnesis_text,
    runtime.appointments?.[appointmentId]?.inspection_draft?.conclusion_text
  ].filter(Boolean).join(' ').toLowerCase();
  const needsMassage = /тонус|мышц|массаж|осанк|двиг|реабил|спин|ше/.test(complaintText) || true;
  const needsTherapist = /сон|аппетит|температур|кашель|боль|общее|сомат/.test(complaintText) || true;

  const specs = [];
  if (needsTherapist && providers.therapist.length) {
    specs.push({
      kind: 'therapist',
      providers: providers.therapist,
      dayIndexes: [1, 2, 3],
      times: ['09:30', '10:00', '11:00', '14:00'],
      durationMin: 30,
      serviceName: 'Контроль терапевта',
      reason: 'Проверить соматическое состояние перед нагрузкой и уточнить ограничения.'
    });
  }
  if (providers.psychology.length) {
    specs.push({
      kind: 'psychology',
      providers: providers.psychology,
      dayIndexes: [1, 3, 5],
      times: ['10:00', '10:30', '11:30', '15:00'],
      durationMin: 30,
      serviceName: 'Занятие с психологом',
      reason: 'Продолжить оценку внимания, инструкций и поведенческой динамики.'
    });
    specs.push({
      kind: 'psychology',
      providers: providers.psychology,
      dayIndexes: [4, 6, 8],
      times: ['09:30', '11:00', '14:30', '16:00'],
      durationMin: 30,
      serviceName: 'Повторное занятие с психологом',
      reason: 'Закрепить короткие задания и проверить устойчивость внимания в динамике.'
    });
  }
  if (needsMassage && providers.massage.length) {
    specs.push({
      kind: 'massage',
      providers: providers.massage,
      dayIndexes: [2, 4, 6],
      times: ['11:00', '11:30', '15:00', '15:30'],
      durationMin: 30,
      serviceName: 'Массаж / телесная разгрузка',
      reason: 'Поддержать сенсомоторную регуляцию и снизить мышечное напряжение.'
    });
    specs.push({
      kind: 'massage',
      providers: providers.massage,
      dayIndexes: [5, 7, 8],
      times: ['09:00', '10:30', '14:00', '16:30'],
      durationMin: 30,
      serviceName: 'Повторный массаж',
      reason: 'Оценить переносимость нагрузки и продолжить мягкую коррекцию.'
    });
  }

  if (!specs.length && providers.secondary.length) {
    specs.push({
      kind: 'secondary',
      providers: providers.secondary,
      dayIndexes: [1, 3],
      times: ['10:00', '14:00'],
      durationMin: 30,
      serviceName: 'Консультация специалиста',
      reason: 'ИИ предлагает начать с ближайшего доступного вторичного специалиста.'
    });
  }

  return { dates, specs, patient };
}

function buildDraftItems(runtime, patient, appointmentId, planningWindowDays) {
  const { dates, specs } = buildSuggestionSpecs(runtime, patient, appointmentId, planningWindowDays);
  const items = [];
  for (const spec of specs) {
    const preferredDates = spec.dayIndexes
      .map((index) => dates[Math.min(index, dates.length - 1)])
      .filter(Boolean);
    const candidate = findAvailableSlot(runtime, spec.providers, preferredDates, spec.times, spec.durationMin, items)
      || findAvailableSlot(runtime, spec.providers, dates, spec.times, spec.durationMin, items);
    if (!candidate) continue;
    items.push(itemBase({
      patientId: patient.patient_id,
      appointmentId,
      provider: candidate.provider,
      date: candidate.slot.date,
      start: candidate.slot.start_time,
      durationMin: spec.durationMin,
      serviceName: spec.serviceName,
      reason: spec.reason
    }));
  }
  return items;
}

function serializePlan(runtime, plan) {
  if (!plan) return null;
  const patient = findPatient(runtime, plan.patient_id);
  const primaryProvider = findProvider(runtime, plan.primary_provider_id);
  const conflicts = findScheduleConflicts(runtime, { items: plan.items || [], planId: plan.plan_id });
  return {
    ...plan,
    status_label: STATUS_LABELS[plan.status] || plan.status,
    patient,
    primary_provider: primaryProvider,
    conflicts,
    items: (plan.items || []).map((item) => ({
      ...item,
      status_label: STATUS_LABELS[item.status] || item.status,
      provider: findProvider(runtime, item.provider_id)
    }))
  };
}

export function suggestCarePlan(runtime, {
  patientId,
  appointmentId,
  planningWindowDays = DEFAULT_WINDOW_DAYS
} = {}) {
  ensureRuntimeCarePlans(runtime);
  const appointment = runtime.appointments?.[appointmentId];
  const effectivePatientId = patientId || appointment?.patient_id;
  const patient = findPatient(runtime, effectivePatientId);
  if (!patient) {
    throw new Error('Patient not found for care plan.');
  }

  const normalizedWindow = normalizeWindowDays(planningWindowDays);
  const startDate = normalizeDate(appointmentDate(runtime, appointmentId)) || normalizeDate(runtime.currentDate);
  const existing = Object.values(runtime.carePlans).find((plan) =>
    plan.status === 'draft'
    && plan.patient_id === patient.patient_id
    && (!appointmentId || plan.primary_appointment_id === appointmentId)
  );
  const plan = existing || {
    plan_id: `cp_${randomUUID()}`,
    patient_id: patient.patient_id,
    primary_appointment_id: appointmentId || '',
    primary_provider_id: appointmentPrimaryProvider(runtime, appointmentId),
    created_at: nowIso()
  };

  plan.planning_window_days = normalizedWindow;
  plan.window_start_date = startDate;
  plan.window_end_date = addDays(startDate, normalizedWindow - 1);
  plan.status = 'draft';
  plan.updated_at = nowIso();
  plan.items = buildDraftItems(runtime, patient, appointmentId, normalizedWindow);
  runtime.carePlans[plan.plan_id] = plan;
  return serializePlan(runtime, plan);
}

export function listCarePlans(runtime, { patientId = '', primaryProviderId = '', status = '' } = {}) {
  ensureRuntimeCarePlans(runtime);
  return Object.values(runtime.carePlans)
    .filter((plan) => !patientId || plan.patient_id === patientId)
    .filter((plan) => !primaryProviderId || plan.primary_provider_id === primaryProviderId)
    .filter((plan) => !status || plan.status === status)
    .sort((left, right) => String(right.updated_at || '').localeCompare(String(left.updated_at || '')))
    .map((plan) => serializePlan(runtime, plan));
}

export function getCarePlan(runtime, planId) {
  ensureRuntimeCarePlans(runtime);
  return serializePlan(runtime, runtime.carePlans[planId]);
}

export function updateCarePlanItem(runtime, planId, itemId, patch = {}) {
  ensureRuntimeCarePlans(runtime);
  const plan = runtime.carePlans[planId];
  if (!plan) throw new Error('Care plan not found.');
  if (plan.status !== 'draft') throw new Error('Confirmed care plan items cannot be edited.');
  const item = (plan.items || []).find((entry) => entry.item_id === itemId);
  if (!item) throw new Error('Care plan item not found.');

  const provider = patch.provider_id ? findProvider(runtime, patch.provider_id) : null;
  if (patch.provider_id && !provider) throw new Error('Provider not found.');
  if (provider) {
    item.provider_id = provider.provider_id;
    item.provider_name = providerLabel(provider);
    item.specialty = provider.specialty || provider.schedule_name || specialtyKind(provider);
    item.provider_kind = specialtyKind(provider);
  }
  if (patch.date) item.date = normalizeDate(patch.date);
  if (patch.start_time) item.start_time = String(patch.start_time).slice(0, 5);
  if (patch.duration_min) item.duration_min = Number(patch.duration_min);
  if (patch.service_name) item.service_name = String(patch.service_name);
  if (patch.reason) item.reason = String(patch.reason);
  item.end_time = endTime(item.start_time, item.duration_min);
  item.updated_at = nowIso();
  plan.updated_at = nowIso();
  return serializePlan(runtime, plan);
}

export function addCarePlanItem(runtime, planId, patch = {}) {
  ensureRuntimeCarePlans(runtime);
  const plan = runtime.carePlans[planId];
  if (!plan) throw new Error('Care plan not found.');
  if (plan.status !== 'draft') throw new Error('Confirmed care plan cannot be edited.');
  const provider = findProvider(runtime, patch.provider_id) || (runtime.providers || []).find((item) => specialtyKind(item) !== 'primary');
  if (!provider) throw new Error('Provider not found.');
  const item = itemBase({
    patientId: plan.patient_id,
    appointmentId: plan.primary_appointment_id,
    provider,
    date: normalizeDate(patch.date) || plan.window_start_date,
    start: String(patch.start_time || '10:00').slice(0, 5),
    durationMin: Number(patch.duration_min || SLOT_STEP_MIN),
    serviceName: patch.service_name || 'Консультация специалиста',
    reason: patch.reason || 'Добавлено первичным врачом.'
  });
  plan.items = [...(plan.items || []), item];
  plan.updated_at = nowIso();
  return serializePlan(runtime, plan);
}

export function deleteCarePlanItem(runtime, planId, itemId) {
  ensureRuntimeCarePlans(runtime);
  const plan = runtime.carePlans[planId];
  if (!plan) throw new Error('Care plan not found.');
  if (plan.status !== 'draft') throw new Error('Confirmed care plan cannot be edited.');
  plan.items = (plan.items || []).filter((item) => item.item_id !== itemId);
  plan.updated_at = nowIso();
  return serializePlan(runtime, plan);
}

export function findScheduleConflicts(runtime, { items = [], planId = '' } = {}) {
  const conflicts = [];
  const scheduledItems = [];
  for (const item of items) {
    const slot = findSlot(runtime, item);
    if (!slot) {
      conflicts.push({
        item_id: item.item_id,
        type: 'slot_missing',
        message: 'Слот не найден в сетке расписания.',
        item
      });
      continue;
    }
    if (slot.status !== 'available' && slot.appointment_id !== item.appointment_id) {
      conflicts.push({
        item_id: item.item_id,
        type: 'slot_occupied',
        message: 'Слот уже занят другим пациентом.',
        slot
      });
    }
    const duplicate = scheduledItems.find((other) => other.provider_id === item.provider_id && overlaps(other, item));
    if (duplicate) {
      conflicts.push({
        item_id: item.item_id,
        type: 'draft_overlap',
        message: 'В draft-плане есть пересечение по времени.',
        other_item_id: duplicate.item_id
      });
    }
    scheduledItems.push(item);
  }

  const confirmedPlans = Object.values(runtime.carePlans || {})
    .filter((plan) => plan.plan_id !== planId && plan.status === 'confirmed');
  for (const item of items) {
    for (const plan of confirmedPlans) {
      for (const other of plan.items || []) {
        if (other.provider_id === item.provider_id && ['scheduled', 'in_progress'].includes(other.status) && overlaps(other, item)) {
          conflicts.push({
            item_id: item.item_id,
            type: 'care_plan_overlap',
            message: 'Слот уже занят в другом маршруте пациента.',
            other_plan_id: plan.plan_id,
            other_item_id: other.item_id
          });
        }
      }
    }
  }
  return conflicts;
}

export function confirmCarePlan(runtime, planId) {
  ensureRuntimeCarePlans(runtime);
  const plan = runtime.carePlans[planId];
  if (!plan) throw new Error('Care plan not found.');
  const conflicts = findScheduleConflicts(runtime, { items: plan.items || [], planId });
  if (conflicts.length) {
    return { ok: false, plan: serializePlan(runtime, plan), conflicts };
  }

  const patient = findPatient(runtime, plan.patient_id);
  if (!patient) throw new Error('Patient not found.');

  for (const item of plan.items || []) {
    const slot = findSlot(runtime, item);
    if (!slot) continue;
    slot.patient_id = patient.patient_id;
    slot.status = 'scheduled';
    slot.care_plan_id = plan.plan_id;
    slot.care_plan_item_id = item.item_id;
    slot.service_name = item.service_name || slot.service_name;
    item.slot_id = slot.slot_id;
    item.appointment_id = slot.appointment_id;
    item.status = 'scheduled';
    item.updated_at = nowIso();

    const appointment = runtime.appointments?.[slot.appointment_id];
    if (appointment) {
      appointment.patient_id = patient.patient_id;
      appointment.provider_id = slot.provider_id;
      appointment.status = 'scheduled';
      appointment.service_name = item.service_name || appointment.service_name;
      appointment.care_plan_id = plan.plan_id;
      appointment.care_plan_item_id = item.item_id;
      if (appointment.inspection_draft) {
        appointment.inspection_draft.execute_date = slot.date;
        appointment.inspection_draft.execute_time = slot.start_time;
        appointment.inspection_draft.duration_min = item.duration_min;
        appointment.inspection_draft.appointments_text = item.reason || appointment.inspection_draft.appointments_text;
      }
    }
  }
  plan.status = 'confirmed';
  plan.confirmed_at = nowIso();
  plan.updated_at = nowIso();
  return { ok: true, plan: serializePlan(runtime, plan), conflicts: [] };
}

export function listProviderTasks(runtime, providerId, { status = '' } = {}) {
  ensureRuntimeCarePlans(runtime);
  return Object.values(runtime.carePlans)
    .filter((plan) => plan.status === 'confirmed')
    .flatMap((plan) => (plan.items || []).map((item) => ({ plan, item })))
    .filter(({ item }) => item.provider_id === providerId)
    .filter(({ item }) => !status || item.status === status)
    .sort((left, right) => `${left.item.date} ${left.item.start_time}`.localeCompare(`${right.item.date} ${right.item.start_time}`))
    .map(({ plan, item }) => ({
      ...item,
      status_label: STATUS_LABELS[item.status] || item.status,
      plan_id: plan.plan_id,
      patient: findPatient(runtime, plan.patient_id),
      primary_provider: findProvider(runtime, plan.primary_provider_id)
    }));
}

export function updateProviderTaskStatus(runtime, taskId, { status, resultNote = '' } = {}) {
  ensureRuntimeCarePlans(runtime);
  const allowed = new Set(['scheduled', 'in_progress', 'completed', 'cancelled', 'missed']);
  if (!allowed.has(status)) throw new Error('Invalid provider task status.');
  for (const plan of Object.values(runtime.carePlans)) {
    const item = (plan.items || []).find((entry) => entry.item_id === taskId || entry.appointment_id === taskId);
    if (!item) continue;
    item.status = status;
    item.result_note = resultNote || item.result_note || '';
    item.updated_at = nowIso();
    if (status === 'completed') item.completed_at = nowIso();
    const slot = item.slot_id ? allSlots(runtime).find((entry) => entry.slot_id === item.slot_id) : null;
    if (slot) slot.status = status === 'completed' ? 'completed' : status === 'cancelled' ? 'available' : 'scheduled';
    const appointment = item.appointment_id ? runtime.appointments?.[item.appointment_id] : null;
    if (appointment) {
      appointment.status = status === 'completed' ? 'completed' : status === 'cancelled' ? 'available' : 'scheduled';
      appointment.executed_at = status === 'completed' ? nowIso() : appointment.executed_at;
      appointment.provider_result_note = item.result_note;
    }
    plan.updated_at = nowIso();
    return {
      ok: true,
      task: {
        ...item,
        status_label: STATUS_LABELS[item.status] || item.status,
        plan_id: plan.plan_id,
        patient: findPatient(runtime, plan.patient_id),
        primary_provider: findProvider(runtime, plan.primary_provider_id)
      },
      plan: serializePlan(runtime, plan)
    };
  }
  throw new Error('Provider task not found.');
}

export function carePlanSummaryText(plan) {
  if (!plan) return '';
  const lines = [
    `Маршрут пациента: ${plan.patient?.full_name || plan.patient_id}`,
    `Окно: ${plan.window_start_date} - ${plan.window_end_date} (${plan.planning_window_days} дней)`,
    `Статус: ${plan.status_label || plan.status}`,
    ''
  ];
  for (const item of plan.items || []) {
    lines.push(`- ${item.date} ${item.start_time}: ${item.service_name} (${item.provider_name}) - ${item.status_label || item.status}. ${item.reason || ''}`);
    if (item.result_note) lines.push(`  Результат: ${item.result_note}`);
  }
  if (plan.conflicts?.length) {
    lines.push('', `Конфликты: ${plan.conflicts.length}`);
  }
  return lines.join('\n').trim();
}
