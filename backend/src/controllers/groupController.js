import { leaveGroup } from '../services/groupService.js';
import { simplifyDebts } from '../services/debtSimplifier.js';

export const leave = async (req, res) => {
  const group = await leaveGroup(req.params.groupId, req.body.userId);
  res.json({ data: group });
};

export const simplify = async (req, res) => {
  res.json({ data: await simplifyDebts(req.params.groupId) });
};