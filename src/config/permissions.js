// Role -> permission map. Owner has everything ('*').
export const PERMISSIONS = [
  'dashboard.read', 'reports.read', 'audit.read',
  'members.read', 'members.write', 'members.delete', 'members.documents',
  'plans.read', 'plans.write',
  'subscriptions.write', 'subscriptions.cancel',
  'payments.read', 'payments.create', 'payments.refund',
  'attendance.read', 'attendance.write',
  'leads.read', 'leads.write',
  'expenses.read', 'expenses.write',
  'devices.read', 'devices.write',
  'pt.read', 'pt.sell', 'pt.log', 'pt.manage',
  'fitness.read', 'fitness.write',
  'classes.read', 'classes.write', 'classes.book', 'classes.attendance',
  'payroll.manage',
  'shop.sell', 'shop.manage',
  'equipment.read', 'equipment.manage',
  'lockers.read', 'lockers.write', 'lockers.manage',
  'feedback.read', 'feedback.write',
  'cash.close', 'cash.manage', 'discounts.approve',
  'trials.write', 'trials.override',
  'handover.read', 'handover.write', 'handover.manage',
  'users.read', 'users.write',
  'branches.write', 'settings.write',
];

export const ROLES = {
  owner: ['*'],
  manager: PERMISSIONS.filter((p) => !['branches.write', 'settings.write'].includes(p)),
  receptionist: [
    'dashboard.read', 'members.read', 'members.write', 'members.documents', 'plans.read', 'subscriptions.write',
    'payments.read', 'payments.create', 'attendance.read', 'attendance.write',
    'leads.read', 'leads.write', 'expenses.read', 'expenses.write', 'devices.read',
    'pt.read', 'pt.sell', 'pt.log', 'fitness.read',
    'classes.read', 'classes.book', 'classes.attendance', 'shop.sell', 'equipment.read',
    'lockers.read', 'lockers.write', 'feedback.read', 'feedback.write', 'cash.close',
    'trials.write', 'handover.read', 'handover.write',
  ],
  // Trainers read the handover board and acknowledge notes; posting is for the front desk.
  trainer: ['dashboard.read', 'members.read', 'plans.read', 'attendance.read', 'pt.read', 'pt.log', 'fitness.read', 'fitness.write', 'classes.read', 'classes.attendance', 'equipment.read', 'handover.read'],
};

export const ROLE_NAMES = Object.keys(ROLES);

export const can = (role, perm) => {
  const perms = ROLES[role] || [];
  return perms.includes('*') || perms.includes(perm);
};
