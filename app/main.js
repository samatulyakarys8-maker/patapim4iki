const state = {
  bootstrap: null,
  scheduleDay: null,
  scheduleWindow: [],
  appointmentBundle: null,
  hints: [],
  auditEntries: [],
  route: { screen: 'schedule', appointmentId: null },
  providerId: '',
  patientModal: { open: false, slotId: null, providerId: null, patients: [], query: '', selectedPatientId: null },
  statusFilter: 'all',
  activeTab: 'inspection',
  toast: '',
  sourceOfTruth: null,
  scheduleGenerator: {
    patients: [],
    patientId: '',
    durationMin: 30,
    startDate: '',
    result: null,
    loading: false,
    error: ''
  },
  carePlan: {
    plans: [],
    activePlan: null,
    planningWindowDays: 9,
    providerTasks: [],
    providerTaskStatus: 'all',
    loading: false,
    error: ''
  }
};

let inspectionRefreshPromise = null;

const app = document.querySelector('#app');

const selectOptions = {
  medicalForms: [
    { value: 'medical-form-psychology', label: '\u041b\u0438\u0441\u0442 \u043f\u0441\u0438\u0445\u043e\u043b\u043e\u0433\u0430' },
    { value: 'medical-form-rehab', label: '\u0420\u0435\u0430\u0431\u0438\u043b\u0438\u0442\u0430\u0446\u0438\u043e\u043d\u043d\u0430\u044f \u0444\u043e\u0440\u043c\u0430' }
  ],
  serviceClassifier: [
    { value: 'A02.005.000', label: '(A02.005.000) \u041a\u043e\u043d\u0441\u0443\u043b\u044c\u0442\u0430\u0446\u0438\u044f: \u041f\u0441\u0438\u0445\u043e\u043b\u043e\u0433' }
  ],
  servicePrice: [
    { value: 'A02.005.000-price', label: '(A02.005.000) \u041a\u043e\u043d\u0441\u0443\u043b\u044c\u0442\u0430\u0446\u0438\u044f: \u041f\u0441\u0438\u0445\u043e\u043b\u043e\u0433' }
  ],
  medicalPost: [
    { value: 'med-post-psychology', label: '\u041f\u043e\u0441\u0442 \u043f\u0441\u0438\u0445\u043e\u043b\u043e\u0433\u0430' }
  ],
  equipment: [
    { value: '', label: '\u041d\u0435 \u0432\u044b\u0431\u0440\u0430\u043d\u043e' },
    { value: 'sensory-room', label: '\u0421\u0435\u043d\u0441\u043e\u0440\u043d\u0430\u044f \u043a\u043e\u043c\u043d\u0430\u0442\u0430' },
    { value: 'speech-tools', label: '\u041b\u043e\u0433\u043e\u043f\u0435\u0434\u0438\u0447\u0435\u0441\u043a\u0438\u0439 \u043d\u0430\u0431\u043e\u0440' }
  ],
  statusFilter: [
    { value: 'all', label: '\u0412\u0441\u0435' },
    { value: 'scheduled', label: '\u041d\u0430\u0437\u043d\u0430\u0447\u0435\u043d\u043d\u044b\u0435' },
    { value: 'completed', label: '\u0412\u044b\u043f\u043e\u043b\u043d\u0435\u043d\u043d\u044b\u0435' }
  ]
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatSpecialtyTrack(value) {
  if (value === 'psychology-rehabilitation') return '\u041f\u0441\u0438\u0445\u043e\u043b\u043e\u0433';
  return value || '';
}

function formatPersonName(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('kk-KZ');

  if (!normalized) return '';

  return normalized.replace(/(^|[\s-])([\p{L}])/gu, (match, prefix, letter) => `${prefix}${letter.toLocaleUpperCase('kk-KZ')}`);
}

function formatScheduleDate(dateValue, options = { day: '2-digit', month: 'short' }) {
  if (!dateValue) return '';
  const date = new Date(`${dateValue}T00:00:00`);
  return new Intl.DateTimeFormat('ru-RU', options).format(date);
}

function formatScheduleWeekday(dateValue) {
  if (!dateValue) return '';
  const date = new Date(`${dateValue}T00:00:00`);
  return new Intl.DateTimeFormat('ru-RU', { weekday: 'short' }).format(date).replace('.', '');
}

function getScheduleWindowItem(dateValue = state.scheduleDay?.date) {
  return (state.scheduleWindow || []).find((day) => day.date === dateValue) || null;
}

function getActiveScheduleSummary() {
  return getScheduleWindowItem(state.scheduleDay?.date) || {
    date: state.scheduleDay?.date || '',
    slotsCount: 0,
    occupiedCount: 0,
    availableCount: 0,
    completedCount: 0,
    scheduledCount: 0,
    providerCount: state.bootstrap?.providers?.length || 0,
    occupancyRate: 0
  };
}

function getScheduleRangeLabel() {
  if (!state.scheduleWindow?.length) return '';
  const first = state.scheduleWindow[0]?.date;
  const last = state.scheduleWindow[state.scheduleWindow.length - 1]?.date;
  if (!first || !last) return '';
  return `${formatScheduleDate(first, { day: '2-digit', month: 'short' })} — ${formatScheduleDate(last, { day: '2-digit', month: 'short' })}`;
}

function getAdjacentScheduleDate(offset) {
  const days = state.scheduleWindow || [];
  if (!days.length) return state.scheduleDay?.date || state.bootstrap?.currentDate || '';
  const currentIndex = Math.max(0, days.findIndex((day) => day.date === state.scheduleDay?.date));
  const nextIndex = Math.min(days.length - 1, Math.max(0, currentIndex + offset));
  return days[nextIndex]?.date || days[currentIndex]?.date || state.scheduleDay?.date || '';
}

function renderScheduleOverview(mode = 'schedule') {
  const summary = getActiveScheduleSummary();
  const dayCount = state.scheduleWindow?.length || 0;
  const sectionTitle = mode === 'board'
    ? '\u0413\u043e\u0440\u0438\u0437\u043e\u043d\u0442 \u0440\u0430\u0441\u043f\u0438\u0441\u0430\u043d\u0438\u044f'
    : '\u041e\u0431\u0437\u043e\u0440 \u043d\u0430 9 \u0434\u043d\u0435\u0439';
  const sectionCopy = mode === 'board'
    ? '\u0412\u0441\u0435 \u043f\u0441\u0438\u0445\u043e\u043b\u043e\u0433\u0438 \u0438 \u0441\u043b\u043e\u0442\u044b \u043f\u043e \u0435\u0434\u0438\u043d\u043e\u043c\u0443 runtime.'
    : '\u0410\u043a\u0442\u0438\u0432\u043d\u044b\u0439 \u0434\u0435\u043d\u044c \u0432\u044b\u0431\u0438\u0440\u0430\u0435\u0442\u0441\u044f \u0438\u0437 \u043e\u0431\u0449\u0435\u0439 9-\u0434\u043d\u0435\u0432\u043d\u043e\u0439 \u0441\u0435\u0442\u043a\u0438.';

  return `
    <section class="card overview-card">
      <div class="overview-head">
        <div>
          <h3>${sectionTitle}</h3>
          <p class="overview-copy">${sectionCopy}</p>
        </div>
        <div class="overview-range">
          <span class="meta-pill">${escapeHtml(getScheduleRangeLabel())}</span>
        </div>
      </div>
      <div class="kpi-grid">
        <article class="kpi-card">
          <span class="kpi-label">\u0413\u043e\u0440\u0438\u0437\u043e\u043d\u0442</span>
          <strong>${escapeHtml(String(dayCount))}</strong>
          <span class="kpi-meta">\u043a\u0430\u043b\u0435\u043d\u0434\u0430\u0440\u043d\u044b\u0445 \u0434\u043d\u0435\u0439</span>
        </article>
        <article class="kpi-card">
          <span class="kpi-label">\u0417\u0430\u043d\u044f\u0442\u043e\u0441\u0442\u044c</span>
          <strong>${escapeHtml(String(summary.occupancyRate || 0))}%</strong>
          <span class="kpi-meta">${escapeHtml(String(summary.occupiedCount || 0))} / ${escapeHtml(String(summary.slotsCount || 0))} \u043e\u043a\u043e\u043d</span>
        </article>
        <article class="kpi-card">
          <span class="kpi-label">\u0421\u0432\u043e\u0431\u043e\u0434\u043d\u043e</span>
          <strong>${escapeHtml(String(summary.availableCount || 0))}</strong>
          <span class="kpi-meta">\u0434\u043b\u044f \u043d\u043e\u0432\u044b\u0445 \u0437\u0430\u043f\u0438\u0441\u0435\u0439</span>
        </article>
        <article class="kpi-card">
          <span class="kpi-label">\u041f\u0441\u0438\u0445\u043e\u043b\u043e\u0433\u0438</span>
          <strong>${escapeHtml(String(summary.providerCount || state.bootstrap?.providers?.length || 0))}</strong>
          <span class="kpi-meta">\u0432 \u0440\u0430\u0431\u043e\u0442\u0435 \u043d\u0430 \u0434\u0430\u0442\u0443</span>
        </article>
      </div>
      <div class="day-rail">
        ${(state.scheduleWindow || []).map((day) => `
          <button class="day-rail-item ${day.isActive ? 'active' : ''}" data-action="select-schedule-day" data-date="${escapeHtml(day.date)}">
            <span class="day-rail-label">${escapeHtml(formatScheduleWeekday(day.date))}</span>
            <strong>${escapeHtml(formatScheduleDate(day.date, { day: '2-digit', month: '2-digit' }))}</strong>
            <span class="day-rail-meta">${escapeHtml(String(day.occupiedCount || 0))} / ${escapeHtml(String(day.slotsCount || 0))}</span>
          </button>
        `).join('')}
      </div>
    </section>
  `;
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(error || `Request failed: ${response.status}`);
  }
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return response.json();
  return response.text();
}

