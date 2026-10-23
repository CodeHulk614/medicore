'use strict';
/*
 * MediCore formulary: common medicines in Nigerian practice, with the facts the safety
 * checker needs. This is decision SUPPORT, not a replacement for clinical judgement or a
 * licensed drug database. Before go-live a pharmacist should review and extend this list;
 * a licensed interaction database can replace interactions() without changing callers.
 *
 * Each entry:
 *   code, name, classes (therapeutic class tags, used for duplicates and interactions),
 *   allergy (allergy groups a reaction to which forbids this drug), unitMg (mg per tablet /
 *   unit where it applies), maxDailyMg (usual adult maximum), pregnancy ('avoid' | 'caution'),
 *   controlled (needs controlled-drug register), qt (prolongs QT interval)
 */
const D = (code, name, o) => Object.assign({ code, name, classes: [], allergy: [], maxDailyMg: null, unitMg: null, pregnancy: null, controlled: false, qt: false }, o);

const DRUGS = [
  // analgesics / NSAIDs
  D('PARA500', 'Paracetamol 500mg tablet', { classes: ['analgesic'], unitMg: 500, maxDailyMg: 4000 }),
  D('PARA1G', 'Paracetamol 1g tablet', { classes: ['analgesic'], unitMg: 1000, maxDailyMg: 4000 }),
  D('IBU400', 'Ibuprofen 400mg tablet', { classes: ['nsaid'], allergy: ['nsaid'], unitMg: 400, maxDailyMg: 2400, pregnancy: 'avoid' }),
  D('DICLO50', 'Diclofenac 50mg tablet', { classes: ['nsaid'], allergy: ['nsaid'], unitMg: 50, maxDailyMg: 150, pregnancy: 'avoid' }),
  D('ASP75', 'Aspirin 75mg tablet', { classes: ['nsaid', 'antiplatelet'], allergy: ['nsaid', 'aspirin'], unitMg: 75, maxDailyMg: 4000 }),
  D('TRAM50', 'Tramadol 50mg capsule', { classes: ['opioid', 'serotonergic'], allergy: ['opioid'], unitMg: 50, maxDailyMg: 400, controlled: true }),
  D('COD30', 'Codeine 30mg tablet', { classes: ['opioid'], allergy: ['opioid'], unitMg: 30, maxDailyMg: 240, controlled: true }),
  D('MORPH10', 'Morphine 10mg tablet', { classes: ['opioid'], allergy: ['opioid'], unitMg: 10, maxDailyMg: 200, controlled: true }),
  // penicillins and other antibiotics
  D('AMOX500', 'Amoxicillin 500mg capsule', { classes: ['penicillin', 'antibiotic'], allergy: ['penicillin'], unitMg: 500, maxDailyMg: 3000 }),
  D('AUG625', 'Amoxicillin-clavulanate 625mg tablet', { classes: ['penicillin', 'antibiotic'], allergy: ['penicillin'], unitMg: 625, maxDailyMg: 3750 }),
  D('AMPICLOX500', 'Ampicillin-cloxacillin 500mg capsule', { classes: ['penicillin', 'antibiotic'], allergy: ['penicillin'], unitMg: 500, maxDailyMg: 4000 }),
  D('PENV250', 'Phenoxymethylpenicillin 250mg tablet', { classes: ['penicillin', 'antibiotic'], allergy: ['penicillin'], unitMg: 250, maxDailyMg: 2000 }),
  D('BPEN24', 'Benzathine penicillin 2.4MU injection', { classes: ['penicillin', 'antibiotic'], allergy: ['penicillin'] }),
  D('CEFUR500', 'Cefuroxime 500mg tablet', { classes: ['cephalosporin', 'antibiotic'], allergy: ['cephalosporin'], crossAllergy: ['penicillin'], unitMg: 500, maxDailyMg: 1000 }),
  D('CEFTRI1G', 'Ceftriaxone 1g injection', { classes: ['cephalosporin', 'antibiotic'], allergy: ['cephalosporin'], crossAllergy: ['penicillin'], unitMg: 1000, maxDailyMg: 4000 }),
  D('CEPHA500', 'Cephalexin 500mg capsule', { classes: ['cephalosporin', 'antibiotic'], allergy: ['cephalosporin'], crossAllergy: ['penicillin'], unitMg: 500, maxDailyMg: 4000 }),
  D('AZI500', 'Azithromycin 500mg tablet', { classes: ['macrolide', 'antibiotic'], allergy: ['macrolide'], unitMg: 500, maxDailyMg: 500, qt: true }),
  D('ERY500', 'Erythromycin 500mg tablet', { classes: ['macrolide', 'antibiotic', 'cyp3a4_inhibitor'], allergy: ['macrolide'], unitMg: 500, maxDailyMg: 4000, qt: true }),
  D('CLARI500', 'Clarithromycin 500mg tablet', { classes: ['macrolide', 'antibiotic', 'cyp3a4_inhibitor'], allergy: ['macrolide'], unitMg: 500, maxDailyMg: 1000, qt: true }),
  D('CIPRO500', 'Ciprofloxacin 500mg tablet', { classes: ['fluoroquinolone', 'antibiotic', 'chelates'], allergy: ['fluoroquinolone'], unitMg: 500, maxDailyMg: 1500, qt: true, pregnancy: 'avoid' }),
  D('LEVO500', 'Levofloxacin 500mg tablet', { classes: ['fluoroquinolone', 'antibiotic', 'chelates'], allergy: ['fluoroquinolone'], unitMg: 500, maxDailyMg: 750, qt: true, pregnancy: 'avoid' }),
  D('METRO400', 'Metronidazole 400mg tablet', { classes: ['nitroimidazole', 'antibiotic', 'warfarin_potentiator'], allergy: ['metronidazole'], unitMg: 400, maxDailyMg: 2400 }),
  D('DOXY100', 'Doxycycline 100mg capsule', { classes: ['tetracycline', 'antibiotic', 'chelates'], allergy: ['tetracycline'], unitMg: 100, maxDailyMg: 200, pregnancy: 'avoid' }),
  D('COTRI960', 'Co-trimoxazole 960mg tablet', { classes: ['sulfonamide', 'antibiotic', 'warfarin_potentiator', 'folate_antagonist'], allergy: ['sulfonamide'], unitMg: 960, maxDailyMg: 3840, pregnancy: 'caution' }),
  D('NITRO100', 'Nitrofurantoin 100mg capsule', { classes: ['antibiotic'], allergy: ['nitrofurantoin'], unitMg: 100, maxDailyMg: 400 }),
  // antimalarials
  D('AL2040', 'Artemether-lumefantrine 20/120mg tablet', { classes: ['antimalarial', 'artemisinin'], allergy: ['artemisinin'], qt: true }),
  D('ARTES60', 'Artesunate 60mg injection', { classes: ['antimalarial', 'artemisinin'], allergy: ['artemisinin'] }),
  D('ASAQ', 'Artesunate-amodiaquine tablet', { classes: ['antimalarial', 'artemisinin'], allergy: ['artemisinin'] }),
  D('QUIN300', 'Quinine 300mg tablet', { classes: ['antimalarial'], allergy: ['quinine'], unitMg: 300, maxDailyMg: 1800, qt: true }),
  D('SP', 'Sulfadoxine-pyrimethamine tablet', { classes: ['antimalarial', 'sulfonamide', 'folate_antagonist'], allergy: ['sulfonamide'] }),
  D('CQ250', 'Chloroquine 250mg tablet', { classes: ['antimalarial'], allergy: ['chloroquine'], qt: true }),
  // diabetes
  D('METF500', 'Metformin 500mg tablet', { classes: ['biguanide', 'antidiabetic'], unitMg: 500, maxDailyMg: 3000 }),
  D('GLIB5', 'Glibenclamide 5mg tablet', { classes: ['sulfonylurea', 'antidiabetic'], unitMg: 5, maxDailyMg: 15 }),
  D('GLIC80', 'Gliclazide 80mg tablet', { classes: ['sulfonylurea', 'antidiabetic'], unitMg: 80, maxDailyMg: 320 }),
  D('INSR', 'Insulin soluble (regular) injection', { classes: ['insulin', 'antidiabetic'] }),
  // cardiovascular
  D('AMLO5', 'Amlodipine 5mg tablet', { classes: ['ccb', 'antihypertensive'], unitMg: 5, maxDailyMg: 10 }),
  D('AMLO10', 'Amlodipine 10mg tablet', { classes: ['ccb', 'antihypertensive'], unitMg: 10, maxDailyMg: 10 }),
  D('NIFE20', 'Nifedipine 20mg retard tablet', { classes: ['ccb', 'antihypertensive'], unitMg: 20, maxDailyMg: 90 }),
  D('LISI10', 'Lisinopril 10mg tablet', { classes: ['acei', 'antihypertensive', 'raises_potassium'], allergy: ['acei'], unitMg: 10, maxDailyMg: 80, pregnancy: 'avoid' }),
  D('ENAL10', 'Enalapril 10mg tablet', { classes: ['acei', 'antihypertensive', 'raises_potassium'], allergy: ['acei'], unitMg: 10, maxDailyMg: 40, pregnancy: 'avoid' }),
  D('LOSA50', 'Losartan 50mg tablet', { classes: ['arb', 'antihypertensive', 'raises_potassium'], unitMg: 50, maxDailyMg: 100, pregnancy: 'avoid' }),
  D('HCTZ25', 'Hydrochlorothiazide 25mg tablet', { classes: ['thiazide', 'antihypertensive', 'lowers_potassium'], unitMg: 25, maxDailyMg: 50 }),
  D('FURO40', 'Furosemide 40mg tablet', { classes: ['loop_diuretic', 'lowers_potassium'], unitMg: 40, maxDailyMg: 600 }),
  D('SPIRO25', 'Spironolactone 25mg tablet', { classes: ['k_sparing', 'raises_potassium'], unitMg: 25, maxDailyMg: 400 }),
  D('ATEN50', 'Atenolol 50mg tablet', { classes: ['beta_blocker', 'antihypertensive'], unitMg: 50, maxDailyMg: 100 }),
  D('PROP40', 'Propranolol 40mg tablet', { classes: ['beta_blocker', 'antihypertensive'], unitMg: 40, maxDailyMg: 320 }),
  D('MDOPA250', 'Methyldopa 250mg tablet', { classes: ['antihypertensive'], unitMg: 250, maxDailyMg: 3000 }),
  D('ATOR20', 'Atorvastatin 20mg tablet', { classes: ['statin'], unitMg: 20, maxDailyMg: 80, pregnancy: 'avoid' }),
  D('SIMV20', 'Simvastatin 20mg tablet', { classes: ['statin', 'cyp3a4_statin'], unitMg: 20, maxDailyMg: 40, pregnancy: 'avoid' }),
  D('WARF5', 'Warfarin 5mg tablet', { classes: ['anticoagulant', 'warfarin'], unitMg: 5, maxDailyMg: 15, pregnancy: 'avoid' }),
  D('CLOP75', 'Clopidogrel 75mg tablet', { classes: ['antiplatelet'], unitMg: 75, maxDailyMg: 300 }),
  D('ISDN10', 'Isosorbide dinitrate 10mg tablet', { classes: ['nitrate'], unitMg: 10, maxDailyMg: 240 }),
  D('DIGO25', 'Digoxin 0.25mg tablet', { classes: ['digoxin'], unitMg: 0.25, maxDailyMg: 0.5 }),
  D('SILD50', 'Sildenafil 50mg tablet', { classes: ['pde5'], unitMg: 50, maxDailyMg: 100 }),
  // GI
  D('OMEP20', 'Omeprazole 20mg capsule', { classes: ['ppi'], unitMg: 20, maxDailyMg: 80 }),
  D('METOC10', 'Metoclopramide 10mg tablet', { classes: ['antiemetic'], unitMg: 10, maxDailyMg: 30 }),
  D('LOPE2', 'Loperamide 2mg capsule', { classes: ['antidiarrhoeal'], unitMg: 2, maxDailyMg: 16 }),
  D('ORS', 'Oral rehydration salts sachet', { classes: ['ors'] }),
  D('ZINC20', 'Zinc sulfate 20mg tablet', { classes: ['mineral', 'chelator_agent'], unitMg: 20, maxDailyMg: 40 }),
  D('ANTACID', 'Magnesium trisilicate / antacid tablet', { classes: ['antacid', 'chelator_agent'] }),
  // anti-infective others
  D('ALB400', 'Albendazole 400mg tablet', { classes: ['anthelmintic'], unitMg: 400, maxDailyMg: 800, pregnancy: 'avoid' }),
  D('MEBE100', 'Mebendazole 100mg tablet', { classes: ['anthelmintic'], unitMg: 100, maxDailyMg: 200, pregnancy: 'avoid' }),
  D('FLUC150', 'Fluconazole 150mg capsule', { classes: ['azole_antifungal', 'warfarin_potentiator', 'cyp3a4_inhibitor'], allergy: ['azole'], unitMg: 150, maxDailyMg: 800, qt: true, pregnancy: 'caution' }),
  D('TLD', 'Tenofovir-lamivudine-dolutegravir tablet', { classes: ['antiretroviral', 'integrase'] }),
  // respiratory / allergy / steroids
  D('SALB4', 'Salbutamol 4mg tablet', { classes: ['beta_agonist'], unitMg: 4, maxDailyMg: 32 }),
  D('SALBINH', 'Salbutamol 100mcg inhaler', { classes: ['beta_agonist'] }),
  D('PRED5', 'Prednisolone 5mg tablet', { classes: ['corticosteroid'], unitMg: 5, maxDailyMg: 80 }),
  D('DEXA4', 'Dexamethasone 4mg injection', { classes: ['corticosteroid'], unitMg: 4, maxDailyMg: 40 }),
  D('CETI10', 'Cetirizine 10mg tablet', { classes: ['antihistamine'], unitMg: 10, maxDailyMg: 10 }),
  D('LORA10', 'Loratadine 10mg tablet', { classes: ['antihistamine'], unitMg: 10, maxDailyMg: 10 }),
  D('CPM4', 'Chlorphenamine 4mg tablet', { classes: ['antihistamine', 'sedating'], unitMg: 4, maxDailyMg: 24 }),
  D('PROM25', 'Promethazine 25mg tablet', { classes: ['antihistamine', 'sedating'], unitMg: 25, maxDailyMg: 100, qt: true }),
  // haematinics / vitamins
  D('FOLIC5', 'Folic acid 5mg tablet', { classes: ['vitamin'], unitMg: 5, maxDailyMg: 15 }),
  D('FESO4', 'Ferrous sulfate 200mg tablet', { classes: ['iron', 'chelator_agent'], unitMg: 200, maxDailyMg: 600 }),
  D('VITBCO', 'Vitamin B complex tablet', { classes: ['vitamin'] }),
  // neuro / psych
  D('DIAZ5', 'Diazepam 5mg tablet', { classes: ['benzodiazepine', 'sedating'], allergy: ['benzodiazepine'], unitMg: 5, maxDailyMg: 30, controlled: true, pregnancy: 'avoid' }),
  D('PHENO30', 'Phenobarbital 30mg tablet', { classes: ['anticonvulsant', 'sedating', 'enzyme_inducer'], unitMg: 30, maxDailyMg: 180, controlled: true }),
  D('CARB200', 'Carbamazepine 200mg tablet', { classes: ['anticonvulsant', 'enzyme_inducer'], allergy: ['carbamazepine'], unitMg: 200, maxDailyMg: 1600, pregnancy: 'avoid' }),
  D('PHENY100', 'Phenytoin 100mg capsule', { classes: ['anticonvulsant', 'enzyme_inducer'], unitMg: 100, maxDailyMg: 600, pregnancy: 'avoid' }),
  D('VALP200', 'Sodium valproate 200mg tablet', { classes: ['anticonvulsant'], unitMg: 200, maxDailyMg: 2500, pregnancy: 'avoid' }),
  D('AMIT25', 'Amitriptyline 25mg tablet', { classes: ['tca', 'serotonergic', 'sedating'], unitMg: 25, maxDailyMg: 150, qt: true }),
  D('FLUOX20', 'Fluoxetine 20mg capsule', { classes: ['ssri', 'serotonergic'], unitMg: 20, maxDailyMg: 60 }),
  D('HALO5', 'Haloperidol 5mg tablet', { classes: ['antipsychotic'], unitMg: 5, maxDailyMg: 20, qt: true }),
  // obstetric / other
  D('OXY10', 'Oxytocin 10 IU injection', { classes: ['uterotonic'] }),
  D('MISO200', 'Misoprostol 200mcg tablet', { classes: ['uterotonic', 'prostaglandin'], pregnancy: 'avoid' }),
  D('MGSO4', 'Magnesium sulfate 50% injection', { classes: ['anticonvulsant_obstetric'] }),
  D('LEVOT50', 'Levothyroxine 50mcg tablet', { classes: ['thyroid'], unitMg: 0.05, maxDailyMg: 0.3 }),
  D('ALLO100', 'Allopurinol 100mg tablet', { classes: ['xanthine_oxidase'], allergy: ['allopurinol'], unitMg: 100, maxDailyMg: 900 }),
  D('COLCH05', 'Colchicine 0.5mg tablet', { classes: ['colchicine'], unitMg: 0.5, maxDailyMg: 2 }),
  D('MTX25', 'Methotrexate 2.5mg tablet', { classes: ['methotrexate', 'folate_antagonist'], unitMg: 2.5, maxDailyMg: 25, pregnancy: 'avoid' }),
];
const BY_CODE = Object.fromEntries(DRUGS.map(d => [d.code, d]));

