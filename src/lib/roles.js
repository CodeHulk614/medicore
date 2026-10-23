'use strict';
/*
 * ONE place that defines provider types, modules, staff roles, permissions and which app
 * each role signs into. Everything else (login, route guards, admin screens, plans) reads this.
 *
 * A provider (org) has a TYPE (what kind of business it is) and a set of enabled MODULES.
 * The type only picks sensible default modules; the modules decide what actually works.
 * A standalone pharmacy is just an org with the pharmacy + delivery modules; a full hospital
 * has them all. Every package always has: patient app, front desk, admin.
 */

const MODULES = {
  frontdesk: { label: 'Front desk', always: true, desc: 'Patient registration, check-in, billing and customer care' },
  clinic: { label: 'Doctors and consultations', desc: 'Doctor schedules, in-person and video visits, prescriptions and lab orders' },
  pharmacy: { label: 'Pharmacy', desc: 'Prescription fulfilment, walk-in sales, stock with batches and expiry' },
  delivery: { label: 'Delivery (dispatcher + riders)', desc: 'Medication delivery with a dispatcher, riders, live location and delivery codes', requires: ['pharmacy', 'lab'] },
  ambulance: { label: 'Ambulance (dispatcher + crew)', desc: 'Emergency calls, fleet, crew app with live GPS, case timeline' },
  lab: { label: 'Laboratory', desc: 'Test catalogue, sample reception, results with verification' },
  chw: { label: 'Community health (optional)', desc: 'Offline-first household visits, immunisation, antenatal care and referrals' },
  hmo: { label: 'HMO billing', always: true, desc: 'Check patient HMO cover, request pre-authorisation and submit claims' },
  payer: { label: 'HMO / payer desk', desc: 'For HMOs: members, pre-authorisations, claims review and payment' },
};

/* Provider types only choose sensible DEFAULT apps. Any provider can pick any combination of
 * service apps (custom pairs): a pharmacy can add a lab, a clinic can add an ambulance, and so on. */
const ALL_PROVIDER_MODULES = ['frontdesk', 'hmo', 'clinic', 'pharmacy', 'delivery', 'ambulance', 'lab', 'chw'];
const ORG_TYPES = {
  hospital: { label: 'Hospital', modules: ['frontdesk', 'clinic', 'pharmacy', 'delivery', 'ambulance', 'lab', 'hmo'], optional: ['chw'] },
  clinic: { label: 'Clinic / medical centre', modules: ['frontdesk', 'clinic', 'hmo'], optional: ['pharmacy', 'delivery', 'ambulance', 'lab', 'chw'] },
  pharmacy: { label: 'Pharmacy', modules: ['frontdesk', 'pharmacy', 'delivery', 'hmo'], optional: ['clinic', 'lab', 'ambulance', 'chw'] },
  ambulance: { label: 'Ambulance service', modules: ['frontdesk', 'ambulance', 'hmo'], optional: ['clinic', 'pharmacy', 'delivery', 'lab', 'chw'] },
  lab: { label: 'Laboratory / diagnostics', modules: ['frontdesk', 'lab', 'hmo'], optional: ['delivery', 'clinic', 'pharmacy', 'ambulance', 'chw'] },
  other: { label: 'Other health service', modules: ['frontdesk', 'hmo'], optional: ['clinic', 'pharmacy', 'delivery', 'ambulance', 'lab', 'chw'] },
  hmo: { label: 'HMO / health insurer', modules: ['payer'], optional: [] },
};