async function loadCarePlans(filters = {}) {
  const params = new URLSearchParams();
  if (filters.patientId) params.set('patientId', filters.patientId);
  if (filters.primaryProviderId) params.set('primaryProviderId', filters.primaryProviderId);
  if (filters.status) params.set('status', filters.status);
  const payload = await api(`/api/care-plans?${params.toString()}`);
  state.carePlan.plans = payload.carePlans || [];
  const activePlanId = state.carePlan.activePlan?.plan_id;
  state.carePlan.activePlan = state.carePlan.plans.find((plan) => plan.plan_id === activePlanId)
    || state.carePlan.plans[0]
    || null;
  return state.carePlan.plans;
}

async function suggestCarePlanForCurrentPatient() {
  const appointmentId = state.route.appointmentId;
  const patientId = state.appointmentBundle?.patient?.patient_id;
  if (!appointmentId || !patientId) return;
  state.carePlan.loading = true;
  state.carePlan.error = '';
  state.toast = 'ИИ готовит маршрут пациента. Слоты пока не заняты.';
  render();
  try {
    const payload = await api('/api/care-plans/suggest', {
      method: 'POST',
      body: JSON.stringify({
        patientId,
        appointmentId,
        planningWindowDays: state.carePlan.planningWindowDays
      })
    });
    state.carePlan.activePlan = payload.plan;
    await loadCarePlans({ patientId });
    state.toast = `Маршрут на ${payload.plan.planning_window_days} дней подготовлен. Проверьте и подтвердите расписание.`;
  } catch (error) {
    state.carePlan.error = error.message || 'Не удалось подготовить маршрут.';
  } finally {
    state.carePlan.loading = false;
    render();
  }
}