/* allergy words patients and staff type -> allergy group */
const ALLERGY_WORDS = [
  [/penicil|amoxi|ampicil|augment|clox|ampiclox/i, 'penicillin'], [/cephal|cef|ceph/i, 'cephalosporin'],
  [/sulf|sulpha|septrin|bactrim|cotrimox|fansidar/i, 'sulfonamide'], [/aspirin/i, 'aspirin'], [/nsaid|ibupro|diclof|brufen|voltaren|naprox/i, 'nsaid'],
  [/macrolid|erythro|azithro|clarithro/i, 'macrolide'], [/quinolon|cipro|levoflox|oflox/i, 'fluoroquinolone'], [/tetracyc|doxy/i, 'tetracycline'],
  [/opioid|opiate|codeine|morphine|tramadol|pethid/i, 'opioid'], [/quinine/i, 'quinine'], [/chloroquin/i, 'chloroquine'], [/artemis|artemeth|artesun|coartem|lumefan/i, 'artemisinin'],
  [/metronid|flagyl/i, 'metronidazole'], [/nitrofur/i, 'nitrofurantoin'], [/fluconaz|ketoconaz|azole/i, 'azole'], [/benzodiaz|diazepam|lorazepam|valium/i, 'benzodiazepine'],
  [/carbamaz|tegretol/i, 'carbamazepine'], [/allopur/i, 'allopurinol'], [/lisinop|enalap|captop|ace inhib/i, 'acei'],
];
function allergyClassOf(substance) { const s = String(substance || ''); for (const [re, g] of ALLERGY_WORDS) if (re.test(s)) return g; return null; }

