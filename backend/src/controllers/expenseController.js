import { addExpense } from '../services/expenseService.js';

export const createExpense = async (req, res) => {
  const expense = await addExpense(req.body);
  res.status(201).json({ data: expense });
};