async function patchCarePlanItem(planId, itemId, patch) {
  const payload = await api(`/api/care-plans/${encodeURIComponent(planId)}/items/${encodeURIComponent(itemId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch)
  });
  state.carePlan.activePlan = payload.plan;
  await loadCarePlans({ patientId: payload.plan.patient_id });
  render();
}

async function addCarePlanItem(planId) {
  const provider = (state.bootstrap?.providers || []).find((item) => item.care_role !== 'primary') || state.bootstrap?.providers?.[0];
  const payload = await api(`/api/care-plans/${encodeURIComponent(planId)}/items`, {
    method: 'POST',
    body: JSON.stringify({
      provider_id: provider?.provider_id,
      date: state.carePlan.activePlan?.window_start_date || state.scheduleDay?.date,
      start_time: '10:00',
      duration_min: 30,
      service_name: 'Консультация специалиста',
      reason: 'Добавлено первичным врачом.'
    })
  });
  state.carePlan.activePlan = payload.plan;
  await loadCarePlans({ patientId: payload.plan.patient_id });
  render();
}

async function deleteCarePlanItem(planId, itemId) {
  const payload = await api(`/api/care-plans/${encodeURIComponent(planId)}/items/${encodeURIComponent(itemId)}/delete`, {
    method: 'POST'
  });
  state.carePlan.activePlan = payload.plan;
  await loadCarePlans({ patientId: payload.plan.patient_id });
  render();
}

async function confirmActiveCarePlan() {
  const plan = state.carePlan.activePlan;
  if (!plan) return;
  state.carePlan.loading = true;
  state.carePlan.error = '';
  render();
  try {
    const result = await api(`/api/care-plans/${encodeURIComponent(plan.plan_id)}/confirm`, { method: 'POST' });
    state.carePlan.activePlan = result.plan;
    state.toast = result.ok
      ? 'Расписание подтверждено. Вторичные врачи получили задачи.'
      : `Есть конфликты: ${result.conflicts.length}. Исправьте слоты перед подтверждением.`;
    await loadCarePlans({ patientId: result.plan.patient_id });
    await loadSchedule(state.scheduleDay?.date || state.bootstrap?.currentDate, state.statusFilter);
  } catch (error) {
    state.carePlan.error = error.message || 'Не удалось подтвердить маршрут.';
  } finally {
    state.carePlan.loading = false;
    render();
  }
}

async function loadProviderTasks(providerId = state.providerId) {
  if (!providerId) return [];
  const params = new URLSearchParams({ providerId });
  if (state.carePlan.providerTaskStatus !== 'all') params.set('status', state.carePlan.providerTaskStatus);
  const payload = await api(`/api/providers/tasks?${params.toString()}`);
  state.carePlan.providerTasks = payload.tasks || [];
  return state.carePlan.providerTasks;
}

async function updateProviderTask(taskId, status) {
  const note = status === 'completed'
    ? window.prompt('Короткий результат для первичного врача:', '') || ''
    : '';
  await api(`/api/provider-tasks/${encodeURIComponent(taskId)}/status`, {
    method: 'POST',
    body: JSON.stringify({ status, resultNote: note })
  });
  state.toast = 'Статус вторичного врача обновлен.';
  await loadProviderTasks();
  await loadCarePlans();
  await loadSchedule(state.scheduleDay?.date || state.bootstrap?.currentDate, state.statusFilter);
  render();
}

function routeFromHash() {
  const hash = window.location.hash.replace(/^#/, '') || '/schedule';
  const parts = hash.split('/').filter(Boolean);
  if (parts[0] === 'inspection' && parts[1]) {
    return { screen: 'inspection', appointmentId: parts[1] };
  }
  if (parts[0] === 'board') {
    return { screen: 'board', appointmentId: null };
  }
  return { screen: 'schedule', appointmentId: null };
}

async function bootstrap() {
  state.route = routeFromHash();
  const payload = await api('/api/bootstrap');
  state.bootstrap = payload;
  state.scheduleDay = payload.scheduleDay;
  state.scheduleWindow = payload.scheduleWindow || [];
  state.providerId = state.providerId || payload.providers?.[0]?.provider_id || '';
  state.sourceOfTruth = payload.sourceOfTruth;
  state.scheduleGenerator.startDate = payload.scheduleDay?.date || payload.currentDate || '';
  await loadScheduleGeneratorPatients(payload.patients || []);
  await loadCarePlans();
  await loadProviderTasks(state.providerId);
  await refreshAudit();
  if (state.route.screen === 'inspection' && state.route.appointmentId) {
    await loadInspection(state.route.appointmentId);
  } else {
    await loadHints('schedule', null);
  }
  render();
}

async function refreshAudit() {
  const payload = await api('/api/audit');
  state.auditEntries = payload.auditEntries || [];
}

async function loadSchedule(date = state.scheduleDay?.date || state.bootstrap?.currentDate, status = state.statusFilter) {
  const payload = await api(`/api/schedule?date=${encodeURIComponent(date)}&status=${encodeURIComponent(status)}`);
  state.scheduleDay = payload.scheduleDay || payload;
  state.scheduleWindow = payload.scheduleWindow || state.scheduleWindow || [];
  state.bootstrap = {
    ...state.bootstrap,
    currentDate: payload.currentDate || state.bootstrap?.currentDate
  };
  state.scheduleGenerator.startDate = state.scheduleDay?.date || '';
  if (state.route.screen !== 'board') {
    state.route = { screen: 'schedule', appointmentId: null };
  }
  state.activeTab = 'inspection';
  await loadHints('schedule', null);
  render();
}

async function loadScheduleGeneratorPatients(bootstrapPatients = []) {
  let patients = [];

  try {
    const payload = await api('/api/patients/search');
    patients = payload.patients || [];
  } catch (error) {
    patients = bootstrapPatients;
  }

  if (!patients.length) {
    patients = bootstrapPatients;
  }

  state.scheduleGenerator.patients = patients;

  const hasCurrentSelection = patients.some((patient) => patient.patient_id === state.scheduleGenerator.patientId);
  if (!hasCurrentSelection) {
    state.scheduleGenerator.patientId = patients[0]?.patient_id || '';
  }
}

async function loadHints(screenId, appointmentId) {
  const payload = await api(`/api/hints?screenId=${encodeURIComponent(screenId)}${appointmentId ? `&appointmentId=${encodeURIComponent(appointmentId)}` : ''}`);
  state.hints = payload.hints || [];
}

async function loadInspection(appointmentId) {
  const payload = await api(`/api/appointments/${appointmentId}`);
  state.appointmentBundle = payload;
  state.route = { screen: 'inspection', appointmentId };
  state.activeTab ||= 'inspection';
  state.scheduleGenerator.result = null;
  state.scheduleGenerator.error = '';
  await loadCarePlans({ patientId: payload.patient?.patient_id || '' });
  await loadHints('inspection', appointmentId);
  render();
}

function currentAdvisorUi() {
  return state.appointmentBundle?.advisor_ui
    || state.appointmentBundle?.draftState?.advisor_state?.ui
    || null;
}

async function refreshInspectionContext() {
  if (state.route.screen !== 'inspection' || !state.route.appointmentId) return;
  if (inspectionRefreshPromise) return inspectionRefreshPromise;
  inspectionRefreshPromise = (async () => {
    try {
      const payload = await api(`/api/appointments/${state.route.appointmentId}`);
      state.appointmentBundle = payload;
      render();
    } finally {
      inspectionRefreshPromise = null;
    }
  })();
  return inspectionRefreshPromise;
}

async function openPatientModal(slotId) {
  const slot = state.scheduleDay?.slots?.find((item) => item.slot_id === slotId);
  const providerId = slot?.provider_id || '';
  const payload = await api(`/api/patients/search?slotId=${encodeURIComponent(slotId)}${providerId ? `&providerId=${encodeURIComponent(providerId)}` : ''}`);
  state.patientModal = {
    open: true,
    slotId,
    providerId,
    patients: payload.patients || [],
    query: '',
    selectedPatientId: null
  };
  render();
}

async function generatePsychologistScheduleRequest() {
  state.scheduleGenerator.loading = true;
  state.scheduleGenerator.error = '';
  render();

  try {
    const applyMode = state.route.screen === 'board' || state.route.screen === 'inspection';
    state.scheduleGenerator.result = await api('/api/psychologist-schedule/generate', {
      method: 'POST',
      body: JSON.stringify({
        patientId: state.scheduleGenerator.patientId,
        durationMin: Number(state.scheduleGenerator.durationMin),
        startDate: state.scheduleGenerator.startDate || state.scheduleDay?.date || state.bootstrap?.currentDate,
        apply: applyMode
      })
    });

    if (applyMode) {
      const firstAppliedDate = state.scheduleGenerator.result?.applied?.[0]?.date;
      const nextDate = firstAppliedDate || state.scheduleDay?.date || state.bootstrap?.currentDate;
      state.scheduleWindow = state.scheduleGenerator.result?.scheduleWindow || state.scheduleWindow;
      await refreshAudit();
      if (state.route.screen === 'board') {
        await loadSchedule(nextDate, state.statusFilter);
      }
    }
  } catch (error) {
    state.scheduleGenerator.error = error.message || 'Failed to generate schedule.';
  } finally {
    state.scheduleGenerator.loading = false;
    render();
  }
}

async function generateScheduleForCurrentPatient() {
  const patientId = state.appointmentBundle?.patient?.patient_id;
  if (!patientId) {
    state.toast = 'Пациент не определен. Откройте приём.';
    render();
    return;
  }
  const durationMin = Number(document.querySelector('#ntbDurationMinute')?.value || 30);
  const startDate = document.querySelector('#dtpServiceExecuteDate')?.value || state.scheduleDay?.date || state.bootstrap?.currentDate;

  state.scheduleGenerator.loading = true;
  state.scheduleGenerator.error = '';
  state.toast = 'ИИ формирует расписание на 9 рабочих дней...';
  render();

  try {
    const result = await api('/api/psychologist-schedule/generate', {
      method: 'POST',
      body: JSON.stringify({
        patientId,
        durationMin: [30, 40].includes(durationMin) ? durationMin : 30,
        startDate,
        apply: true
      })
    });
    state.scheduleGenerator.result = result;
    state.scheduleWindow = result?.scheduleWindow || state.scheduleWindow;
    state.toast = `Расписание сформировано: ${result?.applied?.length || 0} занятий назначено на 9 рабочих дней для ${formatPersonName(state.appointmentBundle?.patient?.full_name || '')}.`;
    await refreshAudit();
  } catch (error) {
    state.scheduleGenerator.error = error.message || 'Ошибка генерации расписания.';
    state.toast = 'Ошибка генерации расписания: ' + (error.message || '');
  } finally {
    state.scheduleGenerator.loading = false;
    render();
  }
}

async function searchModalPatients(query) {
  const providerQuery = state.patientModal.providerId ? `&providerId=${encodeURIComponent(state.patientModal.providerId)}` : '';
  const payload = await api(`/api/patients/search?q=${encodeURIComponent(query)}${providerQuery}`);
  state.patientModal.patients = payload.patients || [];
  render();
}

async function assignPatientToSlot() {
  if (!state.patientModal.slotId || !state.patientModal.selectedPatientId) return;
  const payload = await api(`/api/slots/${state.patientModal.slotId}/assign`, {
    method: 'POST',
    body: JSON.stringify({ patient_id: state.patientModal.selectedPatientId })
  });
  state.patientModal.open = false;
  state.toast = `Пациент ${formatPersonName(payload.patient.full_name)} назначен на слот.`;
  await refreshAudit();
  if (state.route.screen === 'board') {
    await loadSchedule(state.scheduleDay.date, state.statusFilter);
    return;
  }
  await loadInspection(payload.appointment.appointment_id);
}

async function unassignPatientFromSlot(slotId) {
  await api(`/api/slots/${slotId}/unassign`, {
    method: 'POST'
  });
  state.toast = 'Пациент снят со слота.';
  await refreshAudit();
  await loadSchedule(state.scheduleDay.date, state.statusFilter);
}

async function saveInspection(closeAfter) {
  const appointmentId = state.route.appointmentId;
  if (!appointmentId) return;

  const draft = state.appointmentBundle.appointment.inspection_draft;
  const sections = draft.medical_record_sections.map((section) => {
    if (section.kind !== 'checkbox-group') return section;
    const root = document.querySelector(`[data-section-key="${section.section_key}"]`);
    const selectedOptions = new Set(Array.from(root.querySelectorAll('input[type="checkbox"]:checked')).map((node) => node.dataset.optionKey));
    return {
      ...section,
      options: section.options.map((option) => ({ ...option, selected: selectedOptions.has(option.option_key) }))
    };
  });

  const payload = {
    appointment_id: appointmentId,
    execute_date: document.querySelector('#dtpServiceExecuteDate').value,
    execute_time: document.querySelector('#dtpServiceExecuteTime').value,
    duration_min: Number(document.querySelector('#ntbDurationMinute').value || 30),
    medical_post_id: document.querySelector('#cmbExecuteMedicalPost').value,
    service_classifier_id: document.querySelector('#cmbPerformerService').value,
    service_price_item_id: document.querySelector('#cmbPerformerServiceMo').value,
    medical_form_id: document.querySelector('#cmbMedicalForm').value,
    medical_equipment_id: document.querySelector('#cmbMedicalEquipment').value,
    complaints_text: document.querySelector('#tbComplaints').value,
    anamnesis_text: document.querySelector('#tbAnamnesis').value,
    objective_status_text: document.querySelector('#tbObjectiveStatus').value,
    appointments_text: document.querySelector('#tbAppointments').value,
    conclusion_text: document.querySelector('#tbMedicalFinal').value,
    medical_record_sections: sections,
    supplemental: {
      specialist_name: document.querySelector('#supp-specialist').value,
      completion_date: document.querySelector('#supp-completionDate').value,
      work_plan: document.querySelector('#supp-workPlan').value,
      planned_sessions: document.querySelector('#supp-plannedSessions').value,
      completed_sessions: document.querySelector('#supp-completedSessions').value,
      dynamics: document.querySelector('#supp-dynamics').value,
      recommendations: document.querySelector('#supp-recommendations').value
    }
  };

  const response = await api(`/api/appointments/${appointmentId}/save`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  await refreshAudit();
  if (response.carePlan) {
    response.autoSchedule = response.carePlan.error
      ? { error: response.carePlan.error }
      : { applied: response.carePlan.items || [] };
  }

  // Module 3: Smart Scheduling — server auto-generates schedule on primary visit
  if (response.carePlan && !response.carePlan.error) {
    state.carePlan.activePlan = response.carePlan;
    state.scheduleWindow = response.scheduleWindow || state.scheduleWindow;
    state.toast = `Запись сохранена. ИИ подготовил draft-маршрут на ${response.carePlan.planning_window_days} дней, подтвердите его вручную.`;
  } else if (response.autoSchedule?.error) {
    state.toast = 'Запись сохранена, но маршрут не удалось подготовить: ' + response.autoSchedule.error;
  } else {
    state.toast = 'Запись сохранена. Статус обновлен на «Выполнено».';
  }

  if (closeAfter) {
    window.location.hash = '#/schedule';
    await loadSchedule(response.appointment.inspection_draft.execute_date, state.statusFilter);
    return;
  }
  await loadInspection(appointmentId);
}

function renderOptionList(options, currentValue) {
  return options.map((option) => `<option value="${escapeHtml(option.value)}" ${option.value === currentValue ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('');
}

function renderPageHeader() {
  const scheduleTitle = state.bootstrap?.sourceOfTruth?.screens?.find((screen) => screen.screen_id === 'schedule')?.title || '\u0420\u0430\u0441\u043f\u0438\u0441\u0430\u043d\u0438\u0435 \u043f\u0441\u0438\u0445\u043e\u043b\u043e\u0433\u0430';
  const inspectionTitle = state.bootstrap?.sourceOfTruth?.screens?.find((screen) => screen.screen_id === 'inspection')?.title || '\u041f\u0440\u0438\u0451\u043c';
  const rangeLabel = getScheduleRangeLabel();
  const currentProvider = state.bootstrap?.providers?.find((provider) => provider.provider_id === state.providerId) || state.bootstrap?.providers?.[0];
  const title = state.route.screen === 'inspection'
    ? inspectionTitle
    : state.route.screen === 'board'
      ? '\u0414\u043e\u0441\u043a\u0430 \u0440\u0430\u0441\u043f\u0438\u0441\u0430\u043d\u0438\u044f \u043f\u0441\u0438\u0445\u043e\u043b\u043e\u0433\u043e\u0432'
      : scheduleTitle;
  const subtitle = state.route.screen === 'inspection'
    ? formatPersonName(state.appointmentBundle?.patient?.full_name || '')
    : state.route.screen === 'board'
      ? `\u0415\u0434\u0438\u043d\u044b\u0439 \u043e\u043f\u0435\u0440\u0430\u0446\u0438\u043e\u043d\u043d\u044b\u0439 \u043e\u0431\u0437\u043e\u0440 • \u041f\u0435\u0440\u0438\u043e\u0434: ${rangeLabel}`
      : `${currentProvider?.schedule_name || ''}${currentProvider?.schedule_name && rangeLabel ? ' • ' : ''}${rangeLabel ? `\u041f\u0435\u0440\u0438\u043e\u0434: ${rangeLabel}` : ''}`;
  return `
    <section class="card header-bar">
      <div>
        <h1>${escapeHtml(title)}</h1>
        ${subtitle ? `<div class="header-subtitle">${escapeHtml(subtitle)}</div>` : ''}
      </div>
      <div class="meta-list">
        <button class="ghost-button" data-action="go-schedule">\u041a\u0430\u0440\u0442\u043e\u0447\u043a\u0438</button>
        <button class="ghost-button" data-action="go-board">\u0414\u043e\u0441\u043a\u0430</button>
        <span class="meta-pill">${escapeHtml(formatScheduleDate(state.scheduleDay?.date || state.bootstrap?.currentDate || '', { day: '2-digit', month: 'long', year: 'numeric' }))}</span>
        ${state.route.screen === 'inspection' && state.appointmentBundle
          ? `<span class="status-pill ${escapeHtml(state.appointmentBundle.appointment.status)}">${state.appointmentBundle.appointment.status === 'completed' ? '\u0412\u044b\u043f\u043e\u043b\u043d\u0435\u043d\u043e' : '\u041d\u0430\u0437\u043d\u0430\u0447\u0435\u043d\u043e'}</span>`
          : ''}
      </div>
    </section>
  `;
}

function renderPsychologistSchedulePanel(mode = 'preview') {
  const generator = state.scheduleGenerator;
  const patients = generator.patients || [];
  const result = generator.result;
  const applyMode = mode === 'board';

  return `
    <section class="card scheduler-card">
      <div class="scheduler-header">
        <button class="button" data-action="generate-psychologist-schedule" ${generator.loading ? 'disabled' : ''}>
          ${generator.loading ? '\u0424\u043e\u0440\u043c\u0438\u0440\u043e\u0432\u0430\u043d\u0438\u0435...' : applyMode ? '\u0421\u0444\u043e\u0440\u043c\u0438\u0440\u043e\u0432\u0430\u0442\u044c \u0432 \u0441\u0435\u0442\u043a\u0443' : '\u0421\u0444\u043e\u0440\u043c\u0438\u0440\u043e\u0432\u0430\u0442\u044c \u0440\u0430\u0441\u043f\u0438\u0441\u0430\u043d\u0438\u0435'}
        </button>
      </div>
      <p class="scheduler-copy">${applyMode ? '\u0410\u0432\u0442\u043e\u0440\u0430\u0441\u043f\u0438\u0441\u0430\u043d\u0438\u0435 \u0441\u0440\u0430\u0437\u0443 \u0437\u0430\u043f\u0438\u0448\u0435\u0442 \u043f\u0430\u0446\u0438\u0435\u043d\u0442\u0430 \u0432 \u043e\u0431\u0449\u0443\u044e \u0441\u0435\u0442\u043a\u0443 \u043f\u0441\u0438\u0445\u043e\u043b\u043e\u0433\u043e\u0432.' : '\u041f\u0440\u0435\u0432\u044c\u044e \u0434\u043b\u044f \u043f\u0441\u0438\u0445\u043e\u043b\u043e\u0433\u0438\u0447\u0435\u0441\u043a\u0438\u0445 \u0441\u0435\u0430\u043d\u0441\u043e\u0432.'}</p>
      <div class="scheduler-controls">
        <div class="field-group">
          <label for="schedule-generator-patient">\u041f\u0430\u0446\u0438\u0435\u043d\u0442</label>
          <select id="schedule-generator-patient">
            ${patients.map((patient) => `<option value="${escapeHtml(patient.patient_id)}" ${patient.patient_id === generator.patientId ? 'selected' : ''}>${escapeHtml(formatPersonName(patient.full_name))}${patient.iin_or_local_id ? ` \u2022 ${escapeHtml(patient.iin_or_local_id)}` : ''}</option>`).join('')}
          </select>
        </div>
        <div class="field-group">
          <label>\u0417\u0430\u043d\u044f\u0442\u0438\u0439</label>
          <div class="scheduler-fixed-value">9 (\u0440\u0430\u0431\u043e\u0447\u0438\u0445 \u0434\u043d\u0435\u0439)</div>
        </div>
        <div class="field-group">
          <label for="schedule-generator-duration">\u0414\u043b\u0438\u0442\u0435\u043b\u044c\u043d\u043e\u0441\u0442\u044c</label>
          <select id="schedule-generator-duration">
            <option value="30" ${generator.durationMin === 30 ? 'selected' : ''}>30 \u043c\u0438\u043d\u0443\u0442</option>
            <option value="40" ${generator.durationMin === 40 ? 'selected' : ''}>40 \u043c\u0438\u043d\u0443\u0442</option>
          </select>
        </div>
      </div>
      ${generator.error ? `<div class="scheduler-error">${escapeHtml(generator.error)}</div>` : ''}
      ${result ? renderGeneratedPsychologistSchedule(result) : ''}
    </section>
  `;
}

function renderGeneratedPsychologistSchedule(result) {
  return `
    <div class="scheduler-results">
      <div class="scheduler-days">
        ${result.days.map((day) => `
          <article class="scheduler-day-card">
            <header class="slot-header">
              <div>
                <h4>${escapeHtml(day.date)}</h4>
                <div class="slot-subtitle">${day.appointments.length} ${day.appointments.length === 1 ? '\u0437\u0430\u043d\u044f\u0442\u0438\u0435' : '\u0437\u0430\u043d\u044f\u0442\u0438\u044f'}</div>
              </div>
            </header>
            ${day.appointments.map((appointment) => `
              <div class="scheduler-appointment">
                <strong>${escapeHtml(formatPersonName(appointment.psychologistName))}</strong>
                <span>${escapeHtml(appointment.start)} - ${escapeHtml(appointment.end)}</span>
                <span class="meta-pill">${escapeHtml(String(appointment.durationMin))} \u043c\u0438\u043d</span>
              </div>
            `).join('')}
          </article>
        `).join('')}
      </div>
      <div class="scheduler-unassigned">
        <h4>\u041d\u0435 \u0440\u0430\u0441\u043f\u0440\u0435\u0434\u0435\u043b\u0435\u043d\u043e</h4>
        ${result.unassigned.length
          ? `<ul class="scheduler-unassigned-list">${result.unassigned.map((item) => `<li>${escapeHtml(item.date)} - ${escapeHtml(item.reason)}</li>`).join('')}</ul>`
          : '<p class="scheduler-success">\u0412\u0441\u0435 \u0437\u0430\u043d\u044f\u0442\u0438\u044f \u0440\u0430\u0441\u043f\u0440\u0435\u0434\u0435\u043b\u0435\u043d\u044b.</p>'}
      </div>
    </div>
  `;
}

function providerOptions(currentProviderId) {
  return (state.bootstrap?.providers || [])
    .filter((provider) => provider.care_role !== 'primary')
    .map((provider) => `<option value="${escapeHtml(provider.provider_id)}" ${provider.provider_id === currentProviderId ? 'selected' : ''}>${escapeHtml(provider.schedule_name || provider.full_name)}</option>`)
    .join('');
}

function renderCarePlanPanel() {
  const plan = state.carePlan.activePlan;
  const providers = state.bootstrap?.providers || [];
  const canEdit = plan?.status === 'draft';
  const patientId = state.appointmentBundle?.patient?.patient_id || state.scheduleGenerator.patientId;
  const conflicts = plan?.conflicts || [];

  return `
    <section class="card care-plan-card">
      <div class="care-plan-head">
        <div>
          <h3>Маршрут пациента</h3>
          <p class="overview-copy">ИИ предлагает расписание, первичный врач редактирует и подтверждает. Слоты занимаютcя только после подтверждения.</p>
        </div>
        <div class="meta-list">
          <label class="care-window-toggle">
            <span>Горизонт</span>
            <select id="carePlanWindowDays">
              <option value="9" ${state.carePlan.planningWindowDays === 9 ? 'selected' : ''}>9 дней</option>
              <option value="7" ${state.carePlan.planningWindowDays === 7 ? 'selected' : ''}>7 дней</option>
            </select>
          </label>
          <button class="button" data-action="suggest-care-plan" ${state.carePlan.loading || !patientId ? 'disabled' : ''}>
            ${state.carePlan.loading ? 'Готовлю...' : 'Предложить маршрут'}
          </button>
        </div>
      </div>

      ${state.carePlan.error ? `<div class="scheduler-error">${escapeHtml(state.carePlan.error)}</div>` : ''}
      ${plan ? `
        <div class="care-plan-summary">
          <span class="meta-pill">${escapeHtml(plan.status_label || plan.status)}</span>
          <span class="meta-pill">${escapeHtml(plan.window_start_date)} - ${escapeHtml(plan.window_end_date)}</span>
          <span class="meta-pill">${escapeHtml(String(plan.items?.length || 0))} назначений</span>
          ${conflicts.length ? `<span class="status-pill cancelled">Конфликты: ${escapeHtml(String(conflicts.length))}</span>` : '<span class="status-pill completed">Конфликтов нет</span>'}
        </div>

        <div class="care-plan-items">
          ${(plan.items || []).map((item) => `
            <article class="care-plan-item ${conflicts.some((conflict) => conflict.item_id === item.item_id) ? 'has-conflict' : ''}">
              <div class="care-item-grid">
                <label>
                  <span>Специалист</span>
                  <select data-care-plan-field="provider_id" data-plan-id="${escapeHtml(plan.plan_id)}" data-item-id="${escapeHtml(item.item_id)}" ${canEdit ? '' : 'disabled'}>
                    ${providerOptions(item.provider_id)}
                  </select>
                </label>
                <label>
                  <span>Дата</span>
                  <input type="date" value="${escapeHtml(item.date)}" data-care-plan-field="date" data-plan-id="${escapeHtml(plan.plan_id)}" data-item-id="${escapeHtml(item.item_id)}" ${canEdit ? '' : 'disabled'} />
                </label>
                <label>
                  <span>Время</span>
                  <input type="time" value="${escapeHtml(item.start_time)}" data-care-plan-field="start_time" data-plan-id="${escapeHtml(plan.plan_id)}" data-item-id="${escapeHtml(item.item_id)}" ${canEdit ? '' : 'disabled'} />
                </label>
                <label>
                  <span>Минуты</span>
                  <select data-care-plan-field="duration_min" data-plan-id="${escapeHtml(plan.plan_id)}" data-item-id="${escapeHtml(item.item_id)}" ${canEdit ? '' : 'disabled'}>
                    <option value="30" ${Number(item.duration_min) === 30 ? 'selected' : ''}>30</option>
                    <option value="40" ${Number(item.duration_min) === 40 ? 'selected' : ''}>40</option>
                    <option value="60" ${Number(item.duration_min) === 60 ? 'selected' : ''}>60</option>
                  </select>
                </label>
              </div>
              <div class="care-item-body">
                <strong>${escapeHtml(item.service_name)}</strong>
                <span class="status-pill ${escapeHtml(item.status)}">${escapeHtml(item.status_label || item.status)}</span>
                <p>${escapeHtml(item.reason || '')}</p>
                ${item.result_note ? `<p class="task-note">Результат: ${escapeHtml(item.result_note)}</p>` : ''}
              </div>
              ${canEdit ? `
                <div class="slot-actions">
                  <button class="ghost-button" data-action="delete-care-plan-item" data-plan-id="${escapeHtml(plan.plan_id)}" data-item-id="${escapeHtml(item.item_id)}">Удалить</button>
                </div>
              ` : ''}
            </article>
          `).join('')}
        </div>

        <div class="inline-actions">
          ${canEdit ? `<button class="secondary-button" data-action="add-care-plan-item" data-plan-id="${escapeHtml(plan.plan_id)}">Добавить встречу</button>` : ''}
          ${canEdit ? `<button class="button" data-action="confirm-care-plan" data-plan-id="${escapeHtml(plan.plan_id)}" ${conflicts.length ? 'disabled' : ''}>Подтвердить расписание</button>` : ''}
        </div>

        ${conflicts.length ? `
          <div class="scheduler-unassigned">
            <h4>Конфликты</h4>
            <ul class="scheduler-unassigned-list">
              ${conflicts.map((conflict) => `<li>${escapeHtml(conflict.message || conflict.type)}</li>`).join('')}
            </ul>
          </div>
        ` : ''}
      ` : '<p class="overview-copy">Маршрут еще не создан. Сохраните приём или нажмите “Предложить маршрут”.</p>'}
    </section>
  `;
}

function renderProviderTasksPanel() {
  const providers = state.bootstrap?.providers || [];
  const tasks = state.carePlan.providerTasks || [];
  return `
    <section class="card provider-tasks-card">
      <div class="care-plan-head">
        <div>
          <h3>Задачи вторичного врача</h3>
          <p class="overview-copy">Вторичный специалист отмечает выполнение, а первичный врач видит статус в маршруте пациента.</p>
        </div>
        <div class="meta-list">
          <select id="providerTaskSelect">
            ${providers.filter((provider) => provider.care_role !== 'primary').map((provider) => `<option value="${escapeHtml(provider.provider_id)}" ${provider.provider_id === state.providerId ? 'selected' : ''}>${escapeHtml(provider.schedule_name || provider.full_name)}</option>`).join('')}
          </select>
          <button class="ghost-button" data-action="refresh-provider-tasks">Обновить</button>
        </div>
      </div>
      <div class="task-list">
        ${tasks.length ? tasks.map((task) => `
          <article class="task-card">
            <div>
              <strong>${escapeHtml(formatPersonName(task.patient?.full_name || 'Пациент'))}</strong>
              <p class="slot-subtitle">${escapeHtml(task.date)} ${escapeHtml(task.start_time)} - ${escapeHtml(task.end_time)} • ${escapeHtml(task.service_name)}</p>
              <p>${escapeHtml(task.reason || '')}</p>
              ${task.result_note ? `<p class="task-note">Комментарий: ${escapeHtml(task.result_note)}</p>` : ''}
            </div>
            <div class="task-actions">
              <span class="status-pill ${escapeHtml(task.status)}">${escapeHtml(task.status_label || task.status)}</span>
              <button class="ghost-button" data-action="provider-task-status" data-task-id="${escapeHtml(task.item_id)}" data-status="in_progress">В работе</button>
              <button class="button" data-action="provider-task-status" data-task-id="${escapeHtml(task.item_id)}" data-status="completed">Выполнено</button>
              <button class="ghost-button" data-action="provider-task-status" data-task-id="${escapeHtml(task.item_id)}" data-status="missed">Не явился</button>
            </div>
          </article>
        `).join('') : '<p class="overview-copy">У выбранного специалиста пока нет задач из маршрутов.</p>'}
      </div>
    </section>
  `;
}

function getVisibleScheduleSlots() {
  const slots = state.scheduleDay?.slots || [];
  if (!state.providerId) return slots;
  return slots.filter((slot) => slot.provider_id === state.providerId);
}

function renderSchedule() {
  const scheduleDay = state.scheduleDay;
  const visibleSlots = getVisibleScheduleSlots();
  const summary = getActiveScheduleSummary();
  return `
    ${renderScheduleOverview('schedule')}
    <section class="card operations-card" data-screen="schedule">
      <div class="operations-head">
        <div>
          <h3>\u041e\u043f\u0435\u0440\u0430\u0446\u0438\u043e\u043d\u043d\u044b\u0439 \u0434\u0435\u043d\u044c</h3>
          <p class="overview-copy">\u041f\u043e\u0434\u0440\u043e\u0431\u043d\u043e\u0435 \u0440\u0430\u0441\u043f\u0438\u0441\u0430\u043d\u0438\u0435 \u043d\u0430 ${escapeHtml(formatScheduleDate(scheduleDay.date, { day: '2-digit', month: 'long', year: 'numeric' }))}.</p>
        </div>
        <div class="meta-list">
          <span class="badge">\u0417\u0430\u043d\u044f\u0442\u043e: ${escapeHtml(String(summary.occupiedCount || 0))}</span>
          <span class="badge">\u0421\u0432\u043e\u0431\u043e\u0434\u043d\u043e: ${escapeHtml(String(summary.availableCount || 0))}</span>
        </div>
      </div>
      <div class="controls">
        <div class="field-group wide">
          <label for="dpCalendarDate">\u0414\u0430\u0442\u0430</label>
          <input id="dpCalendarDate" data-field-key="calendar-date" type="date" value="${escapeHtml(scheduleDay.date)}" />
        </div>
        <div class="field-group wide">
          <label for="cmbGridSchedules">\u0413\u0440\u0430\u0444\u0438\u043a</label>
          <select id="cmbGridSchedules" data-field-key="grid-schedule">
            ${state.bootstrap.providers.map((provider) => `<option value="${escapeHtml(provider.provider_id)}" ${provider.provider_id === state.providerId ? 'selected' : ''}>${escapeHtml(provider.schedule_name)}</option>`).join('')}
          </select>
        </div>
        <div class="field-group">
          <label for="cmbQueueTypeFilter">\u0421\u0442\u0430\u0442\u0443\u0441</label>
          <select id="cmbQueueTypeFilter">${renderOptionList(selectOptions.statusFilter, state.statusFilter)}</select>
        </div>
        <div class="inline-actions">
          <button id="btnPrevDay" class="ghost-button">\u041f\u0440\u0435\u0434\u044b\u0434\u0443\u0449\u0438\u0439 \u0434\u0435\u043d\u044c</button>
          <button id="btnNextDay" class="ghost-button">\u0421\u043b\u0435\u0434\u0443\u044e\u0449\u0438\u0439 \u0434\u0435\u043d\u044c</button>
          <button id="btnRefresh" class="secondary-button">\u041e\u0431\u043d\u043e\u0432\u0438\u0442\u044c</button>
        </div>
      </div>
      <div class="schedule-wrap">
        <div id="schedule">
          <ul class="schedule-list">
            ${visibleSlots.map((slot) => `
              <li class="slot-card" data-slot-id="${escapeHtml(slot.slot_id)}" data-appointment-id="${escapeHtml(slot.appointment_id)}" data-patient-id="${escapeHtml(slot.patient?.patient_id || '')}" data-patient-name="${escapeHtml(slot.patient?.full_name || '')}">
                <div class="slot-header">
                  <div>
                    <h3>${escapeHtml(formatPersonName(slot.patient?.full_name) || '\u0421\u0432\u043e\u0431\u043e\u0434\u043d\u043e\u0435 \u043e\u043a\u043d\u043e')}</h3>
                    <div class="slot-subtitle">${escapeHtml(slot.start_time)} - ${escapeHtml(slot.end_time)} • ${escapeHtml(slot.patient ? slot.service_name : '\u041e\u0436\u0438\u0434\u0430\u0435\u0442 \u0437\u0430\u043f\u0438\u0441\u0438 \u043f\u0430\u0446\u0438\u0435\u043d\u0442\u0430')}</div>
                  </div>
                  <span class="status-pill ${escapeHtml(slot.status)}">${slot.status === 'completed' ? '\u0412\u044b\u043f\u043e\u043b\u043d\u0435\u043d\u043e' : slot.status === 'scheduled' ? '\u041d\u0430\u0437\u043d\u0430\u0447\u0435\u043d\u043e' : '\u0421\u0432\u043e\u0431\u043e\u0434\u043d\u043e'}</span>
                </div>
                <div class="patient-tags">
                  <span class="meta-pill">\u041f\u0441\u0438\u0445\u043e\u043b\u043e\u0433: ${escapeHtml(formatPersonName(state.bootstrap.providers.find((provider) => provider.provider_id === slot.provider_id)?.short_name || state.bootstrap.providers.find((provider) => provider.provider_id === slot.provider_id)?.full_name || ''))}</span>
                  ${slot.patient ? `<span class="meta-pill">\u0418\u0418\u041d: ${escapeHtml(slot.patient.iin_or_local_id)}</span>` : ''}
                  <span class="meta-pill">${escapeHtml(slot.date)}</span>
                </div>
                <div class="slot-actions">
                  ${slot.patient ? `<button class="button" data-action="open-inspection" data-appointment-id="${escapeHtml(slot.appointment_id)}">\u041e\u0442\u043a\u0440\u044b\u0442\u044c \u043f\u0440\u0438\u0451\u043c</button>` : ''}
                  <button class="secondary-button" data-action="open-patient-modal" data-slot-id="${escapeHtml(slot.slot_id)}">${slot.patient ? '\u0418\u0437\u043c\u0435\u043d\u0438\u0442\u044c \u043f\u0430\u0446\u0438\u0435\u043d\u0442\u0430' : '\u041f\u0440\u0438\u043a\u0440\u0435\u043f\u0438\u0442\u044c \u043f\u0430\u0446\u0438\u0435\u043d\u0442\u0430'}</button>
                  ${slot.patient ? `<button class="ghost-button" data-action="unassign-slot" data-slot-id="${escapeHtml(slot.slot_id)}">\u0421\u043d\u044f\u0442\u044c \u0441 \u043f\u0440\u0438\u0451\u043c\u0430</button>` : ''}
                </div>
              </li>
            `).join('') || '<li class="slot-card"><div class="slot-header"><div><h3>\u041d\u0435\u0442 \u0441\u043b\u043e\u0442\u043e\u0432</h3><div class="slot-subtitle">\u0414\u043b\u044f \u0432\u044b\u0431\u0440\u0430\u043d\u043d\u043e\u0439 \u0434\u0430\u0442\u044b \u0441\u043b\u043e\u0442\u044b \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u044b.</div></div></div></li>'}
          </ul>
        </div>
      </div>
    </section>
  `;
}
function renderBoard() {
  const scheduleDay = state.scheduleDay;
  const providers = state.bootstrap?.providers || [];
  const timeSlots = [...new Set((scheduleDay?.slots || []).map((slot) => slot.start_time))].sort();
  const summary = getActiveScheduleSummary();
  const timeSlotMap = new Map((scheduleDay?.slots || []).map((slot) => [slot.start_time, slot.end_time]));

  return `
    ${renderPsychologistSchedulePanel('board')}
    ${renderScheduleOverview('board')}
    ${renderProviderTasksPanel()}
    <section class="card board-card" data-screen="board">
      <div class="controls board-controls">
        <div class="field-group wide">
          <label for="boardDate">\u0414\u0430\u0442\u0430</label>
          <input id="boardDate" data-action="board-date" type="date" value="${escapeHtml(scheduleDay.date)}" />
        </div>
        <div class="board-summary">
          <span><strong>\u0414\u0435\u043d\u044c:</strong> ${escapeHtml(formatScheduleDate(scheduleDay.date, { day: '2-digit', month: 'long', year: 'numeric' }))}</span>
          <span><strong>\u0417\u0430\u043d\u044f\u0442\u043e:</strong> ${escapeHtml(String(summary.occupiedCount || 0))}</span>
          <span><strong>\u0421\u0432\u043e\u0431\u043e\u0434\u043d\u043e:</strong> ${escapeHtml(String(summary.availableCount || 0))}</span>
          <span><strong>\u0412\u044b\u043f\u043e\u043b\u043d\u0435\u043d\u043e:</strong> ${escapeHtml(String(summary.completedCount || 0))}</span>
        </div>
        <div class="inline-actions">
          <button class="ghost-button" data-action="go-schedule">\u041a\u0430\u0440\u0442\u043e\u0447\u043a\u0438</button>
          <button class="secondary-button" data-action="refresh-board">\u041e\u0431\u043d\u043e\u0432\u0438\u0442\u044c \u0434\u043e\u0441\u043a\u0443</button>
        </div>
      </div>
      <div class="board-wrap">
        <div class="board-grid" style="grid-template-columns: 140px repeat(${providers.length}, minmax(240px, 1fr));">
          <div class="board-head board-time-head">\u0412\u0440\u0435\u043c\u044f</div>
          ${providers.map((provider) => `<div class="board-head">${escapeHtml(formatPersonName(provider.full_name))}<div class="board-subhead">${escapeHtml(provider.schedule_name)}</div></div>`).join('')}
          ${timeSlots.map((time) => `
            <div class="board-time-cell">${escapeHtml(time)} - ${escapeHtml(timeSlotMap.get(time) || time)}</div>
            ${providers.map((provider) => {
              const slot = scheduleDay.slots.find((item) => item.provider_id === provider.provider_id && item.start_time === time);
              return `
                <div class="board-cell ${slot?.patient ? 'occupied' : 'empty'}">
                  <div class="board-cell-top">
                    <strong>${escapeHtml(slot?.patient ? formatPersonName(slot.patient.full_name) : '\u0421\u0432\u043e\u0431\u043e\u0434\u043d\u043e')}</strong>
                    <span class="status-pill ${escapeHtml(slot?.status || 'available')}">${slot?.status === 'completed' ? '\u0412\u044b\u043f\u043e\u043b\u043d\u0435\u043d\u043e' : slot?.status === 'scheduled' ? '\u041d\u0430\u0437\u043d\u0430\u0447\u0435\u043d\u043e' : '\u0421\u0432\u043e\u0431\u043e\u0434\u043d\u043e'}</span>
                  </div>
                  <div class="board-cell-meta">${slot?.patient ? `\u0418\u0418\u041d: ${escapeHtml(slot.patient.iin_or_local_id)}` : '\u0421\u043b\u043e\u0442 \u0433\u043e\u0442\u043e\u0432 \u043a \u043d\u043e\u0432\u043e\u0439 \u0437\u0430\u043f\u0438\u0441\u0438'}</div>
                  <div class="board-cell-meta">${escapeHtml(slot?.service_name || '\u041a\u043e\u043d\u0441\u0443\u043b\u044c\u0442\u0430\u0446\u0438\u044f: \u041f\u0441\u0438\u0445\u043e\u043b\u043e\u0433')}</div>
                  <div class="board-cell-actions">
                    <button class="secondary-button" data-action="open-patient-modal" data-slot-id="${escapeHtml(slot.slot_id)}">${slot?.patient ? '\u0418\u0437\u043c\u0435\u043d\u0438\u0442\u044c' : '\u0414\u043e\u0431\u0430\u0432\u0438\u0442\u044c'}</button>
                    ${slot?.patient ? `<button class="ghost-button" data-action="open-inspection" data-appointment-id="${escapeHtml(slot.appointment_id)}">\u041e\u0442\u043a\u0440\u044b\u0442\u044c</button>` : ''}
                    ${slot?.patient ? `<button class="danger-button" data-action="unassign-slot" data-slot-id="${escapeHtml(slot.slot_id)}">\u0423\u0434\u0430\u043b\u0438\u0442\u044c</button>` : ''}
                  </div>
                </div>
              `;
            }).join('')}
          `).join('')}
        </div>
      </div>
    </section>
  `;
}
function renderReadonlyTab(title, items, renderer) {
  return `
    <div class="readonly-card" data-document-title="${escapeHtml(title)}">
      <h4>${escapeHtml(title)}</h4>
      ${items.map(renderer).join('')}
    </div>
  `;
}

function renderInspection() {
  const bundle = state.appointmentBundle;
  if (!bundle) return '';
  const { appointment, patient } = bundle;
  const draft = appointment.inspection_draft;
  const tabs = [
    ['inspection', 'Назначение'],
    ['assignments', 'Назначения'],
    ['medicalRecords', 'Медицинские записи'],
    ['dischargeSummary', 'Выписной эпикриз'],
    ['healthIndicators', 'Показатель здоровья пациента'],
    ['diaries', 'Дневниковые записи'],
    ['diagnoses', 'Диагнозы'],
    ['files', 'Файлы']
  ];

  const readonly = appointment.readonly_tabs;
  const tabBody = {
    inspection: `
      <form id="frmInspectionResult" data-screen="inspection">
        <div class="inspection-grid">
          <div class="field-group">
            <label for="dtpServiceExecuteDate">Дата выполнения</label>
            <input id="dtpServiceExecuteDate" name="dtpServiceExecuteDate" type="date" value="${escapeHtml(draft.execute_date)}" data-field-key="dtpserviceexecutedate" />
          </div>
          <div class="field-group">
            <label for="dtpServiceExecuteTime">Дата и время выполнения</label>
            <input id="dtpServiceExecuteTime" name="dtpServiceExecuteTime" type="time" value="${escapeHtml(draft.execute_time)}" data-field-key="dtpserviceexecutetime" />
          </div>
          <div class="field-group">
            <label for="ntbDurationMinute">Длительность в минутах</label>
            <input id="ntbDurationMinute" name="ntbDurationMinute" type="number" min="1" max="1200" value="${escapeHtml(draft.duration_min)}" data-field-key="ntbdurationminute" />
          </div>
          <div class="field-group">
            <label for="cmbMedicalEquipment">Медицинское оборудование</label>
            <select id="cmbMedicalEquipment" name="cmbMedicalEquipment" data-field-key="cmbmedicalequipment">${renderOptionList(selectOptions.equipment, draft.medical_equipment_id || '')}</select>
          </div>
          <div class="field-group">
            <label for="cmbExecuteMedicalPost">Медицинский пост</label>
            <select id="cmbExecuteMedicalPost" name="cmbExecuteMedicalPost" data-field-key="cmbexecutemedicalpost">${renderOptionList(selectOptions.medicalPost, draft.medical_post_id)}</select>
          </div>
          <div class="field-group">
            <label for="cmbMedicalForm">Форма</label>
            <select id="cmbMedicalForm" name="cmbMedicalForm" data-field-key="cmbmedicalform">${renderOptionList(selectOptions.medicalForms, draft.medical_form_id)}</select>
          </div>
          <div class="field-group">
            <label for="cmbPerformerService">Услуга классификатора</label>
            <select id="cmbPerformerService" name="cmbPerformerService" data-field-key="cmbperformerservice">${renderOptionList(selectOptions.serviceClassifier, draft.service_classifier_id)}</select>
          </div>
          <div class="field-group">
            <label for="cmbPerformerServiceMo">Услуга из прейскуранта</label>
            <select id="cmbPerformerServiceMo" name="cmbPerformerServiceMo" data-field-key="cmbperformerservicemo">${renderOptionList(selectOptions.servicePrice, draft.service_price_item_id)}</select>
          </div>
          <div class="field-group full">
            <label for="tbMedicalFinal">Заключение</label>
            <textarea id="tbMedicalFinal" name="tbMedicalFinal" rows="5" data-field-key="tbmedicalfinal">${escapeHtml(draft.conclusion_text)}</textarea>
          </div>
          <div class="field-group full">
            <label for="tbComplaints">Жалобы</label>
            <textarea id="tbComplaints" name="tbComplaints" rows="4" data-field-key="complaints">${escapeHtml(draft.complaints_text || '')}</textarea>
          </div>
          <div class="field-group full">
            <label for="tbAnamnesis">Анамнез</label>
            <textarea id="tbAnamnesis" name="tbAnamnesis" rows="4" data-field-key="anamnesis">${escapeHtml(draft.anamnesis_text || '')}</textarea>
          </div>
          <div class="field-group full">
            <label for="tbObjectiveStatus">Объективный статус</label>
            <textarea id="tbObjectiveStatus" name="tbObjectiveStatus" rows="5" data-field-key="objective-status">${escapeHtml(draft.objective_status_text || '')}</textarea>
          </div>
          <div class="field-group full">
            <label for="tbAppointments">Назначения</label>
            <textarea id="tbAppointments" name="tbAppointments" rows="4" data-field-key="appointments">${escapeHtml(draft.appointments_text || '')}</textarea>
          </div>
          <div class="field-group">
            <label for="supp-specialist">ФИО специалиста</label>
            <input id="supp-specialist" value="${escapeHtml(draft.supplemental.specialist_name)}" />
          </div>
          <div class="field-group">
            <label for="supp-completionDate">Дата окончания осмотра</label>
            <input id="supp-completionDate" type="date" value="${escapeHtml(draft.supplemental.completion_date)}" />
          </div>
          <div class="field-group full">
            <label for="supp-workPlan">Жұмыс жоспары / План работы</label>
            <textarea id="supp-workPlan">${escapeHtml(draft.supplemental.work_plan)}</textarea>
          </div>
          <div class="field-group">
            <label for="supp-plannedSessions">Количество планируемых занятий</label>
            <input id="supp-plannedSessions" value="${escapeHtml(draft.supplemental.planned_sessions)}" />
          </div>
          <div class="field-group">
            <label for="supp-completedSessions">Количество проведенных занятий</label>
            <input id="supp-completedSessions" value="${escapeHtml(draft.supplemental.completed_sessions)}" />
          </div>
          <div class="field-group full">
            <label for="supp-dynamics">Динамика развития</label>
            <textarea id="supp-dynamics">${escapeHtml(draft.supplemental.dynamics)}</textarea>
          </div>
          <div class="field-group full">
            <label for="supp-recommendations">Рекомендации</label>
            <textarea id="supp-recommendations">${escapeHtml(draft.supplemental.recommendations)}</textarea>
          </div>
        </div>
        <div class="inspection-grid full">
          ${draft.medical_record_sections.map((section) => `
            <section class="section-card full" data-section-key="${escapeHtml(section.section_key)}">
              <h4>${escapeHtml(section.title)}</h4>
              ${section.kind === 'checkbox-group'
                ? `<div class="checkbox-grid">${section.options.map((option) => `
                    <label class="checkbox-item">
                      <input type="checkbox" data-option-key="${escapeHtml(option.option_key)}" ${option.selected ? 'checked' : ''} />
                      <span>${escapeHtml(option.label)}</span>
                    </label>
                  `).join('')}</div>`
                : `<textarea>${escapeHtml(section.text || '')}</textarea>`}
            </section>
          `).join('')}
        </div>
        ${renderCarePlanPanel()}
        <div class="inline-actions" style="margin-top: 16px;">
          <button id="btnSaveInspectionResult" type="button" class="button" data-action="save-inspection">Сохранить</button>
          <button id="btnSaveAndCloseInspectionResult" type="button" class="secondary-button" data-action="save-close-inspection">Сохранить и закрыть</button>
          <button id="btnGenerateScheduleFromInspection" type="button" class="secondary-button" data-action="generate-schedule-from-inspection" style="background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; border: none;">
            \u{1F4C5} Сформировать расписание (9 дней)
          </button>
          <button type="button" class="ghost-button" data-action="go-schedule">Назад</button>
        </div>
        ${state.scheduleGenerator.result && state.route.screen === 'inspection' ? `
          <div class="scheduler-results" style="margin-top: 16px;">
            <h4>\u{1F4CB} Сформированное расписание</h4>
            ${renderGeneratedPsychologistSchedule(state.scheduleGenerator.result)}
          </div>
        ` : ''}
        ${state.scheduleGenerator.error && state.route.screen === 'inspection' ? `<div class="scheduler-error" style="margin-top: 8px;">${escapeHtml(state.scheduleGenerator.error)}</div>` : ''}
      </form>
    `,
    assignments: renderReadonlyTab('Назначения', readonly.assignments, (item) => `<p><strong>${escapeHtml(item.title)}</strong><br /><span class="muted">Статус: ${escapeHtml(item.status)}</span></p>`),
    medicalRecords: renderReadonlyTab('Медицинские записи', readonly.medicalRecords, (item) => `<p data-document-title="${escapeHtml(item.title)}" data-document-type="medical-record"><strong>${escapeHtml(item.title)}</strong><br /><span class="muted">Обновлено: ${escapeHtml(item.updated_at)}</span></p>`),
    dischargeSummary: renderReadonlyTab('Выписной эпикриз', readonly.dischargeSummary || [], (item) => `<article data-document-title="${escapeHtml(item.title)}" data-document-type="discharge-summary"><p><strong>${escapeHtml(item.title)}</strong><br /><span class="muted">Обновлено: ${escapeHtml(item.updated_at)}</span></p><p>${escapeHtml(item.text)}</p></article>`),
    healthIndicators: renderReadonlyTab('Показатель здоровья пациента', readonly.healthIndicators, (item) => `<p><strong>${escapeHtml(item.label)}</strong><br /><span class="muted">${escapeHtml(item.value)}</span></p>`),
    diaries: renderReadonlyTab('Дневниковые записи', readonly.diaries, (item) => `<p>${escapeHtml(item.note)}</p>`),
    diagnoses: renderReadonlyTab('Диагнозы', readonly.diagnoses, (item) => `<p><strong>${escapeHtml(item.code)}</strong><br /><span class="muted">${escapeHtml(item.label)}</span></p>`),
    files: renderReadonlyTab('Файлы', readonly.files, (item) => `<p><strong>${escapeHtml(item.name)}</strong><br /><span class="muted">Источник: ${escapeHtml(item.source)}</span></p>`)
  };

  return `
    <section class="card" data-screen="inspection" data-patient-id="${escapeHtml(patient.patient_id)}" data-patient-name="${escapeHtml(patient.full_name)}" data-appointment-id="${escapeHtml(appointment.appointment_id)}">
      <div class="inspection-summary">
        <div>
          <div class="badges">
            <span class="badge">${escapeHtml(formatPersonName(patient.full_name))}</span>
            <span class="badge">${escapeHtml(patient.iin_or_local_id)}</span>
            <span class="badge">${escapeHtml(appointment.service_name)}</span>
          </div>
          <div class="header-subtitle">${escapeHtml(patient.birth_date || '')}</div>
        </div>
        <div class="meta-list">
          <span class="status-pill ${escapeHtml(appointment.status)}">${appointment.status === 'completed' ? 'Выполнено' : 'Назначено'}</span>
          <span class="meta-pill">${escapeHtml(appointment.created_at)}</span>
        </div>
      </div>
      <div class="tab-list" id="i-navigation">
        ${tabs.map(([key, label]) => `<button class="tab-chip ${state.activeTab === key ? 'active' : ''}" data-action="switch-tab" data-tab="${escapeHtml(key)}">${escapeHtml(label)}</button>`).join('')}
      </div>
      <div class="inspection-wrap" id="i-body">${tabBody[state.activeTab]}</div>
    </section>
  `;
}

function renderAdvisorQuestionOverlay() {
  if (state.route.screen !== 'inspection') return '';
  const advisorUi = currentAdvisorUi();
  if (!advisorUi?.visible || !advisorUi.active_question) return '';
  return `
    <div class="advisor-question-overlay" data-advisor-question="active">
      <section class="advisor-question-box" aria-live="polite">
        <div class="advisor-question-label">Нужно уточнить</div>
        ${advisorUi.stage_label ? `<div class="advisor-question-stage">${escapeHtml(advisorUi.stage_label)}</div>` : ''}
        <p class="advisor-question-text">${escapeHtml(advisorUi.active_question)}</p>
      </section>
    </div>
  `;
}

function renderHints() {
  if (!state.hints || state.hints.length === 0) {
    return `
      <section class="card">
        <h3 class="panel-title">\u041f\u043e\u0434\u0441\u043a\u0430\u0437\u043a\u0438</h3>
        <ul class="hint-list">
          <li class="hint-card"><p>\u0414\u043e\u043f\u043e\u043b\u043d\u0438\u0442\u0435\u043b\u044c\u043d\u044b\u0445 \u043f\u043e\u0434\u0441\u043a\u0430\u0437\u043e\u043a \u043f\u043e\u043a\u0430 \u043d\u0435\u0442.</p></li>
        </ul>
      </section>
    `;
  }

  return `
    <section class="card">
      <h3 class="panel-title">\u041f\u043e\u0434\u0441\u043a\u0430\u0437\u043a\u0438</h3>
      <ul class="hint-list">
        ${state.hints.map((hint) => `
          <li class="hint-card">
            <p>${escapeHtml(hint.message)}</p>
          </li>
        `).join('')}
      </ul>
    </section>
  `;
}

function renderPatientModal() {
  if (!state.patientModal.open) return '';
  return `
    <div class="overlay" id="wndSearchAttachPerson">
      <div class="modal">
        <header>
          <h3 style="margin: 0;">\u041f\u0430\u0446\u0438\u0435\u043d\u0442\u044b \u043f\u0441\u0438\u0445\u043e\u043b\u043e\u0433\u0430</h3>
        </header>
        <main>
          <div class="field-group">
            <label for="modal-search">\u041f\u043e\u0438\u0441\u043a \u043f\u043e \u0424\u0418\u041e \u0438\u043b\u0438 \u0418\u0418\u041d</label>
            <input id="modal-search" value="${escapeHtml(state.patientModal.query)}" placeholder="\u041d\u0430\u0447\u043d\u0438\u0442\u0435 \u0432\u0432\u043e\u0434\u0438\u0442\u044c \u0438\u043c\u044f \u043f\u0430\u0446\u0438\u0435\u043d\u0442\u0430" />
          </div>
          <div id="grdSearchAttachPerson" class="modal-grid" style="margin-top: 18px;">
            ${state.patientModal.patients.map((patient) => `
              <article class="patient-card ${state.patientModal.selectedPatientId === patient.patient_id ? 'selected' : ''}" data-patient-id="${escapeHtml(patient.patient_id)}">
                <header>
                  <h4>${escapeHtml(formatPersonName(patient.full_name))}</h4>
                  <span class="meta-pill">${escapeHtml(formatSpecialtyTrack(patient.specialty_track))}</span>
                </header>
                <p>\u0418\u0418\u041d: ${escapeHtml(patient.iin_or_local_id)}</p>
                <p>\u0418\u0441\u0442\u043e\u0447\u043d\u0438\u043a\u0438: ${escapeHtml((patient.history_refs || []).join(', '))}</p>
                <button class="secondary-button" data-action="select-patient" data-patient-id="${escapeHtml(patient.patient_id)}">\u0412\u044b\u0431\u0440\u0430\u0442\u044c</button>
              </article>
            `).join('')}
          </div>
        </main>
        <footer>
          <button class="ghost-button" data-action="close-patient-modal">\u041e\u0442\u043c\u0435\u043d\u0430</button>
          <button id="btnAttachPersonAccept" class="button" data-action="confirm-attach-patient" ${state.patientModal.selectedPatientId ? '' : 'disabled'}>\u0417\u0430\u043f\u0438\u0441\u0430\u0442\u044c \u043d\u0430 \u043f\u0440\u0438\u0451\u043c</button>
        </footer>
      </div>
    </div>
  `;
}

function renderToast() {
  if (!state.toast) return '';
  return `<div class="toast">${escapeHtml(state.toast)}</div>`;
}

function render() {
  document.title = state.route.screen === 'inspection'
    ? (state.bootstrap?.sourceOfTruth?.screens?.find((screen) => screen.screen_id === 'inspection')?.title || '\u041f\u0440\u0438\u0451\u043c')
    : state.route.screen === 'board'
      ? '\u0414\u043e\u0441\u043a\u0430 \u0440\u0430\u0441\u043f\u0438\u0441\u0430\u043d\u0438\u044f \u043f\u0441\u0438\u0445\u043e\u043b\u043e\u0433\u043e\u0432'
      : (state.bootstrap?.sourceOfTruth?.screens?.find((screen) => screen.screen_id === 'schedule')?.title || '\u0420\u0430\u0441\u043f\u0438\u0441\u0430\u043d\u0438\u0435 \u043f\u0441\u0438\u0445\u043e\u043b\u043e\u0433\u0430');
  app.innerHTML = `
    <div class="layout">
      <main class="main-panel">
        ${renderPageHeader()}
        ${state.route.screen === 'inspection' ? renderInspection() : state.route.screen === 'board' ? renderBoard() : renderSchedule()}
      </main>
      ${renderPatientModal()}
      ${renderToast()}
    </div>
  `;
}

function clearToastSoon() {
  if (!state.toast) return;
  window.clearTimeout(clearToastSoon.timer);
  clearToastSoon.timer = window.setTimeout(() => {
    state.toast = '';
    render();
  }, 2400);
}

window.addEventListener('hashchange', async () => {
  state.route = routeFromHash();
  if (state.route.screen === 'inspection' && state.route.appointmentId) {
    await loadInspection(state.route.appointmentId);
  } else {
    await loadSchedule(state.scheduleDay?.date || state.bootstrap.currentDate, state.statusFilter);
    await loadHints(state.route.screen === 'board' ? 'schedule' : state.route.screen, null);
  }
});

window.addEventListener('damumed-assistant-refresh', async () => {
  await refreshInspectionContext();
});

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action], #btnPrevDay, #btnNextDay, #btnRefresh, #btnSaveInspectionResult, #btnSaveAndCloseInspectionResult');
  if (!target) return;

  if (target.id === 'btnPrevDay') {
    const previousDate = getAdjacentScheduleDate(-1);
    await api('/api/current-date', { method: 'POST', body: JSON.stringify({ date: previousDate }) });
    await loadSchedule(previousDate, state.statusFilter);
  }

  if (target.id === 'btnNextDay') {
    const nextDate = getAdjacentScheduleDate(1);
    await api('/api/current-date', { method: 'POST', body: JSON.stringify({ date: nextDate }) });
    await loadSchedule(nextDate, state.statusFilter);
  }

  if (target.id === 'btnRefresh') {
    await refreshAudit();
    await loadSchedule(state.scheduleDay.date, state.statusFilter);
  }

  const action = target.dataset.action;
  if (!action) return;

  if (action === 'open-inspection') {
    window.location.hash = `#/inspection/${target.dataset.appointmentId}`;
  }
  if (action === 'generate-psychologist-schedule') {
    await generatePsychologistScheduleRequest();
  }
  if (action === 'generate-schedule-from-inspection') {
    await suggestCarePlanForCurrentPatient();
  }
  if (action === 'suggest-care-plan') {
    await suggestCarePlanForCurrentPatient();
  }
  if (action === 'add-care-plan-item') {
    await addCarePlanItem(target.dataset.planId);
  }
  if (action === 'delete-care-plan-item') {
    await deleteCarePlanItem(target.dataset.planId, target.dataset.itemId);
  }
  if (action === 'confirm-care-plan') {
    await confirmActiveCarePlan();
  }
  if (action === 'refresh-provider-tasks') {
    await loadProviderTasks();
    render();
  }
  if (action === 'provider-task-status') {
    await updateProviderTask(target.dataset.taskId, target.dataset.status);
  }
  if (action === 'select-schedule-day') {
    const nextDate = target.dataset.date;
    await api('/api/current-date', { method: 'POST', body: JSON.stringify({ date: nextDate }) });
    await loadSchedule(nextDate, state.statusFilter);
  }
  if (action === 'open-patient-modal') {
    await openPatientModal(target.dataset.slotId);
  }
  if (action === 'close-patient-modal') {
    state.patientModal.open = false;
    render();
  }
  if (action === 'select-patient') {
    state.patientModal.selectedPatientId = target.dataset.patientId;
    render();
  }
  if (action === 'confirm-attach-patient') {
    await assignPatientToSlot();
  }
  if (action === 'switch-tab') {
    state.activeTab = target.dataset.tab;
    render();
  }
  if (action === 'go-schedule') {
    window.location.hash = '#/schedule';
  }
  if (action === 'go-board') {
    window.location.hash = '#/board';
  }
  if (action === 'refresh-board') {
    await refreshAudit();
    await loadSchedule(state.scheduleDay.date, state.statusFilter);
  }
  if (action === 'unassign-slot') {
    await unassignPatientFromSlot(target.dataset.slotId);
  }
  if (action === 'save-inspection') {
    await saveInspection(false);
  }
  if (action === 'save-close-inspection') {
    await saveInspection(true);
  }
  if (action === 'show-slot-audit') {
    state.toast = 'Последние audit entries показаны справа.';
    render();
  }

  clearToastSoon();
});

