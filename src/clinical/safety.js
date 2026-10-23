'use strict';
/*
 * Medication safety checks, run when a doctor prescribes and again when a pharmacist verifies.
 *
 * check({ patient, items, currentMeds, pregnant }) -> { alerts: [...], blocking: bool }
 *   items: [{ drugCode | drugName, doseMg?, frequency, durationDays, quantity }]
 *   alerts: { level: 'contraindicated'|'major'|'moderate'|'info', type, drug, message }
 *
 * Contraindicated and major alerts are BLOCKING: the prescriber must give an override reason,
 * which is stored with the prescription and shown to the pharmacist.
 */
const F = require('./formulary');

const FREQ = { stat: 1, od: 1, nocte: 1, mane: 1, bd: 2, tds: 3, qds: 4, q4h: 6, q6h: 4, q8h: 3, q12h: 2, weekly: 1 / 7, prn: null };
const FREQ_LABEL = { stat: 'once (stat)', od: 'once daily', nocte: 'at night', mane: 'in the morning', bd: 'twice daily', tds: 'three times daily', qds: 'four times daily', q4h: 'every 4 hours', q6h: 'every 6 hours', q8h: 'every 8 hours', q12h: 'every 12 hours', weekly: 'once weekly', prn: 'when needed' };

function patientAllergyGroups(patient) {
  const groups = new Set(); const names = [];
  for (const a of (patient && patient.allergies) || []) {
    const g = a.class || F.allergyClassOf(a.substance);
    if (g) groups.add(g);
    names.push(String(a.substance || '').toLowerCase());
  }
  return { groups, names };
}
const age = dob => { if (!dob) return null; const d = new Date(dob + 'T00:00:00Z'); return (Date.now() - d.getTime()) / (365.25 * 86400e3); };

