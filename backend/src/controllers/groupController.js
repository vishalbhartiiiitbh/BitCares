import { createGroup, joinGroupByCode, leaveGroup, listGroupsForUser } from '../services/groupService.js';
import { simplifyDebts } from '../services/debtSimplifier.js';

export const list = async (req, res) => {
  res.json({ data: await listGroupsForUser(req.user._id) });
};

export const create = async (req, res) => {
  const { name, memberIds } = req.body || {};
  if (!name) throw Object.assign(new Error('Group name is required'), { statusCode: 400 });
  const group = await createGroup({ name, createdBy: req.user._id, memberIds });
  res.status(201).json({ data: group });
};

export const join = async (req, res) => {
  const { groupCode } = req.body || {};
  if (!groupCode) throw Object.assign(new Error('Group code is required'), { statusCode: 400 });
  res.json({ data: await joinGroupByCode({ groupCode, userId: req.user._id }) });
};

export const leave = async (req, res) => {
  const group = await leaveGroup(req.params.groupId, req.user._id);
  res.json({ data: group });
};

export const simplify = async (req, res) => {
  res.json({ data: await simplifyDebts(req.params.groupId) });
};