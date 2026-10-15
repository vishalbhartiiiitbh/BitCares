import { addExpense, addExpenseComment, deleteExpenseComment, listExpenses, listPersonalExpenses, updateExpense } from '../services/expenseService.js';

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

const validateExpenseOptions = (body) => {
  const allowedCategories = ['Entertainment', 'Food and drink', 'Home', 'Life', 'Transportation', 'Uncategorized', 'Utilities'];
  if (!allowedCategories.includes(body.category || 'Uncategorized')) {
    throw Object.assign(new Error('Choose a supported expense category'), { statusCode: 400 });
  }
  const allowedStrategies = ['EQUAL', 'EXACT', 'PERCENTAGE', 'SHARES', 'ADJUSTMENT', 'REIMBURSEMENT', 'ITEMIZED'];
  if (!allowedStrategies.includes(body.splitStrategy)) {
    throw Object.assign(new Error('Choose a supported expense split method'), { statusCode: 400 });
  }
};

export const list = async (req, res) => {
  res.json({ data: await listExpenses(req.query.groupId, req.user._id) });
};

export const listPersonal = async (req, res) => {
  res.json({ data: await listPersonalExpenses(req.user._id) });
};

export const createExpense = async (req, res) => {
  validateExpenseOptions(req.body);
  if (!req.body.groupId) {
    const participants = parseArray(req.body.participants, 'Participants');
    if (req.body.paidBy && req.body.paidBy !== req.user._id) {
      throw Object.assign(new Error('Personal expenses must be paid by you'), { statusCode: 400 });
    }
    if (!Array.isArray(participants) || participants.length !== 1 || participants[0] !== req.user._id) {
      throw Object.assign(new Error('Personal expenses can only include your account'), { statusCode: 400 });
    }
  }
  const expense = await addExpense({
    ...req.body,
    participants: parseArray(req.body.participants, 'Participants'),
    values: req.body.values ? parseArray(req.body.values, 'Split values') : undefined,
    items: req.body.items ? parseArray(req.body.items, 'Itemized expenses') : undefined,
    paidBy: req.body.paidBy || req.user._id,
    proofBuffer: req.file?.buffer || null,
    type: req.body.type === 'REIMBURSEMENT' ? 'REIMBURSEMENT' : 'EXPENSE',
    category: req.body.category || 'Uncategorized',
    subcategory: req.body.subcategory || null,
  });
  res.status(201).json({ data: expense });
};

export const editExpense = async (req, res) => {
  validateExpenseOptions(req.body);
  const expense = await updateExpense({
    ...req.body,
    expenseId: req.params.expenseId,
    editorId: req.user._id,
    participants: parseArray(req.body.participants, 'Participants'),
    values: req.body.values ? parseArray(req.body.values, 'Split values') : undefined,
    items: req.body.items ? parseArray(req.body.items, 'Itemized expenses') : [],
    paidBy: req.body.paidBy,
    proofBuffer: req.file?.buffer || null,
    removePaymentProof: req.body.removePaymentProof === 'true',
    category: req.body.category || 'Uncategorized',
    subcategory: req.body.subcategory || null,
  });
  res.json({ data: expense });
};

export const createComment = async (req, res) => {
  const { content } = req.body || {};
  if (typeof content !== 'string' || !content.trim()) {
    throw Object.assign(new Error('Enter a comment before posting'), { statusCode: 400 });
  }
  if (content.trim().length > 1000) {
    throw Object.assign(new Error('Comments must be 1,000 characters or fewer'), { statusCode: 400 });
  }
  res.status(201).json({
    data: await addExpenseComment({
      expenseId: req.params.expenseId,
      userId: req.user._id,
      content,
    }),
  });
};

export const removeComment = async (req, res) => {
  res.json({
    data: await deleteExpenseComment({
      commentId: req.params.commentId,
      userId: req.user._id,
    }),
  });
};