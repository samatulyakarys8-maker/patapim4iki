import assert from 'node:assert/strict';
import { buildArtifacts, seedRuntimeState } from '../lib/dataset.mjs';
import {
  buildPsychologistsFromRuntime,
  getAvailablePsychologistSlots,
  generateNext9WorkingDays,
  generatePsychologistSchedule,
  isWorkingDay,
  overlaps
} from '../lib/scheduler.mjs';

const artifacts = buildArtifacts();
const runtime = seedRuntimeState(artifacts);

assert.ok(artifacts.screen_inventory.some((screen) => screen.screen_id === 'schedule'));
assert.ok(artifacts.screen_inventory.some((screen) => screen.screen_id === 'inspection'));
assert.ok(artifacts.field_map.some((field) => field.dom_id === 'tbMedicalFinal'));
assert.ok(artifacts.locator_registry.some((locator) => locator.preferred_selector === '#frmInspectionResult'));
assert.equal(runtime.scheduleDays.length, 9);
assert.ok(Object.values(runtime.appointments).some((appointment) => appointment.status === 'completed'));
assert.ok(runtime.patients.length >= 1);
assert.ok(runtime.patients.every((patient) => patient.patient_id && patient.full_name && patient.iin_or_local_id));
assert.ok(runtime.providers.every((provider) => Array.isArray(provider.attached_patient_ids)));
assert.equal(
  runtime.patients.some((patient) => runtime.providers.some((provider) => provider.full_name === patient.full_name)),
  false
);
assert.ok(runtime.patients.slice(1).every((patient) => patient.iin_or_local_id.startsWith('ARCH-')));
assert.ok(runtime.scheduleDays[0].slots.some((slot) => slot.status === 'available'));
assert.equal(
  runtime.scheduleDays[0].slots.filter((slot) => slot.patient_id).every((slot) => slot.patient_id === 'patient-1'),
  true
);

const workingDays = generateNext9WorkingDays('2026-04-17');
assert.equal(workingDays.length, 9);
assert.equal(workingDays[0], '2026-04-17');
assert.equal(workingDays[1], '2026-04-20');
assert.ok(workingDays.every((date) => isWorkingDay(date)));
assert.equal(isWorkingDay('2026-04-18'), false);
assert.equal(isWorkingDay('2026-04-20'), true);

assert.equal(
  overlaps(
    { date: '2026-04-20', start: '10:00', end: '10:30' },
    { date: '2026-04-20', start: '10:20', end: '10:50' }
  ),
  true
);
assert.equal(
  overlaps(
    { date: '2026-04-20', start: '10:00', end: '10:30' },
    { date: '2026-04-20', start: '10:30', end: '11:00' }
  ),
  false
);

const patient = runtime.patients[0];
const psychologists = buildPsychologistsFromRuntime(runtime);
assert.ok(psychologists.length >= 2);
const generated = generatePsychologistSchedule({
  patient,
  psychologists,
  startDate: '2026-04-17',
  sessionCount: 9
});

assert.equal(generated.patientId, patient.patient_id);
assert.equal(generated.days.length, 9);
assert.equal(generated.unassigned.length, 0);
assert.ok(generated.days.every((day) => isWorkingDay(day.date)));
assert.ok(generated.days.every((day) => day.appointments.length <= 1));
assert.deepEqual(
  generated.days.map((day) => day.date),
  workingDays
);

for (const day of generated.days) {
  for (const appointment of day.appointments) {
    assert.equal(appointment.type, 'psychologist');
    assert.equal(appointment.durationMin, 30);
    assert.notEqual(appointment.start, '13:00');
    assert.notEqual(appointment.end, '13:30');
    assert.ok(runtime.providers.some((provider) => provider.full_name === appointment.psychologistName));
    assert.equal(/^Dr\./.test(appointment.psychologistName), false);
  }
}

const psy1Slots = getAvailablePsychologistSlots(psychologists[0], '2026-04-17', 30, []);
assert.equal(psy1Slots.some((slot) => slot.start === '10:00'), false);
assert.equal(psy1Slots.some((slot) => slot.start === '10:30'), true);

const distributed = generatePsychologistSchedule({
  patient,
  psychologists,
  startDate: '2026-04-17',
  sessionCount: 5
});
assert.equal(distributed.days.length, 5);
assert.ok(distributed.days[0].date < distributed.days[distributed.days.length - 1].date);
assert.ok(distributed.days.some((day) => day.date >= '2026-04-24'));

assert.throws(
  () => generatePsychologistSchedule({
    patient,
    psychologists,
    startDate: '2026-04-17',
    sessionCount: 3,
    durationMin: 40
  }),
  /fixed 30-minute slots only/i
);

const blockedPsychologists = [1, 2, 3].map((index) => ({
  psychologist_id: `blocked-${index}`,
  full_name: `Blocked ${index}`,
  work_start: '09:00',
  work_end: '18:00',
  lunch_start: '13:00',
  lunch_end: '14:00',
  busy_slots: workingDays.flatMap((date) => [
    { date, start: '09:00', end: '13:00' },
    { date, start: '14:00', end: '18:00' }
  ])
}));

const unassigned = generatePsychologistSchedule({
  patient,
  psychologists: blockedPsychologists,
  startDate: '2026-04-17',
  sessionCount: 4
});
assert.equal(unassigned.days.length, 0);
assert.equal(unassigned.unassigned.length, 4);
assert.ok(unassigned.unassigned.every((item) => item.reason));

console.log('Smoke test passed');
