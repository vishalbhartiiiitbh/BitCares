import { addExpense, listExpenses } from '../services/expenseService.js';

export const list = async (req, res) => {
  res.json({ data: await listExpenses(req.query.groupId) });
};

export const createExpense = async (req, res) => {
  const expense = await addExpense(req.body);
  res.status(201).json({ data: expense });
};