/* Permissions. Admin screens show these labels; a person can only grant permissions they hold. */
const PERMS = {
  // front desk
  'patient.register': 'Register and link patients', 'patient.read': 'View patient details', 'queue.manage': 'Check-in and queue',
  'vitals.record': 'Record vitals', 'billing.create': 'Create bills from the price list', 'billing.cash': 'Record cash / POS payments',
  'billing.void': 'Void bills and approve refunds', 'billing.custom': 'Add custom bill items', 'care.manage': 'Customer care cases',
  'hmo.check': 'Check HMO cover and request pre-authorisation', 'hmo.claim': 'Submit HMO claims',
  // clinical
  'clinic.consult': 'Run consultations', 'clinic.prescribe': 'Prescribe', 'clinic.order_lab': 'Order lab tests',
  // pharmacy
  'pharmacy.verify': 'Verify prescriptions (pharmacist)', 'pharmacy.dispense': 'Price and dispense', 'pharmacy.stock': 'Manage stock, suppliers and orders',
  'delivery.dispatch': 'Assign deliveries to riders', 'delivery.ride': 'Carry out deliveries',
  // ambulance
  'ambulance.dispatch': 'Take calls and dispatch units', 'ambulance.crew': 'Crew a unit', 'ambulance.fleet': 'Manage fleet and crew',
  // lab
  'lab.receive': 'Receive samples', 'lab.result': 'Enter results', 'lab.verify': 'Verify and release results', 'lab.catalog': 'Manage test catalogue',
  // chw
  'chw.field': 'Community visits',
  // payer
  'payer.members': 'Manage members and cover', 'payer.preauth': 'Decide pre-authorisations', 'payer.claims': 'Review claims', 'payer.pay': 'Mark claims paid',
  'payer.plans': 'Manage HMO plans and online sales', 'payer.network': 'Manage the HMO provider network and capitation', 'payer.care': 'Answer member requests',
  // referral network (provider to provider)
  'referral.send': 'Refer patients to other providers', 'referral.receive': 'Receive and accept referrals', 'network.manage': 'Partner connections, network profile and provider messages',
  // patient applications (patients asking to join this provider)
  'patient.applications': 'Approve or decline patient applications',
  // WhatsApp inbox (chats on the provider's WhatsApp numbers)
  'whatsapp.inbox': 'Read and answer WhatsApp chats for their department',
  // shared care (several providers working on one patient)
  'careshare.manage': 'Share a patient with another provider and join care teams',
  // documents (scanned paper records, letters, signed forms)
  'docs.upload': 'Scan and upload paper records', 'docs.read': 'View patient documents', 'docs.issue': 'Issue medical reports, sick notes and letters', 'docs.forms': 'Fill and sign consent forms with patients',
  // stores and capacity
  'inventory.read': 'View stores and stock', 'inventory.manage': 'Manage store items, receive and count stock', 'inventory.issue': 'Issue stock from the store', 'capacity.update': 'Update beds and emergency availability',
  // emergency transfers to hospitals on or off MediCore
  'transfer.manage': 'Find hospitals and arrange emergency transfers',
  // admin
  'admin.staff': 'Manage staff', 'admin.settings': 'Provider settings and price list', 'admin.reports': 'Reports and analytics',
  'admin.audit': 'View audit log', 'admin.finance': 'Payouts and finance', 'admin.privacy': 'Handle patient data requests',
};

