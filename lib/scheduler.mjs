/**
 * @typedef {Object} Patient
 * @property {string} patient_id
 * @property {string} full_name
 *
 * @typedef {Object} BusySlot
 * @property {string} date
 * @property {string} start
 * @property {string} end
 *
 * @typedef {Object} Psychologist
 * @property {string} psychologist_id
 * @property {string} full_name
 * @property {string} work_start
 * @property {string} work_end
 * @property {string} lunch_start
 * @property {string} lunch_end
 * @property {BusySlot[]} busy_slots
 *
 * @typedef {Object} Appointment
 * @property {'psychologist'} type
 * @property {string} psychologistId
 * @property {string} psychologistName
 * @property {string} start
 * @property {string} end
 * @property {number} durationMin
 *
 * @typedef {Object} DailySchedule
 * @property {string} date
 * @property {Appointment[]} appointments
 *
 * @typedef {Object} UnassignedSession
 * @property {string} date
 * @property {number} durationMin
 * @property {string} reason
 *
 * @typedef {Object} GeneratedSchedule
 * @property {string} patientId
 * @property {DailySchedule[]} days
 * @property {UnassignedSession[]} unassigned
 */

const SESSION_DURATION_MIN = 30;
const PSYCHOLOGIST_BREAK_MIN = 15;

function normalizeDateInput(dateInput) {
  if (dateInput instanceof Date) {
    return new Date(Date.UTC(
      dateInput.getUTCFullYear() || dateInput.getFullYear(),
      dateInput.getUTCMonth() || dateInput.getMonth(),
      dateInput.getUTCDate() || dateInput.getDate()
    ));
  }

  const value = String(dateInput || '').slice(0, 10);
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) {
    throw new Error(`Invalid date input: ${dateInput}`);
  }
  return new Date(Date.UTC(year, month - 1, day));
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date, amount) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + amount);
  return next;
}

