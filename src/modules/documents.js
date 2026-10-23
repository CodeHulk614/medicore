'use strict';
/*
 * Real digitisation of paper work.
 *
 *  Scans      the desk or a doctor photographs old folders, referral letters, outside results, X-ray reports, ID and
 *             HMO cards, signed paper forms; each page becomes part of the patient's record (JPEG, PNG, WebP or PDF,
 *             one page per upload, size limit set in HQ). Patients can add their own old papers in the app.
 *  Letters    medical reports, sick notes (with rest dates), referral letters, discharge summaries and fitness
 *             certificates are issued from the app, signed with the doctor's name and licence number, and carry a
 *             verification code anyone can check at /register.html#/verify/<code> (stops forged sick notes).
 *  Forms      consent forms (treatment, procedure, blood transfusion, records sharing, discharge against advice,
 *             admission) filled and signed on the tablet: the patient (or parent, guardian, next of kin) signs on the
 *             screen, a witness is recorded, and the signed form is stored with the record. HQ provides the standard
 *             forms; each provider can add its own.
 *
 * Who sees what follows the record rules: the provider that made it (and its group's branches), providers on the
 * patient's care team, and the patient (scans made by providers only when HQ allows it).
 * Files live in the database (doc_blobs); every view of a file is audited.
 */
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { ah, body, query, t, bad, forbidden, notFound, conflict, param } = require('../lib/http');
const A = require('../lib/auth');
const S = require('../lib/settings');
const RL = require('../lib/ratelimit');
const { id, now, sha256, todayLagos } = require('../lib/util');
const { audit } = require('../lib/audit');
const { notify } = require('../lib/notify');
const P = require('./patients');
const ROLES = require('../lib/roles');

db.index('documents', ['patientId', 'createdAt']);
db.index('documents', ['orgId', 'createdAt']);
db.index('documents', ['verifyCode'], { unique: true, sparse: true });
db.index('form_templates', ['orgId', 'active']);

