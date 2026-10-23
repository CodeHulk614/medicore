'use strict';
/* Hospital groups: group console, branches, branch admins, staff across branches, shared patients, pricing, HQ. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers');

let h, grp, ops;
before(async () => { h = await boot(); grp = await h.as('group', 'owner@crestview.demo'); ops = await h.as('group', 'ops@crestview.demo'); });
after(async () => { await h.close(); });
const ikeja = () => h.ctx.branches.ikeja.id;
const ajah = () => h.ctx.branches.ajah.id;

test('group console sign-in: group admins only; branch staff are refused', async () => {
  const me = await grp.get('/api/auth/me');
  assert.equal(me.status, 200); assert.equal(me.body.kind, 'group'); assert.equal(me.body.group.name, 'Crestview Hospitals');
  assert.ok(me.body.perms.includes('group.finance'));
  const r = await h.client('group').post('/api/auth/login', { identifier: 'admin.ikeja@crestview.demo', password: h.ctx.password });
  assert.equal(r.status, 403);
  const r2 = await h.client('group').post('/api/auth/login', { identifier: 'owner@grandville.demo', password: h.ctx.password });
  assert.equal(r2.status, 403);
});

test('overview covers every branch; a group admin without finance cannot see the subscription', async () => {
  const o = await grp.get('/api/group/overview');
  assert.equal(o.status, 200); assert.equal(o.body.branches.length, 2); assert.ok(o.body.subscription); assert.equal(o.body.totals.patients, o.body.branches.reduce((s, b) => s + b.patients, 0));
  const o2 = await ops.get('/api/group/overview');
  assert.equal(o2.status, 200); assert.equal(o2.body.subscription, null);
  assert.equal((await ops.get('/api/group/subscription')).status, 403);
  assert.equal((await ops.get('/api/group/admins')).status, 403);
});

test('the group owner owns every branch in the admin app; the branch admin sees only their branch', async () => {
  const c = h.client('admin');
  const r = await c.post('/api/auth/login', { identifier: 'owner@crestview.demo', password: h.ctx.password });
  assert.equal(r.status, 200); assert.equal(r.body.chooseOrg.length, 2);
  const bad = await h.as('admin', 'admin.ikeja@crestview.demo');
  const org = await bad.get('/api/admin/org');
  assert.equal(org.body.id, ikeja()); assert.equal(org.body.group.name, 'Crestview Hospitals'); assert.equal(org.body.modulesManagedByGroup, true);
  const mod = await bad.post('/api/admin/org/modules', { module: 'ambulance', enabled: true });
  assert.equal(mod.status, 403, 'branch admins cannot change apps');
  const ren = await bad.patch('/api/admin/org', { name: 'Renamed' });
  assert.equal(ren.status, 403);
  const staff = await bad.get('/api/admin/staff');
  assert.ok(staff.body.staff.every(s => s.name !== 'Seyi Bankole'), 'no Ajah staff in Ikeja');
});

let newBranch;
test('add a branch with its own administrator; it is live at once and priced into the group total', async () => {
  const before0 = (await grp.get('/api/group/subscription')).body;
  const r = await grp.post('/api/group/branches', { branchName: 'Lekki', modules: ['frontdesk', 'clinic', 'hmo'], seats: 10, contact: { phone: '08031112222', address: '1 Lekki Rd' }, location: { lat: 6.44, lng: 3.47, area: 'Lekki', city: 'Lagos' }, admin: { name: 'Lekki Admin', email: 'admin.lekki@crestview.demo' }, copyServicesFrom: ikeja() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  newBranch = r.body.branch;
  assert.equal(newBranch.status, 'active'); assert.equal(newBranch.branchName, 'Lekki'); assert.match(newBranch.name, /Crestview Hospitals - Lekki/);
  assert.ok(r.body.admin.tempPassword);
  const svc = await grp.get('/api/group/services?branchId=' + newBranch.id);
  assert.ok(svc.body.length >= 3, 'price list copied');
  const sub = (await grp.get('/api/group/subscription')).body;
  assert.equal(sub.branchCount, 3); assert.ok(sub.discount && sub.discount.percent === 10, '3 branches get the 10% default discount');
  assert.ok(sub.monthlyKobo > 0 && sub.monthlyKobo < sub.subtotalKobo && sub.subtotalKobo > before0.subtotalKobo);
  // the branch admin signs in with the temporary password and must change it
  const c = h.client('admin');
  const lr = await c.post('/api/auth/login', { identifier: 'admin.lekki@crestview.demo', password: r.body.admin.tempPassword });
  assert.equal(lr.status, 200); assert.equal(lr.body.mustChangePassword, true);
});

test('apps per branch: price shown first, applied on confirmation', async () => {
  const q = await grp.post('/api/group/branches/' + newBranch.id + '/modules', { module: 'lab', enabled: true });
  assert.equal(q.body.needsConfirm, true); assert.ok(q.body.groupMonthlyKobo > 0);
  const ok = await grp.post('/api/group/branches/' + newBranch.id + '/modules', { module: 'lab', enabled: true, confirmPriceKobo: q.body.quote.monthlyKobo });
  assert.equal(ok.status, 200); assert.ok(ok.body.modules.includes('lab'));
  const viewer = await ops.post('/api/group/branches/' + newBranch.id + '/modules', { module: 'pharmacy', enabled: true });
  assert.equal(viewer.status, 200, 'group admins manage branches');
});

test('staff across branches: add, move, suspend; roles depend on the branch apps', async () => {
  const r = await grp.post('/api/group/staff', { branchId: newBranch.id, name: 'New Receptionist', email: 'rec.lekki@crestview.demo', role: 'receptionist' });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.ok(r.body.tempPassword);
  const noRole = await grp.post('/api/group/staff', { branchId: newBranch.id, name: 'Rider', email: 'rider.lekki@crestview.demo', role: 'rider' });
  assert.equal(noRole.status, 400, 'no delivery app at that branch');
  const mv = await grp.patch('/api/group/staff/' + r.body.member.id, { moveToBranchId: ajah() });
  assert.equal(mv.status, 200); assert.equal(mv.body.orgId, ajah());
  const list = await grp.get('/api/group/staff?branchId=' + ajah());
  assert.ok(list.body.staff.some(s => s.email === 'rec.lekki@crestview.demo'));
  const s = await grp.patch('/api/group/staff/' + r.body.member.id, { status: 'suspended' });
  assert.equal(s.body.status, 'suspended');
  const owner = list.body.staff.find(x => x.isOwner);
  assert.equal((await grp.patch('/api/group/staff/' + owner.id, { status: 'suspended' })).status, 403);
  // a membership at another provider is invisible
  const other = await h.db.col('memberships').findOne({ orgId: h.ctx.orgs.hospital.id });
  assert.equal((await grp.patch('/api/group/staff/' + other.id, { status: 'suspended' })).status, 404);
});

test('a patient registered at one branch is a patient of every branch, with one record number', async () => {
  const ngozi = h.ctx.patients.ngozi;
  const fdA = await h.as('frontdesk', 'reception.ajah@crestview.demo');
  const s = await fdA.get('/api/fd/patients?q=Ngozi');
  assert.equal(s.status, 200); assert.equal(s.body.length, 1, 'found from the other branch');
  const p = await fdA.get('/api/fd/patients/' + ngozi.id);
  assert.equal(p.status, 200);
  const linkIk = await h.db.col('patient_links').findOne({ orgId: ikeja(), patientId: ngozi.id });
  assert.equal(p.body.mrn, linkIk.mrn, 'same group-wide record number');
  // another provider cannot see her
  const fdG = await h.as('frontdesk', 'reception@grandville.demo');
  assert.equal((await fdG.get('/api/fd/patients/' + ngozi.id)).status, 404);
  // the patient app shows Crestview once, with its branches
  const pt = await h.as('patient', 'ngozi@patient.demo');
  const sum = await pt.get('/api/me/providers/summary');
  assert.equal(sum.body.providers.length, 1); assert.equal(sum.body.providers[0].kind, 'group'); assert.ok(sum.body.providers[0].branches.length >= 3);
});

test('group suspends and reactivates a branch; HQ suspension cannot be undone by the group', async () => {
  const s = await grp.post('/api/group/branches/' + newBranch.id + '/suspend', { reason: 'Renovation for two weeks' });
  assert.equal(s.status, 200); assert.equal(s.body.status, 'suspended');
  const r = await grp.post('/api/group/branches/' + newBranch.id + '/reactivate');
  assert.equal(r.status, 200); assert.equal(r.body.status, 'active');
  const hq = await h.as('hq', 'hq@medicore.demo');
  assert.equal((await hq.post('/api/hq/providers/' + newBranch.id + '/suspend', { reason: 'Unpaid subscription' })).status, 200);
  assert.equal((await grp.post('/api/group/branches/' + newBranch.id + '/reactivate')).status, 403);
  assert.equal((await hq.post('/api/hq/providers/' + newBranch.id + '/reactivate')).status, 200);
});

test('settlement account per branch, masked; group admins without finance cannot set it', async () => {
  const r = await grp.patch('/api/group/branches/' + ikeja() + '/settlement', { bankName: 'Sterling Bank', bankCode: '232', accountNumber: '0123456789', accountName: 'Crestview Hospitals Ikeja', subaccount: 'ACCT_abc123' });
  assert.equal(r.status, 200); assert.equal(r.body.settlement.accountNumber, '******6789');
  assert.equal((await ops.patch('/api/group/branches/' + ikeja() + '/settlement', { bankName: 'X' })).status, 403);
  const bad = await grp.patch('/api/group/branches/' + ikeja() + '/settlement', { accountNumber: '12345' });
  assert.equal(bad.status, 400);
});

test('group administrators: add a viewer who sees reports only', async () => {
  const r = await grp.post('/api/group/admins', { name: 'Board Member', email: 'board@crestview.demo', role: 'group_viewer' });
  assert.equal(r.status, 200); assert.ok(r.body.tempPassword);
  const v = h.client('group');
  await v.login('board@crestview.demo', r.body.tempPassword);
  await v.post('/api/auth/password', { current: r.body.tempPassword, next: 'Viewer2026!x' });
  const v2 = await h.as('group', 'board@crestview.demo', { password: 'Viewer2026!x' });
  assert.equal((await v2.get('/api/group/overview')).status, 200);
  assert.equal((await v2.post('/api/group/branches', { branchName: 'X', contact: { phone: '08030000000', address: 'x' } })).status, 403);
  assert.equal((await v2.get('/api/group/staff')).status, 403);
});

test('a standalone provider becomes a group and keeps its patients and record numbers', async () => {
  const own = await h.as('admin', 'owner@lekkifamily.demo');
  const before0 = await h.db.col('patient_links').find({ orgId: h.ctx.orgs.clinic.id });
  const r = await own.post('/api/admin/org/convert-to-group', { groupName: 'Lekki Family Health', branchName: 'Admiralty Way' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after0 = await h.db.col('patient_links').find({ orgId: h.ctx.orgs.clinic.id });
  assert.ok(after0.every(l => l.groupId === r.body.group.id)); assert.deepEqual(after0.map(l => l.mrn).sort(), before0.map(l => l.mrn).sort());
  const g = await h.as('group', 'owner@lekkifamily.demo');
  const br = await g.post('/api/group/branches', { branchName: 'Ajah', contact: { phone: '08032223333', address: '3 Ajah Rd' } });
  assert.equal(br.status, 200);
  const n = await h.db.col('patient_links').count({ groupId: r.body.group.id });
  assert.ok(n >= before0.length);
  // a new patient at the new branch continues the numbering
  const fd = await h.as('admin', 'owner@lekkifamily.demo', { orgId: br.body.branch.id });
  assert.equal((await fd.get('/api/admin/org')).body.group.name, 'Lekki Family Health');
  assert.equal((await own.post('/api/admin/org/convert-to-group', {})).status, 409);
});

test('provider sign-up as a group; HQ approval of the first branch approves the group', async () => {
  const pub = h.client('patient');
  const r = await pub.post('/api/orgs/signup', { type: 'hospital', name: 'ignored', modules: ['frontdesk', 'clinic', 'hmo'], contact: { phone: '08035556666', email: 'info@sunrise.demo', address: '1 Sunrise Ave, Abuja' }, owner: { name: 'Sunrise Owner', email: 'owner@sunrise.demo', phone: '08035556667', password: 'Sunrise2026x' }, acceptTerms: true, group: { name: 'Sunrise Hospitals', branchName: 'Wuse' } });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.ok(r.body.group);
  const pending = await h.client('group').post('/api/auth/login', { identifier: 'owner@sunrise.demo', password: 'Sunrise2026x' });
  assert.equal(pending.status, 403); assert.match(pending.body.error, /awaiting/);
  const hq = await h.as('hq', 'hq@medicore.demo');
  const gl = await hq.get('/api/hq/groups');
  assert.ok(gl.body.some(g => g.name === 'Sunrise Hospitals' && g.status === 'pending'));
  assert.equal((await hq.post('/api/hq/providers/' + r.body.org.id + '/approve')).status, 200);
  const ok = await h.as('group', 'owner@sunrise.demo', { password: 'Sunrise2026x' });
  assert.equal((await ok.get('/api/group/branches')).body.branches.length, 1);
});

test('HQ suspends a whole group: every branch and the group console stop at once', async () => {
  const hq = await h.as('hq', 'hq@medicore.demo');
  const fd = await h.as('frontdesk', 'reception.ikeja@crestview.demo');
  const g = await h.db.col('groups').findOne({ name: 'Crestview Hospitals' });
  const r = await hq.post('/api/hq/groups/' + g.id + '/suspend', { reason: 'Compliance review' });
  assert.equal(r.status, 200);
  assert.equal((await fd.get('/api/fd/patients')).status, 401);
  assert.equal((await grp.get('/api/group/overview')).status, 401);
  const relog = await h.client('frontdesk').post('/api/auth/login', { identifier: 'reception.ikeja@crestview.demo', password: h.ctx.password });
  assert.equal(relog.status, 403);
  assert.equal((await hq.post('/api/hq/groups/' + g.id + '/reactivate')).status, 200);
  assert.equal((await h.client('frontdesk').post('/api/auth/login', { identifier: 'reception.ikeja@crestview.demo', password: h.ctx.password })).status, 200);
});
