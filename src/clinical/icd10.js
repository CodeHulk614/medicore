'use strict';
/*
 * A short ICD-10 (WHO edition) list of diagnoses common in Nigerian primary and secondary care,
 * with plain-language aliases so doctors can search the way they speak ("high BP", "pile").
 * Doctors may also enter any well-formed ICD-10 code that is not in this list, with its text.
 * Before go-live a clinical coder should review this list; the full WHO table can replace it
 * without changing callers (search / find / valid).
 */
const C = (code, text, group, aliases) => ({ code, text, group, aliases: aliases || [] });

const CODES = [
  // infectious and parasitic
  C('A00.9', 'Cholera, unspecified', 'Infectious'),
  C('A01.0', 'Typhoid fever', 'Infectious', ['enteric fever', 'typhoid']),
  C('A01.4', 'Paratyphoid fever, unspecified', 'Infectious'),
  C('A03.9', 'Shigellosis, unspecified', 'Infectious', ['bacillary dysentery']),
  C('A06.0', 'Acute amoebic dysentery', 'Infectious', ['amoebiasis']),
  C('A09', 'Infectious gastroenteritis and colitis, unspecified', 'Infectious', ['diarrhoea', 'diarrhea', 'gastroenteritis', 'running stomach']),
  C('A15.0', 'Tuberculosis of lung, confirmed', 'Infectious', ['tb', 'ptb', 'pulmonary tuberculosis']),
  C('A16.9', 'Respiratory tuberculosis, unspecified, not confirmed', 'Infectious', ['tb']),
  C('A35', 'Tetanus', 'Infectious'),
  C('A37.9', 'Whooping cough, unspecified', 'Infectious', ['pertussis']),
  C('A39.0', 'Meningococcal meningitis', 'Infectious', ['csm', 'cerebrospinal meningitis']),
  C('A41.9', 'Sepsis, unspecified organism', 'Infectious', ['septicaemia']),
  C('A46', 'Erysipelas', 'Infectious'),
  C('A53.9', 'Syphilis, unspecified', 'Infectious', ['sti', 'std']),
  C('A54.9', 'Gonococcal infection, unspecified', 'Infectious', ['gonorrhoea', 'sti', 'std']),
  C('A56.0', 'Chlamydial infection of lower genitourinary tract', 'Infectious', ['chlamydia', 'sti']),
  C('A59.0', 'Urogenital trichomoniasis', 'Infectious', ['trichomonas', 'sti']),
  C('A60.0', 'Herpesviral infection of genitalia and urogenital tract', 'Infectious', ['genital herpes', 'sti']),
  C('A82.9', 'Rabies, unspecified', 'Infectious'),
  C('A90', 'Dengue fever', 'Infectious'),
  C('A95.9', 'Yellow fever, unspecified', 'Infectious'),
  C('A96.2', 'Lassa fever', 'Infectious'),
  C('A98.4', 'Ebola virus disease', 'Infectious'),
  C('B01.9', 'Varicella without complication', 'Infectious', ['chickenpox', 'chicken pox']),
  C('B05.9', 'Measles without complication', 'Infectious'),
  C('B15.9', 'Hepatitis A without hepatic coma', 'Infectious'),
  C('B16.9', 'Acute hepatitis B without delta-agent and without hepatic coma', 'Infectious', ['hep b']),
  C('B18.1', 'Chronic viral hepatitis B without delta-agent', 'Infectious', ['hep b', 'hbv']),
  C('B18.2', 'Chronic viral hepatitis C', 'Infectious', ['hep c', 'hcv']),
  C('B20', 'HIV disease resulting in infectious and parasitic diseases', 'Infectious', ['hiv', 'aids', 'plhiv']),
  C('B24', 'Unspecified human immunodeficiency virus [HIV] disease', 'Infectious', ['hiv', 'aids']),
  C('Z21', 'Asymptomatic HIV infection status', 'Infectious', ['hiv positive']),
  C('B26.9', 'Mumps without complication', 'Infectious'),
  C('B35.0', 'Tinea barbae and tinea capitis', 'Infectious', ['ringworm of scalp']),
  C('B35.4', 'Tinea corporis', 'Infectious', ['ringworm']),
  C('B36.0', 'Pityriasis versicolor', 'Infectious', ['tinea versicolor', 'eczema patches']),
  C('B37.0', 'Candidal stomatitis', 'Infectious', ['oral thrush']),
  C('B37.3', 'Candidiasis of vulva and vagina', 'Infectious', ['vaginal thrush', 'yeast infection', 'candidiasis']),
  C('B50.0', 'Plasmodium falciparum malaria with cerebral complications', 'Infectious', ['cerebral malaria', 'severe malaria']),
  C('B50.8', 'Other severe and complicated Plasmodium falciparum malaria', 'Infectious', ['severe malaria', 'complicated malaria']),
  C('B50.9', 'Plasmodium falciparum malaria, unspecified', 'Infectious', ['malaria', 'uncomplicated malaria']),
  C('B54', 'Unspecified malaria', 'Infectious', ['malaria', 'fever']),
  C('B65.9', 'Schistosomiasis, unspecified', 'Infectious', ['bilharzia']),
  C('B74.0', 'Filariasis due to Wuchereria bancrofti', 'Infectious', ['elephantiasis']),
  C('B76.9', 'Hookworm disease, unspecified', 'Infectious', ['worms']),
  C('B77.9', 'Ascariasis, unspecified', 'Infectious', ['roundworm', 'worms']),
  C('B82.9', 'Intestinal parasitism, unspecified', 'Infectious', ['worms', 'helminthiasis']),
  C('B86', 'Scabies', 'Infectious', ['craw craw']),
  C('U07.1', 'COVID-19, virus identified', 'Infectious', ['covid', 'coronavirus']),
  // neoplasms
  C('C18.9', 'Malignant neoplasm of colon, unspecified', 'Neoplasm', ['colon cancer']),
  C('C22.0', 'Liver cell carcinoma', 'Neoplasm', ['hepatocellular carcinoma', 'liver cancer']),
  C('C50.9', 'Malignant neoplasm of breast, unspecified', 'Neoplasm', ['breast cancer']),
  C('C53.9', 'Malignant neoplasm of cervix uteri, unspecified', 'Neoplasm', ['cervical cancer']),
  C('C61', 'Malignant neoplasm of prostate', 'Neoplasm', ['prostate cancer']),
  C('D25.9', 'Leiomyoma of uterus, unspecified', 'Neoplasm', ['fibroids', 'fibroid']),
  // blood
  C('D50.9', 'Iron deficiency anaemia, unspecified', 'Blood', ['anemia', 'low blood']),
  C('D52.9', 'Folate deficiency anaemia, unspecified', 'Blood', ['anemia']),
  C('D57.0', 'Sickle-cell anaemia with crisis', 'Blood', ['sickle cell crisis', 'scd', 'vaso-occlusive crisis', 'hbss']),
  C('D57.1', 'Sickle-cell anaemia without crisis', 'Blood', ['sickle cell', 'scd', 'hbss']),
  C('D57.2', 'Double heterozygous sickling disorders', 'Blood', ['hbsc', 'sc disease']),
  C('D64.9', 'Anaemia, unspecified', 'Blood', ['anemia', 'low blood']),
  C('D69.6', 'Thrombocytopenia, unspecified', 'Blood', ['low platelets']),
  // endocrine and metabolic
  C('E03.9', 'Hypothyroidism, unspecified', 'Endocrine'),
  C('E04.9', 'Nontoxic goitre, unspecified', 'Endocrine', ['goiter']),
  C('E05.9', 'Thyrotoxicosis, unspecified', 'Endocrine', ['hyperthyroidism']),
  C('E10.9', 'Type 1 diabetes mellitus without complications', 'Endocrine', ['diabetes', 'iddm', 'sugar']),
  C('E11', 'Type 2 diabetes mellitus', 'Endocrine', ['diabetes', 'dm', 't2dm', 'sugar']),
  C('E11.2', 'Type 2 diabetes mellitus with renal complications', 'Endocrine', ['diabetic nephropathy']),
  C('E11.4', 'Type 2 diabetes mellitus with neurological complications', 'Endocrine', ['diabetic neuropathy']),
  C('E11.5', 'Type 2 diabetes mellitus with peripheral circulatory complications', 'Endocrine', ['diabetic foot']),
  C('E11.9', 'Type 2 diabetes mellitus without complications', 'Endocrine', ['diabetes', 't2dm', 'sugar']),
  C('E16.2', 'Hypoglycaemia, unspecified', 'Endocrine', ['low sugar', 'hypoglycemia']),
  C('E43', 'Unspecified severe protein-energy malnutrition', 'Endocrine', ['sam', 'kwashiorkor', 'marasmus']),
  C('E44.0', 'Moderate protein-energy malnutrition', 'Endocrine', ['mam']),
  C('E46', 'Unspecified protein-energy malnutrition', 'Endocrine', ['malnutrition']),
  C('E55.9', 'Vitamin D deficiency, unspecified', 'Endocrine', ['rickets']),
  C('E66.9', 'Obesity, unspecified', 'Endocrine'),
  C('E78.5', 'Hyperlipidaemia, unspecified', 'Endocrine', ['high cholesterol', 'dyslipidaemia']),
  C('E86', 'Volume depletion', 'Endocrine', ['dehydration']),
  C('E87.6', 'Hypokalaemia', 'Endocrine', ['low potassium']),
  // mental and behavioural
  C('F10.2', 'Mental and behavioural disorders due to use of alcohol: dependence syndrome', 'Mental', ['alcoholism']),
  C('F12.2', 'Mental and behavioural disorders due to use of cannabinoids: dependence syndrome', 'Mental', ['cannabis', 'igbo', 'weed']),
  C('F20.9', 'Schizophrenia, unspecified', 'Mental', ['psychosis']),
  C('F32.9', 'Depressive episode, unspecified', 'Mental', ['depression']),
  C('F41.1', 'Generalized anxiety disorder', 'Mental', ['anxiety']),
  C('F41.9', 'Anxiety disorder, unspecified', 'Mental', ['anxiety']),
  C('F43.1', 'Post-traumatic stress disorder', 'Mental', ['ptsd']),
  C('F51.0', 'Nonorganic insomnia', 'Mental', ['insomnia', 'cannot sleep']),
  // nervous system
  C('G03.9', 'Meningitis, unspecified', 'Nervous'),
  C('G40.9', 'Epilepsy, unspecified', 'Nervous', ['seizure disorder', 'convulsion']),
  C('G43.9', 'Migraine, unspecified', 'Nervous', ['headache']),
  C('G44.2', 'Tension-type headache', 'Nervous', ['headache']),
  C('G51.0', 'Bell palsy', 'Nervous', ['facial palsy']),
  C('G62.9', 'Polyneuropathy, unspecified', 'Nervous', ['neuropathy']),
  C('G80.9', 'Cerebral palsy, unspecified', 'Nervous'),
  // eye and ear
  C('H10.9', 'Conjunctivitis, unspecified', 'Eye', ['apollo', 'red eye', 'pink eye']),
  C('H26.9', 'Cataract, unspecified', 'Eye'),
  C('H40.9', 'Glaucoma, unspecified', 'Eye'),
  C('H52.1', 'Myopia', 'Eye', ['short sight']),
  C('H60.9', 'Otitis externa, unspecified', 'Ear', ['ear infection']),
  C('H61.2', 'Impacted cerumen', 'Ear', ['ear wax']),
  C('H66.9', 'Otitis media, unspecified', 'Ear', ['ear infection']),
  // circulatory
  C('I10', 'Essential (primary) hypertension', 'Circulatory', ['hypertension', 'high blood pressure', 'high bp', 'htn']),
  C('I11.9', 'Hypertensive heart disease without (congestive) heart failure', 'Circulatory', ['hypertensive heart disease']),
  C('I20.9', 'Angina pectoris, unspecified', 'Circulatory', ['chest pain', 'angina']),
  C('I21.9', 'Acute myocardial infarction, unspecified', 'Circulatory', ['heart attack', 'mi']),
  C('I25.1', 'Atherosclerotic heart disease', 'Circulatory', ['coronary artery disease', 'cad', 'ihd']),
  C('I42.0', 'Dilated cardiomyopathy', 'Circulatory'),
  C('I48', 'Atrial fibrillation and flutter', 'Circulatory', ['af', 'afib']),
  C('I50.9', 'Heart failure, unspecified', 'Circulatory', ['ccf', 'chf', 'congestive cardiac failure']),
  C('I61.9', 'Intracerebral haemorrhage, unspecified', 'Circulatory', ['stroke', 'haemorrhagic stroke']),
  C('I63.9', 'Cerebral infarction, unspecified', 'Circulatory', ['stroke', 'ischaemic stroke', 'cva']),
  C('I64', 'Stroke, not specified as haemorrhage or infarction', 'Circulatory', ['stroke', 'cva']),
  C('I80.2', 'Phlebitis and thrombophlebitis of other deep vessels of lower extremities', 'Circulatory', ['dvt', 'deep vein thrombosis']),
  C('I83.9', 'Varicose veins of lower extremities without ulcer or inflammation', 'Circulatory', ['varicose veins']),
  C('I95.9', 'Hypotension, unspecified', 'Circulatory', ['low blood pressure', 'low bp']),
  // respiratory
  C('J00', 'Acute nasopharyngitis [common cold]', 'Respiratory', ['catarrh', 'common cold', 'cold']),
  C('J01.9', 'Acute sinusitis, unspecified', 'Respiratory', ['sinusitis']),
  C('J02.9', 'Acute pharyngitis, unspecified', 'Respiratory', ['sore throat']),
  C('J03.9', 'Acute tonsillitis, unspecified', 'Respiratory', ['tonsillitis']),
  C('J06.9', 'Acute upper respiratory infection, unspecified', 'Respiratory', ['urti', 'cold', 'catarrh', 'cough']),
  C('J11.1', 'Influenza with other respiratory manifestations, virus not identified', 'Respiratory', ['flu']),
  C('J15.9', 'Bacterial pneumonia, unspecified', 'Respiratory', ['pneumonia']),
  C('J18.9', 'Pneumonia, unspecified', 'Respiratory', ['pneumonia', 'chest infection']),
  C('J20.9', 'Acute bronchitis, unspecified', 'Respiratory', ['bronchitis', 'chest infection']),
  C('J21.9', 'Acute bronchiolitis, unspecified', 'Respiratory', ['bronchiolitis']),
  C('J30.4', 'Allergic rhinitis, unspecified', 'Respiratory', ['hay fever', 'catarrh']),
  C('J32.9', 'Chronic sinusitis, unspecified', 'Respiratory'),
  C('J44.9', 'Chronic obstructive pulmonary disease, unspecified', 'Respiratory', ['copd']),
  C('J45', 'Asthma', 'Respiratory', ['asthma', 'wheeze']),
  C('J45.9', 'Asthma, unspecified', 'Respiratory', ['asthma', 'wheeze']),
  C('J46', 'Status asthmaticus', 'Respiratory', ['acute severe asthma']),
  C('J90', 'Pleural effusion, not elsewhere classified', 'Respiratory'),
  // digestive
  C('K02.9', 'Dental caries, unspecified', 'Digestive', ['tooth decay', 'toothache']),
  C('K04.7', 'Periapical abscess without sinus', 'Digestive', ['dental abscess', 'toothache']),
  C('K05.1', 'Chronic gingivitis', 'Digestive', ['gum disease']),
  C('K21.9', 'Gastro-oesophageal reflux disease without oesophagitis', 'Digestive', ['gerd', 'gord', 'heartburn', 'reflux']),
  C('K25.9', 'Gastric ulcer, unspecified', 'Digestive', ['ulcer', 'pud']),
  C('K26.9', 'Duodenal ulcer, unspecified', 'Digestive', ['ulcer', 'pud']),
  C('K27', 'Peptic ulcer, site unspecified', 'Digestive', ['ulcer', 'pud', 'peptic ulcer disease']),
  C('K27.9', 'Peptic ulcer, unspecified as acute or chronic, without haemorrhage or perforation', 'Digestive', ['ulcer', 'pud']),
  C('K29.7', 'Gastritis, unspecified', 'Digestive', ['gastritis', 'ulcer']),
  C('K30', 'Dyspepsia', 'Digestive', ['indigestion', 'heartburn']),
  C('K35.8', 'Acute appendicitis, other and unspecified', 'Digestive', ['appendicitis']),
  C('K40.9', 'Unilateral or unspecified inguinal hernia, without obstruction or gangrene', 'Digestive', ['hernia']),
  C('K52.9', 'Noninfective gastroenteritis and colitis, unspecified', 'Digestive'),
  C('K58.9', 'Irritable bowel syndrome without diarrhoea', 'Digestive', ['ibs']),
  C('K59.0', 'Constipation', 'Digestive'),
  C('K64.9', 'Haemorrhoids, unspecified', 'Digestive', ['pile', 'piles', 'hemorrhoids']),
  C('K70.3', 'Alcoholic cirrhosis of liver', 'Digestive'),
  C('K74.6', 'Other and unspecified cirrhosis of liver', 'Digestive', ['cirrhosis']),
  C('K80.2', 'Calculus of gallbladder without cholecystitis', 'Digestive', ['gallstones']),
  C('K81.0', 'Acute cholecystitis', 'Digestive'),
  // skin
  C('L01.0', 'Impetigo', 'Skin'),
  C('L02.9', 'Cutaneous abscess, furuncle and carbuncle, unspecified', 'Skin', ['boil', 'abscess']),
  C('L03.9', 'Cellulitis, unspecified', 'Skin'),
  C('L20.9', 'Atopic dermatitis, unspecified', 'Skin', ['eczema']),
  C('L23.9', 'Allergic contact dermatitis, unspecified cause', 'Skin', ['contact dermatitis']),
  C('L30.9', 'Dermatitis, unspecified', 'Skin', ['eczema', 'rash']),
  C('L50.9', 'Urticaria, unspecified', 'Skin', ['hives', 'rash']),
  C('L70.0', 'Acne vulgaris', 'Skin', ['acne', 'pimples']),
  // musculoskeletal
  C('M06.9', 'Rheumatoid arthritis, unspecified', 'Musculoskeletal'),
  C('M10.9', 'Gout, unspecified', 'Musculoskeletal'),
  C('M17.9', 'Gonarthrosis, unspecified', 'Musculoskeletal', ['knee osteoarthritis', 'arthritis']),
  C('M19.9', 'Arthrosis, unspecified', 'Musculoskeletal', ['osteoarthritis', 'arthritis']),
  C('M54.2', 'Cervicalgia', 'Musculoskeletal', ['neck pain']),
  C('M54.5', 'Low back pain', 'Musculoskeletal', ['back pain', 'waist pain']),
  C('M79.1', 'Myalgia', 'Musculoskeletal', ['body pain', 'muscle pain']),
  C('M86.9', 'Osteomyelitis, unspecified', 'Musculoskeletal'),
  // genitourinary
  C('N10', 'Acute tubulo-interstitial nephritis', 'Genitourinary', ['pyelonephritis']),
  C('N17.9', 'Acute renal failure, unspecified', 'Genitourinary', ['aki', 'acute kidney injury']),
  C('N18.9', 'Chronic kidney disease, unspecified', 'Genitourinary', ['ckd', 'kidney failure']),
  C('N20.0', 'Calculus of kidney', 'Genitourinary', ['kidney stone']),
  C('N39.0', 'Urinary tract infection, site not specified', 'Genitourinary', ['uti', 'urine infection']),
  C('N40', 'Hyperplasia of prostate', 'Genitourinary', ['bph', 'enlarged prostate']),
  C('N41.0', 'Acute prostatitis', 'Genitourinary'),
  C('N46', 'Male infertility', 'Genitourinary', ['infertility']),
  C('N73.9', 'Female pelvic inflammatory disease, unspecified', 'Genitourinary', ['pid']),
  C('N76.0', 'Acute vaginitis', 'Genitourinary', ['vaginal discharge']),
  C('N91.2', 'Amenorrhoea, unspecified', 'Genitourinary'),
  C('N92.0', 'Excessive and frequent menstruation with regular cycle', 'Genitourinary', ['menorrhagia', 'heavy periods']),
  C('N94.6', 'Dysmenorrhoea, unspecified', 'Genitourinary', ['period pain', 'menstrual cramps']),
  C('N97.9', 'Female infertility, unspecified', 'Genitourinary', ['infertility']),
  // pregnancy and childbirth
  C('O03.9', 'Spontaneous abortion, complete or unspecified, without complication', 'Pregnancy', ['miscarriage']),
  C('O13', 'Gestational [pregnancy-induced] hypertension', 'Pregnancy', ['pih']),
  C('O14.9', 'Pre-eclampsia, unspecified', 'Pregnancy', ['preeclampsia']),
  C('O15.9', 'Eclampsia, unspecified as to time period', 'Pregnancy'),
  C('O21.0', 'Mild hyperemesis gravidarum', 'Pregnancy', ['morning sickness']),
  C('O24.4', 'Diabetes mellitus arising in pregnancy', 'Pregnancy', ['gestational diabetes', 'gdm']),
  C('O72.1', 'Other immediate postpartum haemorrhage', 'Pregnancy', ['pph']),
  C('O80', 'Single spontaneous delivery', 'Pregnancy', ['svd', 'normal delivery']),
  C('O99.0', 'Anaemia complicating pregnancy, childbirth and the puerperium', 'Pregnancy'),
  C('Z32.1', 'Pregnancy confirmed', 'Pregnancy'),
  C('Z34.9', 'Supervision of normal pregnancy, unspecified', 'Pregnancy', ['antenatal', 'anc']),
  // perinatal
  C('P07.3', 'Other preterm infants', 'Perinatal', ['premature baby']),
  C('P22.9', 'Respiratory distress of newborn, unspecified', 'Perinatal'),
  C('P36.9', 'Bacterial sepsis of newborn, unspecified', 'Perinatal', ['neonatal sepsis']),
  C('P59.9', 'Neonatal jaundice, unspecified', 'Perinatal', ['jaundice']),
  // symptoms and signs
  C('R05', 'Cough', 'Symptom'),
  C('R06.0', 'Dyspnoea', 'Symptom', ['shortness of breath', 'breathlessness']),
  C('R10.4', 'Other and unspecified abdominal pain', 'Symptom', ['stomach pain', 'abdominal pain']),
  C('R11', 'Nausea and vomiting', 'Symptom', ['vomiting']),
  C('R42', 'Dizziness and giddiness', 'Symptom', ['dizziness']),
  C('R50.9', 'Fever, unspecified', 'Symptom', ['pyrexia', 'fever']),
  C('R51', 'Headache', 'Symptom'),
  C('R53', 'Malaise and fatigue', 'Symptom', ['weakness', 'tiredness']),
  C('R55', 'Syncope and collapse', 'Symptom', ['fainting']),
  C('R56.0', 'Febrile convulsions', 'Symptom', ['febrile seizure']),
  C('R63.4', 'Abnormal weight loss', 'Symptom'),
  C('R73.9', 'Hyperglycaemia, unspecified', 'Symptom', ['high sugar']),
  // injury, poisoning, external causes
  C('S06.0', 'Concussion', 'Injury', ['head injury']),
  C('S52.5', 'Fracture of lower end of radius', 'Injury', ['wrist fracture']),
  C('S61.9', 'Open wound of wrist and hand part, part unspecified', 'Injury', ['cut', 'laceration']),
  C('S82.2', 'Fracture of shaft of tibia', 'Injury', ['leg fracture']),
  C('S93.4', 'Sprain and strain of ankle', 'Injury', ['ankle sprain']),
  C('T14.1', 'Open wound of unspecified body region', 'Injury', ['wound', 'laceration']),
  C('T30.0', 'Burn of unspecified body region, unspecified degree', 'Injury', ['burn']),
  C('T63.0', 'Toxic effect of snake venom', 'Injury', ['snake bite']),
  C('T78.4', 'Allergy, unspecified', 'Injury', ['allergic reaction']),
  C('T88.7', 'Unspecified adverse effect of drug or medicament', 'Injury', ['drug reaction', 'side effect']),
  C('V89.2', 'Person injured in unspecified motor-vehicle accident, traffic', 'External cause', ['rta', 'road traffic accident', 'okada accident']),
  C('W54', 'Bitten or struck by dog', 'External cause', ['dog bite']),
  // factors influencing health status
  C('Z00.0', 'General medical examination', 'Encounter', ['medical check-up', 'checkup', 'fitness test']),
  C('Z00.1', 'Routine child health examination', 'Encounter', ['well baby clinic']),
  C('Z09.9', 'Follow-up examination after unspecified treatment', 'Encounter', ['review', 'follow up']),
  C('Z11.4', 'Special screening examination for HIV', 'Encounter', ['hiv test']),
  C('Z13.1', 'Special screening examination for diabetes mellitus', 'Encounter'),
  C('Z26.9', 'Need for immunization against unspecified infectious disease', 'Encounter', ['vaccination', 'immunisation']),
  C('Z30.0', 'General counselling and advice on contraception', 'Encounter', ['family planning']),
  C('Z30.4', 'Surveillance of contraceptive drugs', 'Encounter', ['family planning']),
  C('Z76.0', 'Issue of repeat prescription', 'Encounter', ['refill', 'repeat prescription']),
];

const BY_CODE = Object.fromEntries(CODES.map(c => [c.code, c]));
const CODE_RE = /^[A-Z]\d{2}(\.\d{1,2})?$/;

/** is this a well-formed ICD-10 code (WHO style, e.g. I10, B50.9, A01.0)? */
const valid = code => CODE_RE.test(String(code || ''));
const find = code => BY_CODE[String(code || '').toUpperCase()] || null;

/** search by code prefix, text or alias; best matches first */
function search(q, limit = 20) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return CODES.slice(0, limit);
  const scored = [];
  for (const c of CODES) {
    const code = c.code.toLowerCase(), text = c.text.toLowerCase();
    let score = 0;
    if (code === s) score = 100;
    else if (code.startsWith(s)) score = 80;
    else if (c.aliases.some(a => a === s)) score = 70;
    else if (text.startsWith(s)) score = 60;
    else if (text.includes(s)) score = 40;
    else if (c.aliases.some(a => a.includes(s))) score = 30;
    if (score) scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score || a.c.code.localeCompare(b.c.code));
  return scored.slice(0, limit).map(x => x.c);
}

module.exports = { CODES, BY_CODE, valid, find, search };