function timeToMinutes(value) {
  const [hours, minutes] = String(value).split(':').map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function expandSlotWithBreak(slot) {
  return {
    ...slot,
    start: minutesToTime(Math.max(0, timeToMinutes(slot.start) - PSYCHOLOGIST_BREAK_MIN)),
    end: minutesToTime(Math.min(24 * 60, timeToMinutes(slot.end) + PSYCHOLOGIST_BREAK_MIN))
  };
}

/**
 * @param {string | Date} dateInput
 * @returns {boolean}
 */
export function isWorkingDay(dateInput) {
  const date = normalizeDateInput(dateInput);
  const dayOfWeek = date.getUTCDay();
  return dayOfWeek !== 0 && dayOfWeek !== 6;
}

/**
 * @param {string | Date} startDate
 * @returns {string[]}
 */
export function generateNext9WorkingDays(startDate) {
  const days = [];
  let cursor = normalizeDateInput(startDate);

  while (days.length < 9) {
    if (isWorkingDay(cursor)) {
      days.push(formatDate(cursor));
    }
    cursor = addUtcDays(cursor, 1);
  }

  return days;
}

/**
 * @param {string | Date} startDate
 * @returns {string[]}
 */
export function generateNext9CalendarDays(startDate) {
  const days = [];
  let cursor = normalizeDateInput(startDate);

  while (days.length < 9) {
    days.push(formatDate(cursor));
    cursor = addUtcDays(cursor, 1);
  }

  return days;
}

/**
 * @param {BusySlot} left
 * @param {BusySlot} right
 * @returns {boolean}
 */
export function overlaps(left, right) {
  if (left.date !== right.date) return false;
  return Math.max(timeToMinutes(left.start), timeToMinutes(right.start)) < Math.min(timeToMinutes(left.end), timeToMinutes(right.end));
}

/**
 * @returns {Psychologist[]}
 */
export function generateMockPsychologists() {
  return [
    {
      psychologist_id: 'provider-1',
      full_name: 'Жанна Батыргалиева',
      work_start: '09:00',
      work_end: '18:00',
      lunch_start: '13:00',
      lunch_end: '14:00',
      busy_slots: [
        { date: '2026-04-18', start: '09:00', end: '10:00' },
        { date: '2026-04-19', start: '15:00', end: '16:00' },
        { date: '2026-04-20', start: '09:00', end: '10:00' },
        { date: '2026-04-21', start: '09:00', end: '09:30' },
        { date: '2026-04-22', start: '10:00', end: '11:00' },
        { date: '2026-04-23', start: '09:00', end: '09:30' },
        { date: '2026-04-24', start: '09:00', end: '10:30' },
        { date: '2026-04-25', start: '14:00', end: '15:00' },
        { date: '2026-04-26', start: '11:00', end: '12:00' }
      ]
    },
    {
      psychologist_id: 'provider-2',
      full_name: 'Айжан Серикбаева',
      work_start: '09:00',
      work_end: '18:00',
      lunch_start: '13:00',
      lunch_end: '14:00',
      busy_slots: [
        { date: '2026-04-18', start: '10:00', end: '10:30' },
        { date: '2026-04-19', start: '09:00', end: '10:00' },
        { date: '2026-04-20', start: '10:00', end: '11:00' },
        { date: '2026-04-21', start: '09:00', end: '10:00' },
        { date: '2026-04-22', start: '09:00', end: '09:30' },
        { date: '2026-04-23', start: '10:00', end: '11:30' },
        { date: '2026-04-24', start: '09:00', end: '09:30' },
        { date: '2026-04-25', start: '15:00', end: '16:00' },
        { date: '2026-04-26', start: '09:00', end: '10:00' }
      ]
    },
    {
      psychologist_id: 'provider-3',
      full_name: 'Динара Касымова',
      work_start: '09:00',
      work_end: '18:00',
      lunch_start: '13:00',
      lunch_end: '14:00',
      busy_slots: [
        { date: '2026-04-18', start: '16:00', end: '17:00' },
        { date: '2026-04-19', start: '10:00', end: '11:00' },
        { date: '2026-04-20', start: '09:00', end: '09:30' },
        { date: '2026-04-21', start: '10:30', end: '11:00' },
        { date: '2026-04-22', start: '09:00', end: '10:00' },
        { date: '2026-04-23', start: '09:30', end: '10:00' },
        { date: '2026-04-24', start: '10:00', end: '11:00' },
        { date: '2026-04-25', start: '09:00', end: '09:30' },
        { date: '2026-04-26', start: '10:00', end: '11:00' }
      ]
    }
  ];
}

/**
 * @param {{ providers?: Array<any> }} runtime
 * @returns {Psychologist[]}
 */
export function buildPsychologistsFromRuntime(runtime) {
  const providers = Array.isArray(runtime?.providers) ? runtime.providers : [];
  const mappedProviders = providers
    .filter((provider) => /психолог|psycholog|РїСЃРёС…РѕР»РѕРі/i.test(String(provider.specialty || provider.schedule_name || '')))
    .map((provider) => ({
      psychologist_id: provider.provider_id,
      full_name: provider.full_name || provider.short_name || 'Психолог',
      work_start: '09:00',
      work_end: '18:00',
      lunch_start: '13:00',
      lunch_end: '14:00',
      busy_slots: Array.isArray(provider.scheduler_busy_slots) ? provider.scheduler_busy_slots : []
    }));

  return mappedProviders.length ? mappedProviders : generateMockPsychologists();
}

function selectDistributedDates(days, sessionCount) {
  if (sessionCount >= days.length) return days.slice();
  if (sessionCount === 1) return [days[0]];

  const indices = [];
  const used = new Set();

  for (let step = 0; step < sessionCount; step += 1) {
    let index = Math.round((step * (days.length - 1)) / (sessionCount - 1));

    while (used.has(index) && index < days.length - 1) index += 1;
    while (used.has(index) && index > 0) index -= 1;

    used.add(index);
    indices.push(index);
  }

  return indices.sort((left, right) => left - right).map((index) => days[index]);
}

/**
 * @param {Psychologist} psychologist
 * @param {string} date
 * @param {number} durationMin
 * @param {BusySlot[]} takenSlots
 * @returns {Appointment[]}
 */
export function getAvailablePsychologistSlots(psychologist, date, durationMin, takenSlots = []) {
  if (durationMin !== SESSION_DURATION_MIN) {
    throw new Error(`Psychologist sessions currently support fixed ${SESSION_DURATION_MIN}-minute slots only.`);
  }

  const workStart = timeToMinutes(psychologist.work_start);
  const workEnd = timeToMinutes(psychologist.work_end);
  const blockedSlots = [
    ...(psychologist.busy_slots || []).filter((slot) => slot.date === date).map(expandSlotWithBreak),
    { date, start: psychologist.lunch_start, end: psychologist.lunch_end },
    ...takenSlots.filter((slot) => slot.date === date).map(expandSlotWithBreak)
  ];

  const available = [];

  for (let startMinutes = workStart; startMinutes + durationMin <= workEnd; startMinutes += 30) {
    const candidate = {
      date,
      start: minutesToTime(startMinutes),
      end: minutesToTime(startMinutes + durationMin)
    };

    if (blockedSlots.some((slot) => overlaps(candidate, slot))) continue;

    available.push({
      type: 'psychologist',
      psychologistId: psychologist.psychologist_id,
      psychologistName: psychologist.full_name,
      start: candidate.start,
      end: candidate.end,
      durationMin
    });
  }

  return available;
}

/**
 * @param {{
 *   patient: Patient,
 *   psychologists: Psychologist[],
 *   startDate?: string,
 *   sessionCount?: number,
 *   durationMin?: number
 * }} input
 * @returns {GeneratedSchedule}
 */
export function generatePsychologistSchedule(input) {
  const patient = input?.patient;
  const psychologists = Array.isArray(input?.psychologists) ? input.psychologists : [];
  const durationMin = SESSION_DURATION_MIN;
  const requestedSessionCount = Number(input?.sessionCount || 9);
  const sessionCount = Math.max(1, Math.min(9, requestedSessionCount));
  const startDate = input?.startDate || formatDate(new Date());

  if (!patient?.patient_id) {
    throw new Error('Patient is required.');
  }

  if (input?.durationMin != null && Number(input.durationMin) !== SESSION_DURATION_MIN) {
    throw new Error(`Psychologist sessions currently support fixed ${SESSION_DURATION_MIN}-minute slots only.`);
  }

  const calendarDays = generateNext9CalendarDays(startDate);
  const targetDates = selectDistributedDates(calendarDays, sessionCount);
  const takenSlots = [];
  const days = [];
  const unassigned = [];

  for (const date of targetDates) {
    const candidateSlots = psychologists
      .flatMap((psychologist, psychologistIndex) => getAvailablePsychologistSlots(
        psychologist,
        date,
        durationMin,
        takenSlots.filter((slot) => slot.psychologistId === psychologist.psychologist_id)
      ).map((slot) => ({ ...slot, psychologistIndex })))
      .sort((left, right) => {
        const timeDelta = timeToMinutes(left.start) - timeToMinutes(right.start);
        if (timeDelta !== 0) return timeDelta;
        return left.psychologistIndex - right.psychologistIndex;
      });

    const selected = candidateSlots[0];

    if (!selected) {
      unassigned.push({
        date,
        durationMin,
        reason: 'No free psychologist slot available on this calendar day.'
      });
      continue;
    }

    takenSlots.push({
      date,
      start: selected.start,
      end: selected.end,
      psychologistId: selected.psychologistId
    });

    days.push({
      date,
      appointments: [{
        type: 'psychologist',
        psychologistId: selected.psychologistId,
        psychologistName: selected.psychologistName,
        start: selected.start,
        end: selected.end,
        durationMin: selected.durationMin
      }]
    });
  }

  return {
    patientId: patient.patient_id,
    days,
    unassigned
  };
}
