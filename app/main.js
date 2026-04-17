const state = {
  bootstrap: null,
  scheduleDay: null,
  appointmentBundle: null,
  hints: [],
  auditEntries: [],
  route: { screen: 'schedule', appointmentId: null },
  patientModal: { open: false, slotId: null, providerId: null, patients: [], query: '', selectedPatientId: null },
  statusFilter: 'all',
  activeTab: 'inspection',
  toast: '',
  sourceOfTruth: null,
  scheduleGenerator: {
    patients: [],
    patientId: '',
    sessionCount: 9,
    startDate: '',
    result: null,
    loading: false,
    error: ''
  }
};

const app = document.querySelector('#app');

const selectOptions = {
  medicalForms: [
    { value: 'medical-form-psychology', label: 'Лист психолога' },
    { value: 'medical-form-rehab', label: 'Реабилитационная форма' }
  ],
  serviceClassifier: [
    { value: 'A02.005.000', label: '(A02.005.000) Консультация: Психолог' }
  ],
  servicePrice: [
    { value: 'A02.005.000-price', label: '(A02.005.000) Консультация: Психолог' }
  ],
  medicalPost: [
    { value: 'med-post-psychology', label: 'Пост психолога' }
  ],
  equipment: [
    { value: '', label: 'Не выбрано' },
    { value: 'sensory-room', label: 'Сенсорная комната' },
    { value: 'speech-tools', label: 'Логопедический набор' }
  ],
  statusFilter: [
    { value: 'all', label: 'Все' },
    { value: 'scheduled', label: 'Назначенные' },
    { value: 'completed', label: 'Выполненные' }
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
  if (value === 'psychology-rehabilitation') return 'Психолог';
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

function routeFromHash() {
  const hash = window.location.hash.replace(/^#/, '') || '/schedule';
  const parts = hash.split('/').filter(Boolean);
  if (parts[0] === 'inspection' && parts[1]) {
    return { screen: 'inspection', appointmentId: parts[1] };
  }
  return { screen: 'schedule', appointmentId: null };
}

async function bootstrap() {
  state.route = routeFromHash();
  const payload = await api('/api/bootstrap');
  state.bootstrap = payload;
  state.scheduleDay = payload.scheduleDay;
  state.sourceOfTruth = payload.sourceOfTruth;
  state.scheduleGenerator.startDate = payload.scheduleDay?.date || payload.currentDate || '';
  await loadScheduleGeneratorPatients(payload.patients || []);
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
  state.scheduleDay = payload;
  state.scheduleGenerator.startDate = payload.date;
  state.route = { screen: 'schedule', appointmentId: null };
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
  await loadHints('inspection', appointmentId);
  render();
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
    state.scheduleGenerator.result = await api('/api/psychologist-schedule/generate', {
      method: 'POST',
      body: JSON.stringify({
        patientId: state.scheduleGenerator.patientId,
        sessionCount: Number(state.scheduleGenerator.sessionCount),
        startDate: state.scheduleGenerator.startDate || state.scheduleDay?.date || state.bootstrap?.currentDate
      })
    });
  } catch (error) {
    state.scheduleGenerator.error = error.message || 'Failed to generate schedule.';
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
  await loadInspection(payload.appointment.appointment_id);
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
  state.toast = 'Запись сохранена. Статус обновлен на «Выполнено».';
  await refreshAudit();
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
  const scheduleTitle = state.bootstrap?.sourceOfTruth?.screens?.find((screen) => screen.screen_id === 'schedule')?.title || 'Консультация и диагностика';
  const inspectionTitle = state.bootstrap?.sourceOfTruth?.screens?.find((screen) => screen.screen_id === 'inspection')?.title || 'Назначение';
  const title = state.route.screen === 'inspection' ? inspectionTitle : scheduleTitle;
  const subtitle = state.route.screen === 'inspection'
    ? formatPersonName(state.appointmentBundle?.patient?.full_name || '')
    : state.bootstrap?.providers?.[0]?.schedule_name || '';
  return `
    <section class="card header-bar">
      <div>
        <h1>${escapeHtml(title)}</h1>
        ${subtitle ? `<div class="header-subtitle">${escapeHtml(subtitle)}</div>` : ''}
      </div>
      <div class="meta-list">
        <span class="meta-pill">${escapeHtml(state.scheduleDay?.date || state.bootstrap?.currentDate || '')}</span>
        ${state.route.screen === 'inspection' && state.appointmentBundle
          ? `<span class="status-pill ${escapeHtml(state.appointmentBundle.appointment.status)}">${state.appointmentBundle.appointment.status === 'completed' ? 'Выполнено' : 'Назначено'}</span>`
          : ''}
      </div>
    </section>
  `;
}

function renderPsychologistSchedulePanel() {
  const generator = state.scheduleGenerator;
  const patients = generator.patients || [];
  const result = generator.result;

  return `
    <section class="card scheduler-card">
      <div class="scheduler-header">
        <div></div>
        <button class="button" data-action="generate-psychologist-schedule" ${generator.loading ? 'disabled' : ''}>
          ${generator.loading ? 'Формирование...' : 'Сформировать расписание'}
        </button>
      </div>
      <div class="scheduler-controls">
        <div class="field-group">
          <label for="schedule-generator-patient">Пациент</label>
          <select id="schedule-generator-patient">
            ${patients.map((patient) => `<option value="${escapeHtml(patient.patient_id)}" ${patient.patient_id === generator.patientId ? 'selected' : ''}>${escapeHtml(formatPersonName(patient.full_name))}${patient.iin_or_local_id ? ` • ${escapeHtml(patient.iin_or_local_id)}` : ''}</option>`).join('')}
          </select>
        </div>
        <div class="field-group">
          <label for="schedule-generator-session-count">Занятий</label>
          <input id="schedule-generator-session-count" type="number" min="1" max="9" value="${escapeHtml(generator.sessionCount)}" />
        </div>
        <div class="field-group">
          <label>Длительность</label>
          <div class="scheduler-fixed-value">30 минут</div>
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
                <div class="slot-subtitle">${day.appointments.length} ${day.appointments.length === 1 ? 'занятие' : 'занятия'}</div>
              </div>
            </header>
            ${day.appointments.map((appointment) => `
              <div class="scheduler-appointment">
                <strong>${escapeHtml(formatPersonName(appointment.psychologistName))}</strong>
                <span>${escapeHtml(appointment.start)} - ${escapeHtml(appointment.end)}</span>
                <span class="meta-pill">${escapeHtml(String(appointment.durationMin))} мин</span>
              </div>
            `).join('')}
          </article>
        `).join('')}
      </div>
      <div class="scheduler-unassigned">
        <h4>Не распределено</h4>
        ${result.unassigned.length
          ? `<ul class="scheduler-unassigned-list">${result.unassigned.map((item) => `<li>${escapeHtml(item.date)} - ${escapeHtml(item.reason)}</li>`).join('')}</ul>`
          : '<p class="scheduler-success">Все занятия распределены.</p>'}
      </div>
    </div>
  `;
}

function renderSchedule() {
  const scheduleDay = state.scheduleDay;
  return `
    ${renderPsychologistSchedulePanel()}
    <section class="card" data-screen="schedule">
      <div class="controls">
        <div class="field-group wide">
          <label for="dpCalendarDate">\u0414\u0430\u0442\u0430</label>
          <input id="dpCalendarDate" data-field-key="calendar-date" type="date" value="${escapeHtml(scheduleDay.date)}" />
        </div>
        <div class="field-group wide">
          <label for="cmbGridSchedules">\u0413\u0440\u0430\u0444\u0438\u043a</label>
          <select id="cmbGridSchedules" data-field-key="grid-schedule">
            <option value="provider-1">${escapeHtml(state.bootstrap.providers[0].schedule_name)}</option>
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
            ${scheduleDay.slots.map((slot) => `
              <li class="slot-card" data-slot-id="${escapeHtml(slot.slot_id)}" data-appointment-id="${escapeHtml(slot.appointment_id)}">
                <div class="slot-header">
                  <div>
                    <h3>${escapeHtml(formatPersonName(slot.patient?.full_name) || '\u0421\u0432\u043e\u0431\u043e\u0434\u043d\u043e\u0435 \u043e\u043a\u043d\u043e')}</h3>
                    <div class="slot-subtitle">${escapeHtml(slot.start_time)} - ${escapeHtml(slot.end_time)} • ${escapeHtml(slot.patient ? slot.service_name : '\u041e\u0436\u0438\u0434\u0430\u0435\u0442 \u0437\u0430\u043f\u0438\u0441\u0438 \u043f\u0430\u0446\u0438\u0435\u043d\u0442\u0430')}</div>
                  </div>
                  <span class="status-pill ${escapeHtml(slot.status)}">${slot.status === 'completed' ? '\u0412\u044b\u043f\u043e\u043b\u043d\u0435\u043d\u043e' : slot.status === 'scheduled' ? '\u041d\u0430\u0437\u043d\u0430\u0447\u0435\u043d\u043e' : '\u0421\u0432\u043e\u0431\u043e\u0434\u043d\u043e'}</span>
                </div>
                <div class="patient-tags">
                  ${slot.patient ? `<span class="meta-pill">\u0418\u0418\u041d: ${escapeHtml(slot.patient.iin_or_local_id)}</span>` : ''}
                  <span class="meta-pill">${escapeHtml(slot.date)}</span>
                </div>
                <div class="slot-actions">
                  ${slot.patient ? `<button class="button" data-action="open-inspection" data-appointment-id="${escapeHtml(slot.appointment_id)}">\u0418\u0441\u043f\u043e\u043b\u043d\u0438\u0442\u044c</button>` : ''}
                  <button class="secondary-button" data-action="open-patient-modal" data-slot-id="${escapeHtml(slot.slot_id)}">${slot.patient ? '\u041f\u0440\u0438\u043a\u0440\u0435\u043f\u043b\u0435\u043d\u043d\u044b\u0435 \u043f\u0430\u0446\u0438\u0435\u043d\u0442\u044b' : '\u041f\u0440\u0438\u043a\u0440\u0435\u043f\u0438\u0442\u044c \u043f\u0430\u0446\u0438\u0435\u043d\u0442\u0430'}</button>
                </div>
              </li>
            `).join('')}
          </ul>
        </div>
      </div>
    </section>
  `;
}

function renderReadonlyTab(title, items, renderer) {
  return `
    <div class="readonly-card">
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
        <div class="inline-actions" style="margin-top: 16px;">
          <button id="btnSaveInspectionResult" type="button" class="button" data-action="save-inspection">Сохранить</button>
          <button id="btnSaveAndCloseInspectionResult" type="button" class="secondary-button" data-action="save-close-inspection">Сохранить и закрыть</button>
          <button type="button" class="ghost-button" data-action="go-schedule">Назад</button>
        </div>
      </form>
    `,
    assignments: renderReadonlyTab('Назначения', readonly.assignments, (item) => `<p><strong>${escapeHtml(item.title)}</strong><br /><span class="muted">Статус: ${escapeHtml(item.status)}</span></p>`),
    medicalRecords: renderReadonlyTab('Медицинские записи', readonly.medicalRecords, (item) => `<p><strong>${escapeHtml(item.title)}</strong><br /><span class="muted">Обновлено: ${escapeHtml(item.updated_at)}</span></p>`),
    healthIndicators: renderReadonlyTab('Показатель здоровья пациента', readonly.healthIndicators, (item) => `<p><strong>${escapeHtml(item.label)}</strong><br /><span class="muted">${escapeHtml(item.value)}</span></p>`),
    diaries: renderReadonlyTab('Дневниковые записи', readonly.diaries, (item) => `<p>${escapeHtml(item.note)}</p>`),
    diagnoses: renderReadonlyTab('Диагнозы', readonly.diagnoses, (item) => `<p><strong>${escapeHtml(item.code)}</strong><br /><span class="muted">${escapeHtml(item.label)}</span></p>`),
    files: renderReadonlyTab('Файлы', readonly.files, (item) => `<p><strong>${escapeHtml(item.name)}</strong><br /><span class="muted">Источник: ${escapeHtml(item.source)}</span></p>`)
  };

  return `
    <section class="card" data-screen="inspection">
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

function renderHints() {
  const scheduleGuide = state.route.screen === 'schedule'
    ? `
      <div class="hint-card">
        <p><strong>\u0427\u0442\u043e \u0437\u0434\u0435\u0441\u044c \u0437\u0430 \u0447\u0442\u043e \u043e\u0442\u0432\u0435\u0447\u0430\u0435\u0442</strong></p>
        <p>\u0421\u0432\u043e\u0431\u043e\u0434\u043d\u043e \u2014 \u043e\u043a\u043d\u043e \u0431\u0435\u0437 \u0437\u0430\u043f\u0438\u0441\u0430\u043d\u043d\u043e\u0433\u043e \u043f\u0430\u0446\u0438\u0435\u043d\u0442\u0430.</p>
        <p>\u041d\u0430\u0437\u043d\u0430\u0447\u0435\u043d\u043e \u2014 \u043f\u0440\u0438\u0435\u043c \u0443\u0436\u0435 \u0437\u0430\u043f\u0438\u0441\u0430\u043d, \u0438 \u043a\u0430\u0440\u0442\u043e\u0447\u043a\u0443 \u043c\u043e\u0436\u043d\u043e \u043e\u0442\u043a\u0440\u044b\u0442\u044c.</p>
        <p>\u0412\u044b\u043f\u043e\u043b\u043d\u0435\u043d\u043e \u2014 \u043f\u0440\u0438\u0435\u043c \u0443\u0436\u0435 \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043d, \u0438 \u0437\u0430\u043f\u0438\u0441\u044c \u0437\u0430\u043f\u043e\u043b\u043d\u0435\u043d\u0430.</p>
        <p>\u041f\u0440\u0438\u043a\u0440\u0435\u043f\u0438\u0442\u044c \u043f\u0430\u0446\u0438\u0435\u043d\u0442\u0430 \u2014 \u043e\u0442\u043a\u0440\u044b\u0442\u044c \u0441\u043f\u0438\u0441\u043e\u043a \u043f\u0430\u0446\u0438\u0435\u043d\u0442\u043e\u0432 \u0438\u043c\u0435\u043d\u043d\u043e \u044d\u0442\u043e\u0433\u043e \u043f\u0441\u0438\u0445\u043e\u043b\u043e\u0433\u0430.</p>
      </div>
    `
    : '';

  return `
    <section class="card">
      <h3 class="panel-title">${state.route.screen === 'schedule' ? '\u041a\u0430\u043a \u0447\u0438\u0442\u0430\u0442\u044c \u0440\u0430\u0441\u043f\u0438\u0441\u0430\u043d\u0438\u0435' : '\u041f\u043e\u0434\u0441\u043a\u0430\u0437\u043a\u0438'}</h3>
      ${scheduleGuide}
      <ul class="hint-list">
        ${state.hints.map((hint) => `
          <li class="hint-card">
            <p>${escapeHtml(hint.message)}</p>
          </li>
        `).join('') || '<li class="hint-card"><p>\u0414\u043e\u043f\u043e\u043b\u043d\u0438\u0442\u0435\u043b\u044c\u043d\u044b\u0445 \u043f\u043e\u0434\u0441\u043a\u0430\u0437\u043e\u043a \u043f\u043e\u043a\u0430 \u043d\u0435\u0442.</p></li>'}
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
          <h3 style="margin: 0;">Прикрепленные пациенты</h3>
        </header>
        <main>
          <div class="field-group">
            <label for="modal-search">Поиск по ФИО или ИИН</label>
            <input id="modal-search" value="${escapeHtml(state.patientModal.query)}" placeholder="Начните вводить имя пациента" />
          </div>
          <div id="grdSearchAttachPerson" class="modal-grid" style="margin-top: 18px;">
            ${state.patientModal.patients.map((patient) => `
              <article class="patient-card ${state.patientModal.selectedPatientId === patient.patient_id ? 'selected' : ''}" data-patient-id="${escapeHtml(patient.patient_id)}">
                <header>
                  <h4>${escapeHtml(formatPersonName(patient.full_name))}</h4>
                  <span class="meta-pill">${escapeHtml(formatSpecialtyTrack(patient.specialty_track))}</span>
                </header>
                <p>ИИН: ${escapeHtml(patient.iin_or_local_id)}</p>
                <p>Источники: ${escapeHtml((patient.history_refs || []).join(', '))}</p>
                <button class="secondary-button" data-action="select-patient" data-patient-id="${escapeHtml(patient.patient_id)}">Выбрать</button>
              </article>
            `).join('')}
          </div>
        </main>
        <footer>
          <button class="ghost-button" data-action="close-patient-modal">Отмена</button>
          <button id="btnAttachPersonAccept" class="button" data-action="confirm-attach-patient" ${state.patientModal.selectedPatientId ? '' : 'disabled'}>Записать на прием</button>
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
    ? (state.bootstrap?.sourceOfTruth?.screens?.find((screen) => screen.screen_id === 'inspection')?.title || 'Назначение')
    : (state.bootstrap?.sourceOfTruth?.screens?.find((screen) => screen.screen_id === 'schedule')?.title || 'Консультация и диагностика');
  app.innerHTML = `
    <div class="layout">
      <main class="main-panel">
        ${renderPageHeader()}
        ${state.route.screen === 'inspection' ? renderInspection() : renderSchedule()}
      </main>
      <aside class="side-panel">
        ${renderHints()}
      </aside>
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
  }
});

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action], #btnPrevDay, #btnNextDay, #btnRefresh, #btnSaveInspectionResult, #btnSaveAndCloseInspectionResult');
  if (!target) return;

  if (target.id === 'btnPrevDay') {
    const current = new Date(state.scheduleDay.date);
    current.setDate(current.getDate() - 1);
    await api('/api/current-date', { method: 'POST', body: JSON.stringify({ date: current.toISOString().slice(0, 10) }) });
    await loadSchedule(current.toISOString().slice(0, 10), state.statusFilter);
  }

  if (target.id === 'btnNextDay') {
    const current = new Date(state.scheduleDay.date);
    current.setDate(current.getDate() + 1);
    await api('/api/current-date', { method: 'POST', body: JSON.stringify({ date: current.toISOString().slice(0, 10) }) });
    await loadSchedule(current.toISOString().slice(0, 10), state.statusFilter);
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
  if (target.id === 'dpCalendarDate') {
    await api('/api/current-date', { method: 'POST', body: JSON.stringify({ date: target.value }) });
    await loadSchedule(target.value, state.statusFilter);
  }
  if (target.id === 'schedule-generator-patient') {
    state.scheduleGenerator.patientId = target.value;
    render();
  }
});

document.addEventListener('input', async (event) => {
  const target = event.target;
  if (target.id === 'modal-search') {
    state.patientModal.query = target.value;
    await searchModalPatients(target.value);
  }
  if (target.id === 'schedule-generator-session-count') {
    const nextValue = Number(target.value || 1);
    state.scheduleGenerator.sessionCount = Math.max(1, Math.min(9, nextValue));
    if (String(state.scheduleGenerator.sessionCount) !== target.value) {
      target.value = state.scheduleGenerator.sessionCount;
    }
  }
});

bootstrap().then(clearToastSoon).catch((error) => {
  app.innerHTML = `<pre>${escapeHtml(error.stack || error.message)}</pre>`;
});
