import { Router } from 'express';
import { requireStaff, permit } from '../../middlewares/auth.js';
import { branchFilter } from '../../middlewares/branchScope.js';
import { startOfDay, addDays, parseDay, ymd, dayjs, tz } from '../../utils/dates.js';
import { isExport, sendExport } from '../../utils/csv.js';
import { toRupees } from '../../utils/money.js';
import { Member } from '../members/member.model.js';
import { Payment } from '../payments/payment.model.js';
import { Expense } from '../expenses/expense.model.js';
import { Attendance } from '../attendance/attendance.model.js';
import { AccessLog } from '../access/accessLog.model.js';
import { Lead } from '../leads/lead.model.js';
import { Subscription } from '../subscriptions/subscription.model.js';
import { Notification } from '../notifications/notification.model.js';
import { Device } from '../devices/device.model.js';

const router = Router();
router.use(requireStaff);

const sumBy = async (Model, match, field = '$amount') => {
  const r = await Model.aggregate([{ $match: match }, { $group: { _id: null, v: { $sum: field } } }]);
  return r[0]?.v || 0;
};

function range(req, defaultDays = 30) {
  const to = req.query.to ? parseDay(String(req.query.to)) : startOfDay();
  const from = req.query.from ? parseDay(String(req.query.from)) : addDays(to, -(defaultDays - 1));
  return { from, toExclusive: addDays(to, 1), fromDay: ymd(from), toDay: ymd(to) };
}