function check({ patient, items, currentMeds = [], pregnant = false }) {
  const alerts = [];
  const push = (level, type, drug, message) => alerts.push({ level, type, drug, message });
  const { groups, names } = patientAllergyGroups(patient);
  const resolved = items.map(it => ({ it, drug: F.find(it.drugCode) || F.find(it.drugName), label: (F.find(it.drugCode) || {}).name || it.drugName || it.drugCode }));
  const current = (currentMeds || []).map(m => ({ drug: F.find(m.drugCode) || F.find(m.drugName), label: m.drugName || m.drugCode })).filter(m => m.drug);
  const yrs = age(patient && patient.dob);

  if (patient && !(patient.allergies || []).length && !patient.noKnownAllergies) push('moderate', 'allergy_unknown', null, 'Allergy status has not been recorded for this patient. Ask and record it before prescribing.');

  for (const { it, drug, label } of resolved) {
    // allergy
    if (drug) {
      const hit = drug.allergy.find(g => groups.has(g));
      if (hit) push('contraindicated', 'allergy', label, 'Patient is allergic to ' + hit + ' drugs. ' + label + ' belongs to that group.');
      const cross = (drug.crossAllergy || []).find(g => groups.has(g));
      if (!hit && cross) push('major', 'allergy', label, 'Patient has a ' + cross + ' allergy. ' + label + ' can cross-react (about 1 to 2% risk). Use only if no alternative.');
    }
    const nm = String(label || '').toLowerCase();
    if (!drug && names.some(n => n && (nm.includes(n) || n.includes(nm.split(' ')[0])))) push('contraindicated', 'allergy', label, 'The patient has a recorded allergy matching ' + label + '.');
    if (!drug) push('moderate', 'unlisted', label, label + ' is not in the MediCore formulary, so interaction and dose checks could not run. Check it manually.');

    // dose, frequency, quantity
    const perDay = FREQ[it.frequency];
    if (drug && drug.maxDailyMg && it.doseMg && perDay) {
      const daily = it.doseMg * perDay;
      if (daily > drug.maxDailyMg) push('major', 'dose', label, 'Daily dose ' + daily + 'mg is above the usual adult maximum of ' + drug.maxDailyMg + 'mg.');
    }
    if (it.quantity != null && (!Number.isInteger(it.quantity) || it.quantity <= 0)) push('contraindicated', 'quantity', label, 'Quantity must be a positive whole number.');
    if (it.durationDays != null && it.durationDays > 180 && !(drug && drug.classes.some(c => ['antihypertensive', 'antidiabetic', 'statin', 'antiretroviral', 'thyroid', 'anticonvulsant'].includes(c)))) push('moderate', 'duration', label, 'Course longer than 6 months. Confirm this is intended.');
    if (yrs != null && yrs < 12) {
      if (!patient.weightKg) push('major', 'paediatric', label, 'Child under 12 with no weight recorded. Record weight and use a weight-based dose.');
      else push('info', 'paediatric', label, 'Child of ' + Math.floor(yrs) + ' years, ' + patient.weightKg + 'kg: confirm the dose is weight-based.');
      if (drug && drug.classes.includes('fluoroquinolone')) push('moderate', 'paediatric', label, 'Fluoroquinolones are generally avoided in children.');
      if (drug && drug.code === 'ASP75') push('major', 'paediatric', label, 'Aspirin is avoided in children under 16 (Reye\'s syndrome).');
    }
    if (yrs != null && yrs >= 65 && drug && drug.classes.some(c => ['benzodiazepine', 'sedating', 'tca'].includes(c))) push('moderate', 'elderly', label, 'Sedating drug in a patient over 65: fall risk.');
    if (pregnant && drug && drug.pregnancy === 'avoid') push('major', 'pregnancy', label, label + ' should be avoided in pregnancy.');
    if (pregnant && drug && drug.pregnancy === 'caution') push('moderate', 'pregnancy', label, 'Use ' + label + ' in pregnancy only if the benefit outweighs the risk.');
    if (drug && drug.controlled) push('info', 'controlled', label, label + ' is a controlled drug. It will be recorded in the controlled-drug register.');
  }

  // interactions and duplicates, within the new items and against current medicines
  const all = resolved.filter(r => r.drug).map(r => ({ drug: r.drug, label: r.label, isNew: true })).concat(current.map(c => ({ drug: c.drug, label: c.label, isNew: false })));
  const seen = new Set();
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const A = all[i], B = all[j];
      if (!A.isNew && !B.isNew) continue;
      const ta = F.tagsOf(A.drug), tb = F.tagsOf(B.drug);
      for (const r of F.RULES) {
        const hit = (ta.includes(r.a) && tb.includes(r.b)) || (ta.includes(r.b) && tb.includes(r.a));
        if (!hit) continue;
        if (r.skipSame && A.drug.code === B.drug.code) continue;
        const key = [A.drug.code, B.drug.code].sort().join('+') + r.msg;
        if (seen.has(key)) continue; seen.add(key);
        push(r.severity, 'interaction', A.label + ' + ' + B.label, r.msg + (B.isNew && A.isNew ? '' : ' (with a current medicine)'));
      }
      if (A.drug.qt && B.drug.qt && A.drug.code !== B.drug.code) {
        const key = 'qt' + [A.drug.code, B.drug.code].sort().join('+');
        if (!seen.has(key)) { seen.add(key); push('moderate', 'interaction', A.label + ' + ' + B.label, 'Both prolong the QT interval: risk of dangerous heart rhythm. Consider an ECG or an alternative.'); }
      }
      const dupClass = ['nsaid', 'penicillin', 'acei', 'arb', 'ccb', 'beta_blocker', 'statin', 'sulfonylurea', 'ssri', 'benzodiazepine', 'opioid', 'ppi', 'macrolide', 'fluoroquinolone', 'cephalosporin', 'artemisinin', 'corticosteroid', 'antihistamine'].find(c => A.drug.classes.includes(c) && B.drug.classes.includes(c));
      if (dupClass) {
        const key = 'dup' + [A.drug.code, B.drug.code].sort().join('+');
        if (!seen.has(key)) { seen.add(key); push(A.drug.code === B.drug.code ? 'major' : 'moderate', 'duplicate', A.label + ' + ' + B.label, A.drug.code === B.drug.code ? 'The same medicine appears twice.' : 'Two drugs from the same class (' + dupClass + '). Check this is intended.'); }
      }
    }
  }
  const order = { contraindicated: 0, major: 1, moderate: 2, info: 3 };
  alerts.sort((a, b) => order[a.level] - order[b.level]);
  return { alerts, blocking: alerts.some(a => a.level === 'contraindicated' || a.level === 'major') };
}

module.exports = { check, FREQ, FREQ_LABEL };