/* interaction rules between class tags (or drug codes). severity: contraindicated | major | moderate */
const RULES = [
  { a: 'warfarin', b: 'nsaid', severity: 'major', msg: 'High bleeding risk: warfarin with an NSAID or aspirin.' },
  { a: 'warfarin', b: 'antiplatelet', severity: 'major', msg: 'High bleeding risk: warfarin with an antiplatelet.' },
  { a: 'warfarin', b: 'warfarin_potentiator', severity: 'major', msg: 'This drug raises warfarin levels (INR). Avoid or monitor INR closely.' },
  { a: 'warfarin', b: 'fluoroquinolone', severity: 'moderate', msg: 'Quinolones can raise INR with warfarin. Monitor INR.' },
  { a: 'warfarin', b: 'macrolide', severity: 'moderate', msg: 'Macrolides can raise INR with warfarin. Monitor INR.' },
  { a: 'acei', b: 'arb', severity: 'major', msg: 'Do not combine an ACE inhibitor with an ARB (kidney injury, high potassium).' },
  { a: 'raises_potassium', b: 'k_sparing', severity: 'major', msg: 'Risk of dangerous hyperkalaemia. Check potassium.', skipSame: true },
  { a: 'acei', b: 'nsaid', severity: 'moderate', msg: 'NSAIDs reduce the effect of ACE inhibitors and can harm the kidneys.' },
  { a: 'arb', b: 'nsaid', severity: 'moderate', msg: 'NSAIDs reduce the effect of ARBs and can harm the kidneys.' },
  { a: 'methotrexate', b: 'sulfonamide', severity: 'contraindicated', msg: 'Methotrexate with co-trimoxazole or another sulfonamide can cause fatal bone-marrow suppression.' },
  { a: 'methotrexate', b: 'nsaid', severity: 'major', msg: 'NSAIDs raise methotrexate toxicity.' },
  { a: 'opioid', b: 'benzodiazepine', severity: 'major', msg: 'Opioid with a benzodiazepine: risk of fatal respiratory depression.' },
  { a: 'opioid', b: 'sedating', severity: 'moderate', msg: 'Additive sedation with an opioid.' },
  { a: 'TRAM50', b: 'ssri', severity: 'major', msg: 'Tramadol with an SSRI: serotonin syndrome and seizure risk.' },
  { a: 'TRAM50', b: 'tca', severity: 'major', msg: 'Tramadol with a tricyclic: serotonin syndrome and seizure risk.' },
  { a: 'cyp3a4_statin', b: 'cyp3a4_inhibitor', severity: 'contraindicated', msg: 'Simvastatin with clarithromycin, erythromycin or fluconazole: risk of muscle breakdown (rhabdomyolysis).' },
  { a: 'digoxin', b: 'macrolide', severity: 'major', msg: 'Macrolides raise digoxin levels. Avoid or monitor.' },
  { a: 'digoxin', b: 'lowers_potassium', severity: 'moderate', msg: 'Low potassium from diuretics raises digoxin toxicity. Check potassium.' },
  { a: 'sulfonylurea', b: 'sulfonamide', severity: 'moderate', msg: 'Co-trimoxazole can cause low blood sugar with sulfonylureas.' },
  { a: 'sulfonylurea', b: 'azole_antifungal', severity: 'moderate', msg: 'Fluconazole can cause low blood sugar with sulfonylureas.' },
  { a: 'pde5', b: 'nitrate', severity: 'contraindicated', msg: 'Sildenafil with a nitrate can cause a severe, dangerous drop in blood pressure.' },
  { a: 'chelates', b: 'chelator_agent', severity: 'moderate', msg: 'Iron, zinc or antacids block absorption. Take at least 2 hours apart.' },
  { a: 'integrase', b: 'chelator_agent', severity: 'moderate', msg: 'Iron, zinc or antacids block dolutegravir. Take dolutegravir 2 hours before or 6 hours after.' },
  { a: 'integrase', b: 'enzyme_inducer', severity: 'major', msg: 'Enzyme-inducing anticonvulsants lower dolutegravir levels. Dose adjustment needed.' },
  { a: 'thyroid', b: 'iron', severity: 'moderate', msg: 'Iron reduces levothyroxine absorption. Take 4 hours apart.' },
  { a: 'folate_antagonist', b: 'folate_antagonist', severity: 'major', msg: 'Two folate antagonists together raise bone-marrow toxicity.', skipSame: true },
];

function tagsOf(drug) { return drug ? [drug.code].concat(drug.classes) : []; }
function find(codeOrName) {
  if (!codeOrName) return null;
  if (BY_CODE[codeOrName]) return BY_CODE[codeOrName];
  const s = String(codeOrName).toLowerCase();
  return DRUGS.find(d => d.name.toLowerCase() === s) || null;
}
function search(q, limit = 20) {
  const s = String(q || '').toLowerCase().trim();
  if (!s) return DRUGS.slice(0, limit);
  return DRUGS.filter(d => d.name.toLowerCase().includes(s) || d.code.toLowerCase().includes(s) || d.classes.some(c => c.includes(s))).slice(0, limit);
}

module.exports = { DRUGS, BY_CODE, RULES, find, search, tagsOf, allergyClassOf };