const router = express.Router();
const CATEGORIES = ['case_notes', 'referral_letter', 'lab_result', 'imaging', 'prescription', 'discharge_summary', 'consent_form', 'id_card', 'hmo_card', 'birth_record', 'immunisation', 'invoice_receipt', 'other'];
const LETTERS = ['medical_report', 'sick_note', 'referral_letter', 'discharge_summary', 'fitness_certificate'];
const MIMES = { 'image/jpeg': b => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF, 'image/png': b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47, 'image/webp': b => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP', 'application/pdf': b => b.slice(0, 4).toString('latin1') === '%PDF' };
const SIGNERS = ['self', 'parent', 'guardian', 'next_of_kin', 'spouse', 'other'];
const VCODE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const verifyCode = () => Array.from(crypto.randomBytes(10)).map(b => VCODE[b % VCODE.length]).join('');
const featureOn = (req, res, next) => (S.feature('documents', req.ctx && req.ctx.org) ? next() : next(forbidden('Documents are switched off on MediCore')));

/* standard forms (HQ can add more in Admin per provider). {{field}} placeholders are filled from the answers. */
const DEFAULT_FORMS = [
  { id: 'std_consent_treatment', kind: 'consent', title: 'Consent to examination and treatment', requireWitness: false,
    body: 'I, {{signerName}}, agree to examination and treatment by the doctors, nurses and other staff of {{providerName}} for {{patientName}}. The care proposed has been explained to me in a language I understand, and I have been able to ask questions. I understand I may withdraw this consent at any time.',
    fields: [] },
  { id: 'std_consent_procedure', kind: 'consent', title: 'Consent for a procedure or operation', requireWitness: true,
    body: 'I, {{signerName}}, agree that {{patientName}} may undergo {{procedure}} at {{providerName}}, with {{anaesthesia}} anaesthesia. The doctor explained what the procedure involves, its expected benefits, its risks ({{risks}}) and the alternatives, including doing nothing. I understand that another qualified doctor may carry out the procedure, and that extra treatment may be needed if something unexpected is found, to save life or prevent serious harm.',
    fields: [{ key: 'procedure', label: 'Procedure or operation', type: 'text', required: true }, { key: 'anaesthesia', label: 'Anaesthesia', type: 'select', options: ['general', 'spinal', 'local', 'sedation', 'no'], required: true }, { key: 'risks', label: 'Main risks explained', type: 'text', required: true }] },
  { id: 'std_consent_transfusion', kind: 'consent', title: 'Consent for blood transfusion', requireWitness: true,
    body: 'I, {{signerName}}, agree that {{patientName}} may receive blood or blood products at {{providerName}}. The reason ({{reason}}), the risks and the alternatives were explained to me.',
    fields: [{ key: 'reason', label: 'Reason for transfusion', type: 'text', required: true }] },
  { id: 'std_consent_sharing', kind: 'consent', title: 'Consent to share medical records', requireWitness: false,
    body: 'I, {{signerName}}, agree that {{providerName}} may share the medical records of {{patientName}} with {{shareWith}} for {{purpose}}. I understand I can withdraw this consent at any time.',
    fields: [{ key: 'shareWith', label: 'Share with', type: 'text', required: true }, { key: 'purpose', label: 'Purpose', type: 'text', required: true }] },
  { id: 'std_dama', kind: 'consent', title: 'Discharge against medical advice', requireWitness: true,
    body: 'I, {{signerName}}, am taking {{patientName}} away from {{providerName}} against the advice of the doctor. The doctor explained that leaving now may lead to {{risks}}. My reason: {{reason}}. I accept responsibility for this decision and know I can come back at any time.',
    fields: [{ key: 'risks', label: 'Risks explained', type: 'text', required: true }, { key: 'reason', label: 'Reason for leaving', type: 'text', required: true }] },
  { id: 'std_admission', kind: 'admission', title: 'Admission agreement', requireWitness: false,
    body: 'I, {{signerName}}, agree to the admission of {{patientName}} to {{ward}} at {{providerName}}. I understand the hospital rules, the visiting hours and the estimated cost explained to me ({{estimate}}), and that the final bill may differ.',
    fields: [{ key: 'ward', label: 'Ward', type: 'text', required: true }, { key: 'estimate', label: 'Estimated cost explained', type: 'text' }] },
];

function fill(text, vars) { return String(text || '').replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] != null && vars[k] !== '' ? String(vars[k]) : '...')); }
function decodeFile(f) {
  const max = (Number(S.get('process.documents.maxFileMb', 3)) || 3) * 1024 * 1024;
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,/i.exec(f.data || '');
  const mime = (f.mime || (m && m[1]) || '').toLowerCase();
  if (!MIMES[mime]) throw bad('Upload a photo (JPEG, PNG, WebP) or a PDF');
  const buf = Buffer.from(String(f.data || '').replace(/^data:[^,]*,/, ''), 'base64');
  if (!buf.length) throw bad('The file is empty');
  if (buf.length > max) throw bad('The file is too large. The limit is ' + Math.round(max / 1048576) + ' MB a page.');
  if (!MIMES[mime](buf)) throw bad('The file content does not match its type');
  return { mime, buf };
}
async function saveBlob(f, meta) {
  const { mime, buf } = decodeFile(f);
  const b = { id: id('blb'), mime, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), data: buf.toString('base64'), createdAt: now(), patientId: meta.patientId, orgId: meta.orgId || null };
  await db.col('doc_blobs').insertOne(b);
  return { blobId: b.id, name: (f.name || 'page').slice(0, 120), mime, size: b.size };
}
const fileRule = t.obj({ name: t.str({ max: 120 }), mime: t.str({ max: 40 }), data: t.str({ required: true, max: 5800000, trim: false }) }, { required: true });

function docView(d, me) {
  return { id: d.id, patientId: d.patientId, orgId: d.orgId || null, orgName: d.orgName || null, kind: d.kind, category: d.category, title: d.title, docDate: d.docDate || null, note: d.note || null,
    files: (d.files || []).map(f => ({ blobId: f.blobId, name: f.name, mime: f.mime, size: f.size })), createdAt: d.createdAt, createdByName: d.createdByName || null, byPatient: !!d.byPatient, sharedWithProviders: d.byPatient ? d.sharedWithProviders !== false : undefined,
    letter: d.letter || null, form: d.form ? Object.assign({}, d.form, { signatureBlobId: d.form.signatureBlobId }) : null, verifyCode: d.verifyCode || null, status: d.status, mine: me ? d.orgId === me : undefined };
}
/** documents of a patient a staff member may see */
async function visibleDocs(req, patientId) {
  const vis = await P.visibleRecordFilter(req, patientId);
  const own = await db.col('documents').find(Object.assign({}, vis, { status: { $ne: 'removed' } }), { sort: { createdAt: -1 }, limit: 500 });
  const fromPatient = await db.col('documents').find({ patientId, byPatient: true, sharedWithProviders: { $ne: false }, status: { $ne: 'removed' } }, { sort: { createdAt: -1 }, limit: 200 });
  const seen = new Set(); return own.concat(fromPatient).filter(d => (seen.has(d.id) ? false : seen.add(d.id))).sort((a, b) => b.createdAt - a.createdAt);
}

