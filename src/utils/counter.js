import mongoose from 'mongoose';

const counterSchema = new mongoose.Schema({ key: { type: String, unique: true }, seq: { type: Number, default: 0 } });
export const Counter = mongoose.model('Counter', counterSchema);

/** Atomically increments and returns the next value for a key. */
export async function nextSeq(key, startAt = 1) {
  try {
    await Counter.updateOne({ key }, { $setOnInsert: { seq: startAt - 1 } }, { upsert: true });
  } catch (err) {
    if (err?.code !== 11000) throw err; // concurrent first insert: the other one won
  }
  const doc = await Counter.findOneAndUpdate({ key }, { $inc: { seq: 1 } }, { returnDocument: 'after' });
  return doc.seq;
}

/** Indian financial year label, e.g. 2026-27 (April to March). */
export function financialYear(d = new Date()) {
  const y = d.getFullYear();
  const start = d.getMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
