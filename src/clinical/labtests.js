'use strict';
/*
 * Reference list of common lab tests with LOINC codes, units, adult reference ranges and
 * critical (panic) limits. Each lab's own catalogue starts from this list and can change
 * prices, ranges and turnaround. Doctors order by `code`; any lab that offers the code can
 * accept the order. Ranges are typical adult values; a lab must confirm its own ranges.
 */
const T = (code, name, o) => Object.assign({ code, name, loinc: null, specimen: 'Blood', unit: '', low: null, high: null, critLow: null, critHigh: null, qualitative: false, normalText: null, panel: null, tatHours: 24 }, o);

const TESTS = [
  T('FBC', 'Full blood count', { loinc: '58410-2', panel: ['HB', 'WBC', 'PLT', 'PCV'], tatHours: 4 }),
  T('HB', 'Haemoglobin', { loinc: '718-7', unit: 'g/dL', low: 11.5, high: 16.5, critLow: 7, critHigh: 20, tatHours: 4 }),
  T('PCV', 'Packed cell volume', { loinc: '4544-3', unit: '%', low: 36, high: 50, critLow: 20, critHigh: 60, tatHours: 4 }),
  T('WBC', 'White cell count', { loinc: '6690-2', unit: 'x10^9/L', low: 4, high: 11, critLow: 2, critHigh: 30, tatHours: 4 }),
  T('PLT', 'Platelets', { loinc: '777-3', unit: 'x10^9/L', low: 150, high: 400, critLow: 50, critHigh: 1000, tatHours: 4 }),
  T('MP', 'Malaria parasite (film)', { loinc: '32700-7', qualitative: true, normalText: 'Not seen', tatHours: 2 }),
  T('MRDT', 'Malaria rapid test', { loinc: '70569-9', qualitative: true, normalText: 'Negative', tatHours: 1 }),
  T('WIDAL', 'Widal test', { loinc: '5765-3', qualitative: true, normalText: 'Non-reactive', tatHours: 4 }),
  T('FBS', 'Fasting blood sugar', { loinc: '1558-6', unit: 'mmol/L', low: 3.9, high: 5.6, critLow: 2.5, critHigh: 25, tatHours: 2 }),
  T('RBS', 'Random blood sugar', { loinc: '2345-7', unit: 'mmol/L', low: 3.9, high: 7.8, critLow: 2.5, critHigh: 25, tatHours: 1 }),
  T('HBA1C', 'HbA1c', { loinc: '4548-4', unit: '%', low: 4, high: 5.6, tatHours: 24 }),
  T('UREA', 'Urea', { loinc: '3094-0', unit: 'mmol/L', low: 2.5, high: 7.8, critHigh: 35, tatHours: 6 }),
  T('CREAT', 'Creatinine', { loinc: '2160-0', unit: 'umol/L', low: 60, high: 110, critHigh: 500, tatHours: 6 }),
  T('NA', 'Sodium', { loinc: '2951-2', unit: 'mmol/L', low: 135, high: 145, critLow: 120, critHigh: 160, tatHours: 6 }),
  T('K', 'Potassium', { loinc: '2823-3', unit: 'mmol/L', low: 3.5, high: 5.1, critLow: 2.8, critHigh: 6.2, tatHours: 6 }),
  T('E-U-CR', 'Electrolytes, urea and creatinine', { loinc: '24362-6', panel: ['NA', 'K', 'UREA', 'CREAT'], tatHours: 6 }),
  T('ALT', 'ALT', { loinc: '1742-6', unit: 'U/L', low: 0, high: 41, critHigh: 1000, tatHours: 12 }),
  T('AST', 'AST', { loinc: '1920-8', unit: 'U/L', low: 0, high: 40, critHigh: 1000, tatHours: 12 }),
  T('LFT', 'Liver function test', { loinc: '24325-3', panel: ['ALT', 'AST', 'TBIL', 'ALB'], tatHours: 12 }),
  T('TBIL', 'Total bilirubin', { loinc: '1975-2', unit: 'umol/L', low: 3, high: 21, critHigh: 300, tatHours: 12 }),
  T('ALB', 'Albumin', { loinc: '1751-7', unit: 'g/L', low: 35, high: 50, tatHours: 12 }),
  T('CHOL', 'Total cholesterol', { loinc: '2093-3', unit: 'mmol/L', low: 0, high: 5.2, tatHours: 12 }),
  T('LIPID', 'Lipid profile', { loinc: '57698-3', panel: ['CHOL', 'HDL', 'LDL', 'TG'], tatHours: 12 }),
  T('HDL', 'HDL cholesterol', { loinc: '2085-9', unit: 'mmol/L', low: 1.0, high: 3.0, tatHours: 12 }),
  T('LDL', 'LDL cholesterol', { loinc: '13457-7', unit: 'mmol/L', low: 0, high: 3.4, tatHours: 12 }),
  T('TG', 'Triglycerides', { loinc: '2571-8', unit: 'mmol/L', low: 0, high: 1.7, tatHours: 12 }),
  T('URINE', 'Urinalysis', { loinc: '24356-8', specimen: 'Urine', qualitative: true, normalText: 'Normal', tatHours: 2 }),
  T('UCS', 'Urine culture', { loinc: '630-4', specimen: 'Urine', qualitative: true, normalText: 'No growth', tatHours: 72 }),
  T('HIV', 'HIV 1 and 2 screening', { loinc: '75622-1', qualitative: true, normalText: 'Non-reactive', tatHours: 2 }),
  T('HBSAG', 'Hepatitis B surface antigen', { loinc: '5196-1', qualitative: true, normalText: 'Negative', tatHours: 2 }),
  T('HCV', 'Hepatitis C antibody', { loinc: '13955-0', qualitative: true, normalText: 'Negative', tatHours: 2 }),
  T('VDRL', 'Syphilis (VDRL)', { loinc: '5292-8', qualitative: true, normalText: 'Non-reactive', tatHours: 4 }),
  T('PREG', 'Pregnancy test (urine hCG)', { loinc: '2106-3', specimen: 'Urine', qualitative: true, normalText: 'Negative', tatHours: 1 }),
  T('GENO', 'Haemoglobin genotype', { loinc: '4625-0', qualitative: true, normalText: null, tatHours: 24 }),
  T('BGRP', 'Blood group', { loinc: '882-1', qualitative: true, normalText: null, tatHours: 2 }),
  T('PSA', 'Prostate specific antigen', { loinc: '2857-1', unit: 'ng/mL', low: 0, high: 4, tatHours: 24 }),
  T('TSH', 'Thyroid stimulating hormone', { loinc: '3016-3', unit: 'mIU/L', low: 0.4, high: 4.0, tatHours: 24 }),
  T('INR', 'INR (prothrombin time)', { loinc: '6301-6', unit: '', low: 0.8, high: 1.2, critHigh: 5, tatHours: 4 }),
  T('ESR', 'ESR', { loinc: '4537-7', unit: 'mm/hr', low: 0, high: 20, tatHours: 2 }),
  T('STOOL', 'Stool microscopy', { loinc: '10701-0', specimen: 'Stool', qualitative: true, normalText: 'No ova or parasites seen', tatHours: 4 }),
];
const BY_CODE = Object.fromEntries(TESTS.map(x => [x.code, x]));

/** flag a result against a range. Returns { flag: 'normal'|'low'|'high'|'abnormal'|'unverified', critical: bool } */
function flag(range, value) {
  if (!range) return { flag: 'unverified', critical: false };
  if (range.qualitative || (range.low == null && range.high == null)) {
    if (range.normalText == null) return { flag: 'normal', critical: false };
    const v = String(value || '').trim().toLowerCase();
    return { flag: v === String(range.normalText).toLowerCase() ? 'normal' : 'abnormal', critical: false };
  }
  const s = String(value == null ? '' : value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return { flag: 'unverified', critical: false };
  const n = Number(s);
  const critical = (range.critLow != null && n <= range.critLow) || (range.critHigh != null && n >= range.critHigh);
  if (range.low != null && n < range.low) return { flag: 'low', critical };
  if (range.high != null && n > range.high) return { flag: 'high', critical };
  return { flag: 'normal', critical };
}

module.exports = { TESTS, BY_CODE, flag };