/* ================= staff ================= */
const readG = [A.requireStaff({ anyPerm: ['docs.read', 'docs.upload', 'docs.issue', 'clinic.consult'] }), featureOn];
router.get('/docs/meta', ...readG, ah(async (req, res) => {
  const custom = await db.col('form_templates').find({ orgId: req.ctx.org.id, active: { $ne: false } }, { sort: { title: 1 } });
  res.json({ categories: CATEGORIES, letters: LETTERS, signers: SIGNERS, maxFileMb: Number(S.get('process.documents.maxFileMb', 3)) || 3, maxFiles: Number(S.get('process.documents.maxFilesPerDocument', 10)) || 10,
    forms: DEFAULT_FORMS.concat(custom.map(c => ({ id: c.id, kind: c.kind, title: c.title, body: c.body, fields: c.fields || [], requireWitness: !!c.requireWitness, custom: true }))),
    signature: (req.ctx.membership && req.ctx.membership.signature) || null });
}));
router.get('/docs/patients/:pid', ...readG, ah(async (req, res) => {
  const { patient } = await P.requireLinked(req, param(req, 'pid'));
  const rows = await visibleDocs(req, patient.id);
  await audit(req, 'docs.list', { type: 'patient', id: patient.id, patientId: patient.id });
  res.json(rows.map(d => docView(d, req.ctx.org.id)));
}));
router.post('/docs/patients/:pid', A.requireStaff({ perm: 'docs.upload' }), featureOn, ah(async (req, res) => {
  const b = body(req, { category: t.enum(CATEGORIES, { required: true }), title: t.str({ required: true, max: 120, plain: true }), docDate: t.date(), note: t.text({ max: 1000 }), file: fileRule });
  const { patient } = await P.requireLinked(req, param(req, 'pid'));
  await RL.limit('docup_' + req.ctx.org.id, 2000, 86400);
  const file = await saveBlob(b.file, { patientId: patient.id, orgId: req.ctx.org.id });
  const d = { id: id('doc'), patientId: patient.id, orgId: req.ctx.org.id, orgName: req.ctx.org.name, kind: 'scan', category: b.category, title: b.title, docDate: b.docDate || null, note: b.note || null, files: [file], status: 'active', createdAt: now(), createdBy: req.ctx.user.id, createdByName: req.ctx.user.name };
  await db.col('documents').insertOne(d);
  await audit(req, 'docs.upload', { type: 'document', id: d.id, patientId: patient.id }, { category: b.category, mime: file.mime, size: file.size });
  res.json(docView(d, req.ctx.org.id));
}));
router.post('/docs/:id/files', A.requireStaff({ perm: 'docs.upload' }), featureOn, ah(async (req, res) => {
  const b = body(req, { file: fileRule });
  const d = await db.col('documents').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id, kind: 'scan', status: 'active' });
  if (!d) throw notFound('Document not found');
  if ((d.files || []).length >= (Number(S.get('process.documents.maxFilesPerDocument', 10)) || 10)) throw conflict('This document has the most pages allowed. Start a new document.');
  const file = await saveBlob(b.file, { patientId: d.patientId, orgId: req.ctx.org.id });
  const u = await db.col('documents').findOneAndUpdate({ id: d.id }, { $push: { files: file }, $set: { updatedAt: now() } });
  await audit(req, 'docs.add_page', { type: 'document', id: d.id, patientId: d.patientId }, { size: file.size });
  res.json(docView(u, req.ctx.org.id));
}));
router.post('/docs/:id/remove', A.requireStaff({ anyPerm: ['docs.upload', 'docs.issue'] }), featureOn, ah(async (req, res) => {
  const b = body(req, { reason: t.str({ required: true, min: 3, max: 300, plain: true }) });
  const d = await db.col('documents').findOneAndUpdate({ id: param(req, 'id'), orgId: req.ctx.org.id, status: 'active', verifyCode: { $exists: false } }, { $set: { status: 'removed', removedAt: now(), removedBy: req.ctx.user.id, removeReason: b.reason } });
  if (!d) throw notFound('Document not found, or it is an issued letter (cancel it instead)');
  await audit(req, 'docs.remove', { type: 'document', id: d.id, patientId: d.patientId }, { reason: b.reason });
  res.json({ ok: true });
}));
/** a file: images and PDFs are served from the API with the session; every view is audited */
router.get('/docs/blobs/:id', ...readG, ah(async (req, res) => {
  const bl = await db.col('doc_blobs').findOne({ id: param(req, 'id') });
  if (!bl) throw notFound('File not found');
  const docs = await visibleDocs(req, bl.patientId).catch(() => []);
  const ok = docs.some(d => (d.files || []).some(f => f.blobId === bl.id) || (d.form && d.form.signatureBlobId === bl.id));
  if (!ok || !(await P.linkOf(req.ctx.org.id, bl.patientId))) throw notFound('File not found');
  await audit(req, 'docs.view', { type: 'doc_blob', id: bl.id, patientId: bl.patientId });
  res.setHeader('Content-Type', bl.mime); res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Disposition', 'inline; filename="' + bl.id + (bl.mime === 'application/pdf' ? '.pdf' : '') + '"');
  res.end(Buffer.from(bl.data, 'base64'));
}));