/* Roles: default permissions, which app they use, which module they need, and whether they clock in. */
const ROLES = {
  owner: { label: 'Owner / administrator', app: 'admin', module: null, clock: false, perms: Object.keys(PERMS).filter(p => !p.startsWith('payer.')) },
  admin: { label: 'Administrator', app: 'admin', module: null, clock: false, perms: ['admin.staff', 'admin.settings', 'admin.reports', 'admin.audit', 'admin.finance', 'admin.privacy', 'patient.read', 'billing.void', 'referral.send', 'referral.receive', 'network.manage', 'patient.applications', 'whatsapp.inbox', 'careshare.manage', 'docs.read', 'docs.upload', 'docs.forms', 'inventory.read', 'inventory.manage', 'inventory.issue', 'capacity.update', 'transfer.manage'] },
  receptionist: { label: 'Receptionist', app: 'frontdesk', module: 'frontdesk', clock: true, perms: ['patient.register', 'patient.read', 'queue.manage', 'hmo.check', 'referral.send', 'referral.receive', 'patient.applications', 'whatsapp.inbox', 'careshare.manage', 'docs.read', 'docs.upload', 'docs.forms', 'transfer.manage'] },
  cashier: { label: 'Cashier / billing', app: 'frontdesk', module: 'frontdesk', clock: true, perms: ['patient.read', 'billing.create', 'billing.cash', 'hmo.check', 'hmo.claim', 'whatsapp.inbox'] },
  records: { label: 'Records officer', app: 'frontdesk', module: 'frontdesk', clock: true, perms: ['patient.register', 'patient.read', 'vitals.record', 'referral.send', 'referral.receive', 'patient.applications', 'whatsapp.inbox', 'careshare.manage', 'docs.read', 'docs.upload', 'docs.forms'] },
  nurse: { label: 'Nurse (triage)', app: 'frontdesk', module: 'frontdesk', clock: true, perms: ['patient.read', 'queue.manage', 'vitals.record', 'referral.send', 'whatsapp.inbox', 'docs.read', 'docs.forms', 'inventory.read', 'inventory.issue', 'capacity.update', 'transfer.manage'] },
  care: { label: 'Customer care', app: 'frontdesk', module: 'frontdesk', clock: true, perms: ['patient.read', 'care.manage', 'referral.receive', 'whatsapp.inbox', 'docs.read'] },
  frontdesk_manager: { label: 'Front desk manager', app: 'frontdesk', module: 'frontdesk', clock: true, perms: ['patient.register', 'patient.read', 'queue.manage', 'vitals.record', 'billing.create', 'billing.cash', 'billing.void', 'care.manage', 'hmo.check', 'hmo.claim', 'referral.send', 'referral.receive', 'patient.applications', 'network.manage', 'whatsapp.inbox', 'careshare.manage', 'docs.read', 'docs.upload', 'docs.forms', 'inventory.read', 'inventory.manage', 'inventory.issue', 'capacity.update', 'transfer.manage'] },
  doctor: { label: 'Doctor', app: 'doctor', module: 'clinic', clock: true, perms: ['patient.read', 'clinic.consult', 'clinic.prescribe', 'clinic.order_lab', 'vitals.record', 'referral.send', 'careshare.manage', 'docs.read', 'docs.upload', 'docs.issue', 'docs.forms', 'transfer.manage', 'inventory.read'] },
  pharmacist: { label: 'Pharmacist', app: 'pharmacy', module: 'pharmacy', clock: true, perms: ['patient.read', 'patient.register', 'pharmacy.verify', 'pharmacy.dispense', 'pharmacy.stock', 'billing.create', 'billing.cash', 'hmo.check', 'referral.send', 'referral.receive', 'patient.applications', 'whatsapp.inbox', 'careshare.manage', 'docs.read', 'docs.upload'] },
  pharmacy_tech: { label: 'Pharmacy technician', app: 'pharmacy', module: 'pharmacy', clock: true, perms: ['patient.read', 'patient.register', 'pharmacy.dispense', 'pharmacy.stock', 'billing.create', 'billing.cash', 'referral.send', 'whatsapp.inbox'] },
  delivery_dispatcher: { label: 'Delivery dispatcher', app: 'pharmacy', module: 'delivery', clock: true, perms: ['delivery.dispatch', 'whatsapp.inbox'] },
  rider: { label: 'Delivery rider', app: 'rider', module: 'delivery', clock: true, perms: ['delivery.ride'] },
  ambulance_dispatcher: { label: 'Ambulance dispatcher', app: 'dispatch', module: 'ambulance', clock: true, perms: ['ambulance.dispatch', 'ambulance.fleet', 'patient.read', 'referral.send', 'referral.receive', 'whatsapp.inbox', 'inventory.read', 'inventory.manage', 'inventory.issue', 'transfer.manage', 'docs.read'] },
  crew: { label: 'Ambulance crew', app: 'crew', module: 'ambulance', clock: true, perms: ['ambulance.crew'] },
  lab_scientist: { label: 'Lab scientist', app: 'lab', module: 'lab', clock: true, perms: ['patient.read', 'lab.receive', 'lab.result', 'lab.verify', 'referral.send', 'whatsapp.inbox', 'docs.read', 'inventory.read', 'inventory.issue'] },
  lab_reception: { label: 'Lab sample reception', app: 'lab', module: 'lab', clock: true, perms: ['patient.read', 'patient.register', 'lab.receive', 'billing.create', 'billing.cash', 'referral.send', 'referral.receive', 'patient.applications', 'whatsapp.inbox', 'docs.read', 'docs.upload', 'inventory.read'] },
  lab_manager: { label: 'Lab manager', app: 'lab', module: 'lab', clock: true, perms: ['patient.read', 'patient.register', 'lab.receive', 'lab.result', 'lab.verify', 'lab.catalog', 'billing.create', 'billing.cash', 'referral.send', 'referral.receive', 'patient.applications', 'network.manage', 'whatsapp.inbox', 'careshare.manage', 'docs.read', 'docs.upload', 'inventory.read', 'inventory.manage', 'inventory.issue'] },
  chw: { label: 'Community health worker', app: 'chw', module: 'chw', clock: true, perms: ['chw.field', 'patient.register', 'referral.send'] },
  store_officer: { label: 'Store officer', app: 'frontdesk', module: 'frontdesk', clock: true, perms: ['inventory.read', 'inventory.manage', 'inventory.issue', 'capacity.update'] },
  payer_officer: { label: 'HMO officer', app: 'payer', module: 'payer', clock: false, perms: ['payer.members', 'payer.preauth', 'payer.claims', 'payer.care'] },
  payer_manager: { label: 'HMO manager', app: 'payer', module: 'payer', clock: false, perms: ['payer.members', 'payer.preauth', 'payer.claims', 'payer.pay', 'admin.staff', 'admin.reports', 'admin.audit', 'admin.settings', 'payer.plans', 'payer.network', 'payer.care'] },
};
// HMO orgs use the admin app too, via their manager role
ROLES.payer_manager.alsoApps = ['admin'];

