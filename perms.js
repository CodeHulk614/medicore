'use strict';
/* ============================================================================
 * ONE permission model for the whole staff side. Front-office sub-roles AND the
 * hospital admin derive their access from here, so "who can do what" lives in a
 * single place. permsFor(user) is the only thing callers need.
 * ==========================================================================*/

// front-office (patient services) permissions
const FRONT_PERMS = ['patient.register', 'patient.read', 'queue.manage', 'vitals.record', 'billing.manage', 'cs.manage', 'shift.view'];
// admin-side (hospital control) permissions
const ADMIN_PERMS = ['admin.overview', 'admin.doctors', 'admin.facilities', 'admin.staff', 'admin.settlements', 'admin.modules'];

const SUBROLE_PERMS = {
  receptionist: ['patient.register', 'patient.read', 'queue.manage'],
  cashier: ['patient.read', 'billing.manage'],
  records: ['patient.register', 'patient.read', 'vitals.record'],
  cs: ['patient.read', 'cs.manage'],
  manager: ['patient.register', 'patient.read', 'queue.manage', 'vitals.record', 'billing.manage', 'cs.manage', 'shift.view'],
};
const SUBROLE_LABEL = { receptionist: 'Receptionist', cashier: 'Cashier / Billing', records: 'Records officer', cs: 'Customer success', manager: 'Front desk manager' };

// a front-desk manager also gets a defined slice of the admin side (view the hospital
// dashboard and manage staff), but not the sensitive money operations (settlements).
const MANAGER_ADMIN = ['admin.overview', 'admin.staff'];

function permsFor(u) {
  if (!u) return [];
  if (u.role === 'admin') return FRONT_PERMS.concat(ADMIN_PERMS);              // hospital admin: everything
  let base = [];
  if (u.role === 'frontdesk') {
    base = (u.permissions || SUBROLE_PERMS[u.subrole] || []).slice();
    if (u.subrole === 'manager') base = base.concat(MANAGER_ADMIN);
  }
  // per-person admin access: any staff member can be granted a configurable set of
  // admin capabilities by the hospital admin (stored on the user as adminPermissions).
  if (Array.isArray(u.adminPermissions) && u.adminPermissions.length) {
    u.adminPermissions.forEach(p => { if (ADMIN_PERMS.indexOf(p) >= 0 && base.indexOf(p) < 0) base.push(p); });
  }
  return base;
}
// named authority levels the admin can quick-assign (each expands to a permission set)
const ADMIN_LEVELS = {
  none: { label: 'No admin access', perms: [] },
  readonly: { label: 'Read-only admin', perms: ['admin.overview'] },
  operations: { label: 'Operations admin', perms: ['admin.overview', 'admin.staff', 'admin.modules'] },
  clinical: { label: 'Clinical admin', perms: ['admin.overview', 'admin.doctors', 'admin.facilities'] },
  finance: { label: 'Finance admin', perms: ['admin.overview', 'admin.settlements'] },
  full: { label: 'Full hospital admin', perms: ['admin.overview', 'admin.doctors', 'admin.facilities', 'admin.staff', 'admin.settlements', 'admin.modules'] },
};
const PERM_LABEL = {
  'patient.register': 'Register patients', 'patient.read': 'View patients', 'queue.manage': 'Check-in & queue', 'vitals.record': 'Record vitals', 'billing.manage': 'Billing & payments', 'cs.manage': 'Customer care', 'shift.view': 'View attendance',
  'admin.overview': 'Hospital dashboard', 'admin.doctors': 'Verify doctors', 'admin.facilities': 'Verify facilities', 'admin.staff': 'Manage staff', 'admin.settlements': 'Settlements & payouts', 'admin.modules': 'Hospital modules',
};

module.exports = { FRONT_PERMS, ADMIN_PERMS, SUBROLE_PERMS, SUBROLE_LABEL, MANAGER_ADMIN, PERM_LABEL, ADMIN_LEVELS, permsFor };