/* ---------------- letters and certificates ---------------- */
router.put('/docs/my-signature', A.requireStaff({ perm: 'docs.issue' }), ah(async (req, res) => {
  const b = body(req, { title: t.str({ max: 60, plain: true }), licenceBody: t.str({ max: 40, plain: true }), licenceNo: t.str({ required: true, max: 40, plain: true, label: 'Licence number' }), qualifications: t.str({ max: 120, plain: true }) });
  await db.col('memberships').updateOne({ id: req.ctx.membership.id }, { $set: { signature: Object.assign({ updatedAt: now() }, b) } });
  await audit(req, 'docs.signature', { type: 'membership', id: req.ctx.membership.id });
  res.json({ ok: true, signature: b });
}));
router.post('/docs/patients/:pid/letters', A.requireStaff({ perm: 'docs.issue' }), featureOn, ah(async (req, res) => {
  const b = body(req, { type: t.enum(LETTERS, { required: true }), addressedTo: t.str({ max: 160, plain: true }), diagnosis: t.str({ max: 300, plain: true }), body: t.text({ required: true, max: 6000, label: 'Letter text' }), restFrom: t.date(), restTo: t.date(), fitFor: t.str({ max: 200, plain: true }), recommendations: t.text({ max: 2000 }), encounterId: t.id() });
  const { patient } = await P.requireLinked(req, param(req, 'pid'));
  const sig = (req.ctx.membership && req.ctx.membership.signature) || null;
  if (!sig || !sig.licenceNo) throw conflict('Add your licence number first (Documents > My signature) so the letter can be verified', 'signature_missing');
  if (b.type === 'sick_note') { if (!b.restFrom || !b.restTo) throw bad('A sick note needs rest dates'); if (b.restTo < b.restFrom) throw bad('The end date is before the start date'); }
  let code = verifyCode(); for (let i = 0; i < 4 && (await db.col('documents').findOne({ verifyCode: code })); i++) code = verifyCode();
  const role = ROLES.ROLES[req.ctx.role];
  const letter = { type: b.type, addressedTo: b.addressedTo || null, diagnosis: b.diagnosis || null, body: b.body, restFrom: b.restFrom || null, restTo: b.restTo || null, fitFor: b.fitFor || null, recommendations: b.recommendations || null, issuedOn: todayLagos(),
    signer: { name: req.ctx.user.name, title: sig.title || (role ? role.label : null), licenceBody: sig.licenceBody || 'MDCN', licenceNo: sig.licenceNo, qualifications: sig.qualifications || null },
    provider: { name: req.ctx.org.name, address: (req.ctx.org.contact || {}).address || null, phone: (req.ctx.org.contact || {}).phone || null, email: (req.ctx.org.contact || {}).email || null },
    patient: { name: patient.firstName + ' ' + patient.lastName, dob: patient.dob || null, sex: patient.sex || null, mrn: (await P.linkOf(req.ctx.org.id, patient.id)).mrn } };
  const titles = { medical_report: 'Medical report', sick_note: 'Sick note', referral_letter: 'Referral letter', discharge_summary: 'Discharge summary', fitness_certificate: 'Medical fitness certificate' };
  const d = { id: id('doc'), patientId: patient.id, orgId: req.ctx.org.id, orgName: req.ctx.org.name, kind: 'letter', category: b.type === 'discharge_summary' ? 'discharge_summary' : b.type === 'referral_letter' ? 'referral_letter' : 'other', title: titles[b.type], docDate: todayLagos(),
    letter, verifyCode: code, encounterId: b.encounterId || null, files: [], status: 'active', createdAt: now(), createdBy: req.ctx.user.id, createdByName: req.ctx.user.name };
  await db.col('documents').insertOne(d);
  await audit(req, 'docs.letter', { type: 'document', id: d.id, patientId: patient.id }, { type: b.type });
  if (patient.userId) await notify({ patientId: patient.id, title: titles[b.type] + ' ready', body: req.ctx.org.name + ' issued your ' + titles[b.type].toLowerCase() + '. Open Documents in the app.', kind: 'document', ref: { type: 'document', id: d.id } });
  res.json(docView(d, req.ctx.org.id));
}));
router.post('/docs/:id/cancel', A.requireStaff({ perm: 'docs.issue' }), featureOn, ah(async (req, res) => {
  const b = body(req, { reason: t.str({ required: true, min: 3, max: 300, plain: true }) });
  const d = await db.col('documents').findOneAndUpdate({ id: param(req, 'id'), orgId: req.ctx.org.id, kind: 'letter', status: 'active' }, { $set: { status: 'cancelled', cancelledAt: now(), cancelledBy: req.ctx.user.id, cancelReason: b.reason } });
  if (!d) throw notFound('Letter not found');
  await audit(req, 'docs.letter_cancel', { type: 'document', id: d.id, patientId: d.patientId }, { reason: b.reason });
  res.json({ ok: true });
}));