document.addEventListener('change', async (event) => {
  const target = event.target;
  if (target.id === 'cmbQueueTypeFilter') {
    state.statusFilter = target.value;
    await loadSchedule(state.scheduleDay.date, state.statusFilter);
  }
  if (target.id === 'cmbGridSchedules') {
    state.providerId = target.value;
    await loadProviderTasks(state.providerId);
    render();
  }
  if (target.id === 'providerTaskSelect') {
    state.providerId = target.value;
    await loadProviderTasks(state.providerId);
    render();
  }
  if (target.id === 'carePlanWindowDays') {
    state.carePlan.planningWindowDays = Number(target.value) === 7 ? 7 : 9;
    render();
  }
  if (target.dataset.carePlanField) {
    await patchCarePlanItem(target.dataset.planId, target.dataset.itemId, {
      [target.dataset.carePlanField]: target.value
    });
  }
  if (target.id === 'dpCalendarDate' || target.id === 'boardDate') {
    await api('/api/current-date', { method: 'POST', body: JSON.stringify({ date: target.value }) });
    await loadSchedule(target.value, state.statusFilter);
  }
  if (target.id === 'schedule-generator-patient') {
    state.scheduleGenerator.patientId = target.value;
    render();
  }
  if (target.id === 'schedule-generator-duration') {
    state.scheduleGenerator.durationMin = Number(target.value);
    render();
  }
});

document.addEventListener('input', async (event) => {
  const target = event.target;
  if (target.id === 'modal-search') {
    state.patientModal.query = target.value;
    await searchModalPatients(target.value);
  }

});

bootstrap().then(clearToastSoon).catch((error) => {
  app.innerHTML = `<pre>${escapeHtml(error.stack || error.message)}</pre>`;
});







