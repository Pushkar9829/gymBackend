// Role -> permission map. Owner has everything ('*').
export const PERMISSIONS = [
  'dashboard.read', 'reports.read', 'audit.read',
  'members.read', 'members.write', 'members.delete',
  'plans.read', 'plans.write',
  'subscriptions.write', 'subscriptions.cancel',
  'payments.read', 'payments.create', 'payments.refund',
  'attendance.read', 'attendance.write',
  'leads.read', 'leads.write',
  'expenses.read', 'expenses.write',
  'devices.read', 'devices.write',
  'users.read', 'users.write',
  'branches.write', 'settings.write',
];

export const ROLES = {
  owner: ['*'],
  manager: PERMISSIONS.filter((p) => !['branches.write', 'settings.write'].includes(p)),
  receptionist: [
    'dashboard.read', 'members.read', 'members.write', 'plans.read', 'subscriptions.write',
    'payments.read', 'payments.create', 'attendance.read', 'attendance.write',
    'leads.read', 'leads.write', 'expenses.read', 'expenses.write', 'devices.read',
  ],
  trainer: ['dashboard.read', 'members.read', 'plans.read', 'attendance.read'],
};

export const ROLE_NAMES = Object.keys(ROLES);

export const can = (role, perm) => {
  const perms = ROLES[role] || [];
  return perms.includes('*') || perms.includes(perm);
};