/* ---------------- signed forms ---------------- */
async function templateFor(req, tid) {
  const std = DEFAULT_FORMS.find(f => f.id === tid); if (std) return std;
  const c = await db.col('form_templates').findOne({ id: tid, orgId: req.ctx.org.id, active: { $ne: false } });
  if (!c) throw notFound('Form not found');
  return c;
}
router.post('/docs/patients/:pid/forms', A.requireStaff({ perm: 'docs.forms' }), featureOn, ah(async (req, res) => {
  const b = body(req, { templateId: t.str({ required: true, max: 64 }), answers: t.any({ maxBytes: 4000 }), signerName: t.str({ required: true, max: 120, plain: true, label: 'Name of the person signing' }), signerRelation: t.enum(SIGNERS, { required: true }),
    witnessName: t.str({ max: 120, plain: true }), interpreter: t.str({ max: 120, plain: true }), language: t.str({ max: 30, plain: true }), signature: t.str({ required: true, max: 400000, trim: false, label: 'Signature' }) });
  const { patient } = await P.requireLinked(req, param(req, 'pid'));
  const tpl = await templateFor(req, b.templateId);
  const answers = {}; const raw = b.answers && typeof b.answers === 'object' ? b.answers : {};
  for (const f of tpl.fields || []) {
    const v = raw[f.key] == null ? '' : String(raw[f.key]).replace(/<[^>]*>/g, '').trim().slice(0, 500);
    if (f.required && !v) throw bad((f.label || f.key) + ' is required');
    if (f.type === 'select' && v && !(f.options || []).includes(v)) throw bad((f.label || f.key) + ' is not valid');
    answers[f.key] = v;
  }
  if (tpl.requireWitness && !b.witnessName) throw bad('This form needs a witness');
  if (!/^data:image\/png;base64,/.test(b.signature)) throw bad('Sign in the box first');
  const sig = await saveBlob({ name: 'signature.png', mime: 'image/png', data: b.signature }, { patientId: patient.id, orgId: req.ctx.org.id });
  if (sig.size < 400) throw bad('Sign in the box first');
  const text = fill(tpl.body, Object.assign({}, answers, { signerName: b.signerName, patientName: patient.firstName + ' ' + patient.lastName, providerName: req.ctx.org.name, date: todayLagos() }));
  const d = { id: id('doc'), patientId: patient.id, orgId: req.ctx.org.id, orgName: req.ctx.org.name, kind: 'form', category: 'consent_form', title: tpl.title, docDate: todayLagos(),
    form: { templateId: tpl.id, title: tpl.title, text, answers, signerName: b.signerName, signerRelation: b.signerRelation, witnessName: b.witnessName || null, interpreter: b.interpreter || null, language: b.language || null, signatureBlobId: sig.blobId, signedAt: now(), takenBy: req.ctx.user.name },
    files: [], status: 'active', createdAt: now(), createdBy: req.ctx.user.id, createdByName: req.ctx.user.name };
  await db.col('documents').insertOne(d);
  await audit(req, 'docs.form_signed', { type: 'document', id: d.id, patientId: patient.id }, { templateId: tpl.id, signer: b.signerRelation });
  res.json(docView(d, req.ctx.org.id));
}));
/* provider's own form templates */
const tplRules = { title: t.str({ required: true, max: 120, plain: true }), kind: t.enum(['consent', 'admission', 'procedure', 'hmo', 'other'], { default: 'consent' }), body: t.text({ required: true, max: 6000 }), requireWitness: t.bool(), active: t.bool(),
  fields: t.arr(t.obj({ key: t.str({ required: true, max: 30, pattern: /^[a-zA-Z][a-zA-Z0-9_]*$/ }), label: t.str({ required: true, max: 80, plain: true }), type: t.enum(['text', 'date', 'select'], { default: 'text' }), options: t.arr(t.str({ max: 40, plain: true }), { max: 12 }), required: t.bool() }), { max: 12 }) };
