import { createGroup, getGroupBalances, joinGroupByCode, leaveGroup, listGroupsForUser, updateGroupName } from '../services/groupService.js';
import { simplifyDebts } from '../services/debtSimplifier.js';

export const list = async (req, res) => {
  res.json({ data: await listGroupsForUser(req.user._id) });
};

export const create = async (req, res) => {
  const { name, memberIds = [], memberIdentifiers = [] } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) {
    throw Object.assign(new Error('Group name is required'), { statusCode: 400 });
  }
  if (name.trim().length > 120) {
    throw Object.assign(new Error('Group name must be 120 characters or fewer'), { statusCode: 400 });
  }
  if (!Array.isArray(memberIds) || memberIds.some((id) => typeof id !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))) {
    throw Object.assign(new Error('Group members must be a list of user IDs'), { statusCode: 400 });
  }
  if (!Array.isArray(memberIdentifiers) || memberIdentifiers.some((identifier) => typeof identifier !== 'string')) {
    throw Object.assign(new Error('Group member usernames or emails must be a list of strings'), { statusCode: 400 });
  }
  const group = await createGroup({ name, createdBy: req.user._id, memberIds, memberIdentifiers });
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

export const balances = async (req, res) => {
  res.json({ data: await getGroupBalances(req.params.groupId, req.user._id) });
};

export const update = async (req, res) => {
  const { name } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) {
    throw Object.assign(new Error('Group name is required'), { statusCode: 400 });
  }
  if (name.trim().length > 120) {
    throw Object.assign(new Error('Group name must be 120 characters or fewer'), { statusCode: 400 });
  }
  res.json({ data: await updateGroupName(req.params.groupId, req.user._id, name) });
};

export const simplify = async (req, res) => {
  res.json({ data: await simplifyDebts(req.params.groupId, req.user._id) });
};