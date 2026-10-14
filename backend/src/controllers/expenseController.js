import { addExpense, listExpenses } from '../services/expenseService.js';

export const list = async (req, res) => {
  res.json({ data: await listExpenses(req.query.groupId) });
};

export const createExpense = async (req, res) => {
  const allowedStrategies = ['EQUAL', 'EXACT', 'PERCENTAGE', 'SHARES', 'ADJUSTMENT', 'REIMBURSEMENT', 'ITEMIZED'];
  if (!allowedStrategies.includes(req.body.splitStrategy)) {
    throw Object.assign(new Error('Choose a supported expense split method'), { statusCode: 400 });
  }
  if (!req.body.groupId && req.body.paidBy && req.body.paidBy !== req.user._id) {
    throw Object.assign(new Error('Personal expenses must be paid by you'), { statusCode: 400 });
  }
  const parseArray = (value, label) => {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string') throw Object.assign(new Error(`${label} must be a list`), { statusCode: 400 });
    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed)) throw new Error();
      return parsed;
    } catch {
      throw Object.assign(new Error(`${label} must be a valid list`), { statusCode: 400 });
    }
  };
  const expense = await addExpense({
    ...req.body,
    participants: parseArray(req.body.participants, 'Participants'),
    values: req.body.values ? parseArray(req.body.values, 'Split values') : undefined,
    items: req.body.items ? parseArray(req.body.items, 'Itemized expenses') : undefined,
    paidBy: req.body.paidBy || req.user._id,
    proofBuffer: req.file?.buffer || null,
    type: req.body.type === 'REIMBURSEMENT' ? 'REIMBURSEMENT' : 'EXPENSE',
  });
  res.status(201).json({ data: expense });
};