/* Groups: one company that runs several branches (each branch is a provider/org with groupId).
 * Group staff sign into the group console (app 'group'); branch staff use the normal apps at their branch. */
const GROUP_PERMS = {
  'group.branches': 'Add, configure and suspend branches', 'group.staff': 'Manage staff and administrators in every branch', 'group.admins': 'Manage group administrators',
  'group.finance': 'Subscription, billing and settlement accounts', 'group.reports': 'Reports across branches', 'group.settings': 'Group profile and shared price lists', 'group.audit': 'Audit log across branches',
  'group.network': 'Partner connections and referrals across branches', 'group.support': 'Raise and follow support tickets with MediCore',
};
const GROUP_ROLES = {
  group_owner: { label: 'Group owner', perms: Object.keys(GROUP_PERMS) },
  group_admin: { label: 'Group administrator', perms: ['group.branches', 'group.staff', 'group.reports', 'group.settings', 'group.audit', 'group.network', 'group.support'] },
  group_finance: { label: 'Group finance', perms: ['group.finance', 'group.reports', 'group.support'] },
  group_viewer: { label: 'Group viewer (reports only)', perms: ['group.reports'] },
};

/* Platform (product owner and developers). Separate from provider staff entirely. */
const PLATFORM_ROLES = {
  platform_owner: { label: 'Platform owner', perms: ['*'] },
  developer: { label: 'Developer', perms: ['platform.read', 'platform.orgs', 'platform.support', 'platform.audit', 'platform.demo', 'platform.config'] },
  support: { label: 'Support', perms: ['platform.read', 'platform.support'] },
  compliance: { label: 'Compliance / DPO', perms: ['platform.read', 'platform.audit', 'platform.privacy'] },
};
const PLATFORM_PERMS = {
  'platform.read': 'View platform', 'platform.orgs': 'Approve, suspend and configure providers', 'platform.plans': 'Edit plans and prices',
  'platform.support': 'Support tools', 'platform.audit': 'Platform audit log', 'platform.privacy': 'Privacy requests and breach register',
  'platform.users': 'Manage platform team', 'platform.demo': 'Load demo data (demo mode only)',
  'platform.config': 'Change platform configuration (theme, content, features, processes, roles)', 'platform.integrations': 'Change integration keys (payments, SMS, AI)',
};

const APPS = ['patient', 'frontdesk', 'doctor', 'pharmacy', 'rider', 'dispatch', 'crew', 'lab', 'chw', 'payer', 'admin', 'group', 'hq'];

function rolesForApp(app) { return Object.keys(ROLES).filter(r => ROLES[r].app === app || (ROLES[r].alsoApps || []).includes(app)); }
function permsFor(membership) {
  const base = (ROLES[membership.role] || { perms: [] }).perms;
  const extra = Array.isArray(membership.extraPerms) ? membership.extraPerms : [];
  const removed = Array.isArray(membership.removedPerms) ? membership.removedPerms : [];
  return [...new Set(base.concat(extra))].filter(p => PERMS[p] && !removed.includes(p));
}
function platformPermsFor(role) { const r = PLATFORM_ROLES[role]; if (!r) return []; return r.perms.includes('*') ? Object.keys(PLATFORM_PERMS) : r.perms; }
function defaultModules(type) { const t = ORG_TYPES[type]; return t ? t.modules.slice() : ['frontdesk', 'hmo']; }
function allowedModules(type) { const t = ORG_TYPES[type]; return t ? t.modules.concat(t.optional) : []; }
function rolesForModules(modules) { return Object.keys(ROLES).filter(r => !ROLES[r].module || modules.includes(ROLES[r].module)); }

module.exports = { ALL_PROVIDER_MODULES, MODULES, ORG_TYPES, PERMS, ROLES, PLATFORM_ROLES, PLATFORM_PERMS, GROUP_ROLES, GROUP_PERMS, APPS, rolesForApp, permsFor, platformPermsFor, defaultModules, allowedModules, rolesForModules };