router.get('/dashboard', permit('dashboard.read'), async (req, res) => {
  const bf = branchFilter(req);
  const today = startOfDay();
  const tomorrow = addDays(today, 1);
  const monthStart = dayjs().tz(tz).startOf('month').toDate();
  const canMoney = ['owner', 'manager', 'receptionist'].includes(req.user.role);

  const [
    active, frozen, expiring7, expiredLast30, newThisMonth, checkinsToday, deniedToday,
    collectedToday, collectedMonth, refundsMonth, expensesMonth, dueTotal, followUpsDue, alerts, devices, trend,
  ] = await Promise.all([
    Member.countDocuments({ ...bf, isDeleted: false, membershipStatus: 'active' }),
    Member.countDocuments({ ...bf, isDeleted: false, membershipStatus: 'frozen' }),
    Member.countDocuments({ ...bf, isDeleted: false, membershipStatus: 'active', membershipEnd: { $gte: today, $lt: addDays(today, 8) } }),
    Member.countDocuments({ ...bf, isDeleted: false, membershipStatus: 'expired', membershipEnd: { $gte: addDays(today, -30) } }),
    Member.countDocuments({ ...bf, isDeleted: false, createdAt: { $gte: monthStart } }),
    Attendance.countDocuments({ ...bf, day: ymd(today) }),
    AccessLog.countDocuments({ ...bf, result: 'deny', at: { $gte: today, $lt: tomorrow } }),
    canMoney ? sumBy(Payment, { ...bf, type: 'payment', paidAt: { $gte: today, $lt: tomorrow } }) : null,
    canMoney ? sumBy(Payment, { ...bf, type: 'payment', paidAt: { $gte: monthStart } }) : null,
    canMoney ? sumBy(Payment, { ...bf, type: 'refund', paidAt: { $gte: monthStart } }) : null,
    canMoney ? sumBy(Expense, { ...bf, isDeleted: false, date: { $gte: monthStart } }) : null,
    canMoney ? sumBy(Member, { ...bf, isDeleted: false, dueAmount: { $gt: 0 } }, '$dueAmount') : null,
    Lead.countDocuments({ ...bf, isDeleted: false, status: { $in: ['new', 'contacted', 'trial'] }, nextFollowUpAt: { $lt: tomorrow } }),
    Notification.find({ ...bf, channel: 'inapp', readAt: null }).sort({ createdAt: -1 }).limit(10).lean(),
    Device.find({ ...bf, isActive: true }).select('name lastSeenAt').lean(),
    Attendance.aggregate([
      { $match: { ...bf, day: { $gte: ymd(addDays(today, -13)) } } },
      { $group: { _id: '$day', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
  ]);

  res.json({
    success: true,
    data: {
      members: { active, frozen, expiringIn7Days: expiring7, expiredLast30Days: expiredLast30, newThisMonth },
      attendance: { checkinsToday, deniedToday, last14Days: trend.map((t) => ({ day: t._id, count: t.count })) },
      money: canMoney
        ? { collectedToday, collectedThisMonth: collectedMonth, refundsThisMonth: refundsMonth, expensesThisMonth: expensesMonth, totalDues: dueTotal }
        : null,
      followUpsDue,
      alerts,
      devices: devices.map((d) => ({ name: d.name, online: Boolean(d.lastSeenAt && Date.now() - new Date(d.lastSeenAt) < 120000), lastSeenAt: d.lastSeenAt })),
    },
  });
});

router.get('/collections', permit('reports.read'), async (req, res) => {
  const bf = branchFilter(req);
  const { from, toExclusive } = range(req);
  const match = { ...bf, paidAt: { $gte: from, $lt: toExclusive } };
  const [byDay, byMode] = await Promise.all([
    Payment.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$paidAt', timezone: tz } },
          collected: { $sum: { $cond: [{ $eq: ['$type', 'payment'] }, '$amount', 0] } },
          refunded: { $sum: { $cond: [{ $eq: ['$type', 'refund'] }, '$amount', 0] } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Payment.aggregate([{ $match: { ...match, type: 'payment' } }, { $group: { _id: '$mode', amount: { $sum: '$amount' }, count: { $sum: 1 } } }]),
  ]);
  if (isExport(req.query)) {
    return sendExport(res, req.query.export, 'collections', byDay, [
      { label: 'Date', key: '_id' },
      { label: 'Collected (Rs)', value: (r) => toRupees(r.collected) },
      { label: 'Refunded (Rs)', value: (r) => toRupees(r.refunded) },
      { label: 'Net (Rs)', value: (r) => toRupees(r.collected - r.refunded) },
      { label: 'Transactions', key: 'count' },
    ]);
  }
  const collected = byDay.reduce((s, d) => s + d.collected, 0);
  const refunded = byDay.reduce((s, d) => s + d.refunded, 0);
  res.json({ success: true, data: { byDay, byMode, totals: { collected, refunded, net: collected - refunded } } });
});

router.get('/dues', permit('reports.read'), async (req, res) => {
  const subs = await Subscription.find({ ...branchFilter(req), status: 'active', dueAmount: { $gt: 0 } })
    .sort({ dueAmount: -1 })
    .limit(2000)
    .populate('memberId', 'name memberCode phone')
    .lean();
  if (isExport(req.query)) {
    return sendExport(res, req.query.export, 'dues', subs, [
      { label: 'Member', value: (r) => r.memberId?.name },
      { label: 'Code', value: (r) => r.memberId?.memberCode },
      { label: 'Phone', value: (r) => r.memberId?.phone },
      { label: 'Plan', value: (r) => r.plan?.name },
      { label: 'Total (Rs)', value: (r) => toRupees(r.totalAmount) },
      { label: 'Paid (Rs)', value: (r) => toRupees(r.paidAmount) },
      { label: 'Due (Rs)', value: (r) => toRupees(r.dueAmount) },
    ]);
  }
  res.json({ success: true, data: { items: subs, total: subs.reduce((s, x) => s + x.dueAmount, 0) } });
});

router.get('/memberships', permit('reports.read'), async (req, res) => {
  const bf = branchFilter(req);
  const today = startOfDay();
  const days = Math.min(60, Number(req.query.days) || 7);
  const [expiring, recentlyExpired] = await Promise.all([
    Member.find({ ...bf, isDeleted: false, membershipStatus: { $in: ['active', 'frozen'] }, membershipEnd: { $gte: today, $lt: addDays(today, days + 1) } })
      .sort({ membershipEnd: 1 })
      .select('name memberCode phone membershipEnd currentPlanName dueAmount')
      .lean(),
    Member.find({ ...bf, isDeleted: false, membershipStatus: 'expired', membershipEnd: { $gte: addDays(today, -days) } })
      .sort({ membershipEnd: -1 })
      .select('name memberCode phone membershipEnd currentPlanName dueAmount')
      .lean(),
  ]);
  if (isExport(req.query)) {
    const rows = [...expiring.map((m) => ({ ...m, kind: 'expiring' })), ...recentlyExpired.map((m) => ({ ...m, kind: 'expired' }))];
    return sendExport(res, req.query.export, 'memberships', rows, [
      { label: 'Status', key: 'kind' },
      { label: 'Member', key: 'name' },
      { label: 'Code', key: 'memberCode' },
      { label: 'Phone', key: 'phone' },
      { label: 'Plan', key: 'currentPlanName' },
      { label: 'End date', value: (r) => ymd(r.membershipEnd) },
    ]);
  }
  res.json({ success: true, data: { expiring, recentlyExpired } });
});

router.get('/pnl', permit('reports.read'), async (req, res) => {
  const bf = branchFilter(req);
  const { from, toExclusive, fromDay, toDay } = range(req, 30);
  const [collected, refunded, expenses] = await Promise.all([
    sumBy(Payment, { ...bf, type: 'payment', paidAt: { $gte: from, $lt: toExclusive } }),
    sumBy(Payment, { ...bf, type: 'refund', paidAt: { $gte: from, $lt: toExclusive } }),
    Expense.aggregate([
      { $match: { ...bf, isDeleted: false, date: { $gte: from, $lt: toExclusive } } },
      { $group: { _id: '$category', amount: { $sum: '$amount' } } },
      { $sort: { amount: -1 } },
    ]),
  ]);
  const expenseTotal = expenses.reduce((s, e) => s + e.amount, 0);
  const income = collected - refunded;
  res.json({ success: true, data: { from: fromDay, to: toDay, income, collected, refunded, expenses: expenseTotal, expensesByCategory: expenses, profit: income - expenseTotal } });
});

router.get('/attendance', permit('reports.read'), async (req, res) => {
  const bf = branchFilter(req);
  const { fromDay, toDay } = range(req, 30);
  const [byDay, byHour, denied] = await Promise.all([
    Attendance.aggregate([{ $match: { ...bf, day: { $gte: fromDay, $lte: toDay } } }, { $group: { _id: '$day', count: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
    Attendance.aggregate([
      { $match: { ...bf, day: { $gte: fromDay, $lte: toDay } } },
      { $group: { _id: { $hour: { date: '$checkInAt', timezone: tz } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    AccessLog.aggregate([
      { $match: { ...bf, result: 'deny', at: { $gte: parseDay(fromDay), $lt: addDays(parseDay(toDay), 1) } } },
      { $group: { _id: '$code', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
  ]);
  res.json({ success: true, data: { byDay, byHour, deniedByReason: denied } });
});

router.get('/leads', permit('reports.read'), async (req, res) => {
  const bf = branchFilter(req);
  const { from, toExclusive } = range(req, 30);
  const rows = await Lead.aggregate([
    { $match: { ...bf, isDeleted: false, createdAt: { $gte: from, $lt: toExclusive } } },
    { $group: { _id: { source: '$source', status: '$status' }, n: { $sum: 1 } } },
  ]);
  const bySource = {};
  for (const r of rows) {
    const s = (bySource[r._id.source] ||= { source: r._id.source, total: 0, converted: 0 });
    s.total += r.n;
    if (r._id.status === 'converted') s.converted += r.n;
  }
  const list = Object.values(bySource).map((s) => ({ ...s, conversionRate: s.total ? Math.round((s.converted / s.total) * 100) : 0 }));
  res.json({ success: true, data: list });
});

export default router;
