import { ApiError } from '../../utils/ApiError.js';
import { dayjs, tz, parseDay, addDays } from '../../utils/dates.js';
import { Payslip } from './payroll.model.js';
import { User } from '../users/user.model.js';
import { StaffAttendance } from '../staff/staff.model.js';
import { PtSession } from '../pt/pt.model.js';
import { Expense } from '../expenses/expense.model.js';
import { getGym } from '../settings/gym.model.js';

/** Working days in a month = calendar days minus the gym's weekly off day(s). */
export function workingDaysIn(month, weeklyOff = [0]) {
  const start = dayjs.tz(`${month}-01T00:00:00`, tz);
  let n = 0;
  for (let d = start; d.month() === start.month(); d = d.add(1, 'day')) if (!weeklyOff.includes(d.day())) n += 1;
  return n;
}

const sum = (lines = []) => lines.reduce((s, l) => s + l.amount, 0);

export function computeTotals(p) {
  const grossPay = p.basePay + p.ptCommission + sum(p.additions);
  return { grossPay, netPay: Math.max(0, grossPay - sum(p.deductions)) };
}

/**
 * Creates / refreshes draft payslips for all active staff with a salary set.
 * Finalized or paid payslips are never touched.
 */
export async function generatePayroll({ month, branchFilter = {} }) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw ApiError.badRequest('Month must be YYYY-MM');
  const gym = await getGym();
  const weeklyOff = gym.settings?.payroll?.weeklyOff ?? [0];
  const prorate = gym.settings?.payroll?.prorateByAttendance !== false;
  const workingDays = workingDaysIn(month, weeklyOff);
  const from = parseDay(`${month}-01`);
  const to = addDays(dayjs(from).tz(tz).endOf('month').toDate(), 0);
  const userFilter = { isActive: true, 'salary.amount': { $gt: 0 } };
  if (branchFilter.branchId) userFilter.branchIds = branchFilter.branchId;

  const results = { created: 0, updated: 0, locked: 0 };
  for (const user of await User.find(userFilter).lean()) {
    const existing = await Payslip.findOne({ userId: user._id, month });
    if (existing && existing.status !== 'draft') {
      results.locked += 1;
      continue;
    }
    const [daysPresent, pt] = await Promise.all([
      StaffAttendance.countDocuments({ userId: user._id, day: { $gte: `${month}-01`, $lte: `${month}-31` } }),
      PtSession.aggregate([
        { $match: { trainerId: user._id, at: { $gte: from, $lte: to } } },
        { $group: { _id: null, commission: { $sum: '$commission' }, sessions: { $sum: 1 } } },
      ]),
    ]);
    const { type, amount } = user.salary;
    const paidLeaveDays = existing?.paidLeaveDays || 0;
    const counted = Math.min(workingDays, daysPresent + paidLeaveDays);
    const basePay =
      type === 'per-day' ? amount * counted : prorate ? Math.round((amount * counted) / workingDays) : amount;

    const data = {
      userId: user._id,
      branchId: user.branchIds?.[0],
      month,
      salaryType: type,
      rate: amount,
      workingDays,
      daysPresent,
      paidLeaveDays,
      basePay,
      ptCommission: pt[0]?.commission || 0,
      ptSessions: pt[0]?.sessions || 0,
      additions: existing?.additions || [],
      deductions: existing?.deductions || [],
    };
    Object.assign(data, computeTotals(data));
    if (existing) {
      Object.assign(existing, data);
      await existing.save();
      results.updated += 1;
    } else {
      await Payslip.create(data);
      results.created += 1;
    }
  }
  return results;
}

/** Marks a finalized payslip as paid and books it as a salary expense (shows in P&L). */
export async function payPayslip({ payslip, mode, reference, user }) {
  if (payslip.status !== 'finalized') throw ApiError.badRequest('Finalize the payslip before paying');
  const staff = await User.findById(payslip.userId).lean();
  const branchId = payslip.branchId || staff?.branchIds?.[0];
  let expense = null;
  if (branchId && payslip.netPay > 0) {
    expense = await Expense.create({
      branchId,
      category: 'salary',
      amount: payslip.netPay,
      date: new Date(),
      mode: mode === 'bank' ? 'bank' : mode,
      note: `Salary ${payslip.month}: ${staff?.name}`,
      createdBy: user?._id,
    });
  }
  payslip.status = 'paid';
  payslip.paidAt = new Date();
  payslip.paymentMode = mode;
  payslip.reference = reference;
  payslip.expenseId = expense?._id;
  await payslip.save();
  return payslip;
}