router.get('/admin/form-templates', A.requireStaff({ anyPerm: ['admin.settings', 'docs.forms'] }), ah(async (req, res) => {
  res.json({ standard: DEFAULT_FORMS, custom: await db.col('form_templates').find({ orgId: req.ctx.org.id }, { sort: { title: 1 } }) });
}));
router.post('/admin/form-templates', A.requireStaff({ perm: 'admin.settings' }), ah(async (req, res) => {
  const b = body(req, tplRules);
  const tpl = Object.assign({ id: id('ftp'), orgId: req.ctx.org.id, active: true, createdAt: now(), createdBy: req.ctx.user.id }, b, { fields: b.fields || [] });
  await db.col('form_templates').insertOne(tpl);
  await audit(req, 'docs.template_create', { type: 'form_template', id: tpl.id });
  res.json(tpl);
}));
router.patch('/admin/form-templates/:id', A.requireStaff({ perm: 'admin.settings' }), ah(async (req, res) => {
  const rules = Object.assign({}, tplRules); rules.title = t.str({ max: 120, plain: true }); rules.body = t.text({ max: 6000 });
  const b = body(req, rules); if (!Object.keys(b).length) throw bad('Nothing to change');
  const tpl = await db.col('form_templates').findOneAndUpdate({ id: param(req, 'id'), orgId: req.ctx.org.id }, { $set: Object.assign({ updatedAt: now() }, b) });
  if (!tpl) throw notFound('Form not found');
  res.json(tpl);
}));

/* ================= public: verify a letter ================= */
router.get('/public/verify/:code', ah(async (req, res) => {
  await RL.limitIp(req, 'docverify', 60, 3600);
  const code = String(req.params.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  const d = code.length >= 8 ? await db.col('documents').findOne({ verifyCode: code }) : null;
  if (!d) return res.json({ valid: false });
  const L = d.letter || {}; const n = (L.patient && L.patient.name) || '';
  // just enough to confirm the paper is genuine; no diagnosis
  res.json({ valid: d.status === 'active', status: d.status, type: L.type, title: d.title, issuedOn: L.issuedOn, provider: (L.provider || {}).name || d.orgName, signer: L.signer ? { name: L.signer.name, licenceBody: L.signer.licenceBody, licenceNo: L.signer.licenceNo } : null,
    patientInitials: n.split(/\s+/).filter(Boolean).map(x => x[0].toUpperCase() + '.').join(' '), restFrom: L.restFrom || null, restTo: L.restTo || null });
}));

/* ================= patient ================= */
const patientUploadsOn = () => { if (S.get('process.documents.patientUploads', true) === false || !S.feature('documents')) throw forbidden('Adding documents in the app is switched off'); };
router.get('/me/documents', A.requirePatient, ah(async (req, res) => {
  if (!S.feature('documents')) return res.json([]);
  const provScans = S.get('process.documents.patientSeesProviderScans', true) !== false;
  const sc = await P.scopeFilter(req);
  const rows = await db.col('documents').find({ patientId: req.ctx.patient.id, status: { $in: ['active', 'cancelled'] } }, { sort: { createdAt: -1 }, limit: 300 });
  const ids = sc.orgId ? sc.orgId.$in : null;
  res.json(rows.filter(d => d.byPatient || ((!ids || ids.includes(d.orgId)) && (d.kind !== 'scan' || provScans))).map(d => docView(d)));
}));
router.get('/me/documents/blobs/:id', A.requirePatient, ah(async (req, res) => {
  const bl = await db.col('doc_blobs').findOne({ id: param(req, 'id'), patientId: req.ctx.patient.id });
  if (!bl) throw notFound('File not found');
  const provScans = S.get('process.documents.patientSeesProviderScans', true) !== false;
  const d = await db.col('documents').findOne({ patientId: req.ctx.patient.id, $or: [{ 'files.blobId': bl.id }, { 'form.signatureBlobId': bl.id }] });
  if (!d || d.status === 'removed' || (!d.byPatient && d.kind === 'scan' && !provScans)) throw notFound('File not found');
  await audit(req, 'docs.patient_view', { type: 'doc_blob', id: bl.id, patientId: bl.patientId, orgId: null });
  res.setHeader('Content-Type', bl.mime); res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Disposition', 'inline; filename="' + bl.id + (bl.mime === 'application/pdf' ? '.pdf' : '') + '"');
  res.end(Buffer.from(bl.data, 'base64'));
}));
router.post('/me/documents', A.requirePatient, ah(async (req, res) => {
  patientUploadsOn();
  const b = body(req, { category: t.enum(CATEGORIES, { required: true }), title: t.str({ required: true, max: 120, plain: true }), docDate: t.date(), note: t.text({ max: 1000 }), share: t.bool(), file: fileRule });
  await RL.limit('pdocup_' + req.ctx.patient.id, 60, 86400);
  const file = await saveBlob(b.file, { patientId: req.ctx.patient.id, orgId: null });
  const d = { id: id('doc'), patientId: req.ctx.patient.id, orgId: null, orgName: null, byPatient: true, sharedWithProviders: b.share !== false, kind: 'scan', category: b.category, title: b.title, docDate: b.docDate || null, note: b.note || null, files: [file], status: 'active', createdAt: now(), createdBy: req.ctx.user.id, createdByName: req.ctx.patient.firstName };
  await db.col('documents').insertOne(d);
  await audit(req, 'docs.patient_upload', { type: 'document', id: d.id, patientId: d.patientId, orgId: null }, { category: b.category, size: file.size });
  res.json(docView(d));
}));
router.post('/me/documents/:id/files', A.requirePatient, ah(async (req, res) => {
  patientUploadsOn();
  const b = body(req, { file: fileRule });
  const d = await db.col('documents').findOne({ id: param(req, 'id'), patientId: req.ctx.patient.id, byPatient: true, status: 'active' });
  if (!d) throw notFound('Document not found');
  if ((d.files || []).length >= (Number(S.get('process.documents.maxFilesPerDocument', 10)) || 10)) throw conflict('This document has the most pages allowed. Start a new document.');
  const file = await saveBlob(b.file, { patientId: d.patientId, orgId: null });
  const u = await db.col('documents').findOneAndUpdate({ id: d.id }, { $push: { files: file }, $set: { updatedAt: now() } });
  res.json(docView(u));
}));
router.post('/me/documents/:id/share', A.requirePatient, ah(async (req, res) => {
  const b = body(req, { share: t.bool({ required: true }) });
  const d = await db.col('documents').findOneAndUpdate({ id: param(req, 'id'), patientId: req.ctx.patient.id, byPatient: true, status: 'active' }, { $set: { sharedWithProviders: b.share, updatedAt: now() } });
  if (!d) throw notFound('Document not found');
  await audit(req, b.share ? 'docs.patient_share_on' : 'docs.patient_share_off', { type: 'document', id: d.id, patientId: d.patientId, orgId: null });
  res.json(docView(d));
}));
router.post('/me/documents/:id/remove', A.requirePatient, ah(async (req, res) => {
  const d = await db.col('documents').findOneAndUpdate({ id: param(req, 'id'), patientId: req.ctx.patient.id, byPatient: true, status: 'active' }, { $set: { status: 'removed', removedAt: now() } });
  if (!d) throw notFound('Document not found');
  await audit(req, 'docs.patient_remove', { type: 'document', id: d.id, patientId: d.patientId, orgId: null });
  res.json({ ok: true });
}));

/* ================= demo ================= */
/** a tiny valid PNG (a grey page with a few lines) so demo documents open */
function demoPng() {
  // 1x1 grey pixel PNG; enough for the demo list and viewer
  return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN8+P9/PQAJBwN/0q8/7AAAAABJRU5ErkJggg==';
}
async function seedDemo(ctx) {
  const hosp = ctx.orgs.hospital; const amaka = ctx.patients && ctx.patients.amaka; if (!hosp || !amaka) return;
  const file = await saveBlob({ name: 'old-folder-page-1.png', mime: 'image/png', data: demoPng() }, { patientId: amaka.id, orgId: hosp.id });
  await db.col('documents').insertOne({ id: id('doc'), patientId: amaka.id, orgId: hosp.id, orgName: hosp.name, kind: 'scan', category: 'case_notes', title: 'Old paper folder, 2019 to 2024', docDate: '2024-11-30', note: 'Scanned from the paper folder when the hospital moved to MediCore.', files: [file], status: 'active', createdAt: now() - 30 * 86400e3, createdBy: 'demo', createdByName: 'Records officer' });
  const pf = await saveBlob({ name: 'outside-lab.png', mime: 'image/png', data: demoPng() }, { patientId: amaka.id, orgId: null });
  await db.col('documents').insertOne({ id: id('doc'), patientId: amaka.id, orgId: null, orgName: null, byPatient: true, sharedWithProviders: true, kind: 'scan', category: 'lab_result', title: 'Lipid profile from another lab', docDate: '2026-06-02', note: null, files: [pf], status: 'active', createdAt: now() - 12 * 86400e3, createdBy: 'demo', createdByName: 'Amaka' });
  const doc = ctx.staff && ctx.staff.hospital && ctx.staff.hospital['dr.tunde'];
  if (doc) await db.col('memberships').updateOne({ id: doc.membership.id }, { $set: { signature: { title: 'Consultant physician', licenceBody: 'MDCN', licenceNo: 'MDCN/R/45812 (demo)', qualifications: 'MBBS, FWACP' } } });
  await db.col('documents').insertOne({ id: id('doc'), patientId: amaka.id, orgId: hosp.id, orgName: hosp.name, kind: 'letter', category: 'other', title: 'Sick note', docDate: todayLagos(), verifyCode: 'DEMOSICK24',
    letter: { type: 'sick_note', addressedTo: 'To whom it may concern', diagnosis: null, body: 'Mrs Amaka Eze was seen at this hospital today and is unfit for work for three days.', restFrom: todayLagos(), restTo: todayLagos(), issuedOn: todayLagos(),
      signer: { name: 'Dr. Tunde Bello', title: 'Consultant physician', licenceBody: 'MDCN', licenceNo: 'MDCN/R/45812 (demo)', qualifications: 'MBBS, FWACP' }, provider: { name: hosp.name, address: (hosp.contact || {}).address || null, phone: (hosp.contact || {}).phone || null }, patient: { name: 'Amaka Eze', dob: amaka.dob || null, sex: amaka.sex || null } },
    files: [], status: 'active', createdAt: now() - 2 * 86400e3, createdBy: 'demo', createdByName: 'Dr. Tunde Bello' });
}

module.exports = { name: 'documents', router, seedDemoAfter: seedDemo, DEFAULT_FORMS, CATEGORIES, LETTERS };
