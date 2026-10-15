import { addGroupMember, createGroup, deleteGroup, getGroupBalances, joinGroupByCode, leaveGroup, listGroupsForUser, removeGroupMember, updateGroupSettings } from '../services/groupService.js';
import { simplifyDebts } from '../services/debtSimplifier.js';
import { recordSettlement } from '../services/settlementService.js';
import { deleteImageByUrl, uploadImageBuffer } from '../config/cloudinary.js';

export const list = async (req, res) => {
  res.json({ data: await listGroupsForUser(req.user._id) });
};

export const create = async (req, res) => {
  const { name, simplifyDebts = 'false' } = req.body || {};
  const parseList = (field, label) => {
    const value = req.body?.[field] ?? [];
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string') {
      throw Object.assign(new Error(`${label} must be a list`), { statusCode: 400 });
    }
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      throw Object.assign(new Error(`${label} must be a valid list`), { statusCode: 400 });
    }
    throw Object.assign(new Error(`${label} must be a list`), { statusCode: 400 });
  };
  const memberIds = parseList('memberIds', 'Group members');
  const memberIdentifiers = parseList('memberIdentifiers', 'Group member usernames or emails');
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
  if (simplifyDebts !== 'true' && simplifyDebts !== 'false' && typeof simplifyDebts !== 'boolean') {
    throw Object.assign(new Error('Simplify debts must be true or false'), { statusCode: 400 });
  }
  const coverImageUrl = req.file
    ? await uploadImageBuffer(req.file.buffer, 'splitcare/group-covers')
    : null;
  let group;
  try {
    group = await createGroup({
      name,
      createdBy: req.user._id,
      memberIds,
      memberIdentifiers,
      simplifyDebts: simplifyDebts === true || simplifyDebts === 'true',
      coverImageUrl,
    });
  } catch (error) {
    if (coverImageUrl) {
      try {
        await deleteImageByUrl(coverImageUrl);
      } catch (cleanupError) {
        console.error('Group creation failed, and its uploaded cover image could not be deleted:', cleanupError);
      }
    }
    throw error;
  }
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

export const remove = async (req, res) => {
  res.json({ data: await deleteGroup(req.params.groupId, req.user._id) });
};

export const balances = async (req, res) => {
  res.json({ data: await getGroupBalances(req.params.groupId, req.user._id) });
};

export const update = async (req, res) => {
  const { name, simplifyDebts } = req.body || {};
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    throw Object.assign(new Error('Group name cannot be empty'), { statusCode: 400 });
  }
  if (typeof name === 'string' && name.trim().length > 120) {
    throw Object.assign(new Error('Group name must be 120 characters or fewer'), { statusCode: 400 });
  }
  let parsedSimplifyDebts;
  if (simplifyDebts !== undefined) {
    if (simplifyDebts !== 'true' && simplifyDebts !== 'false' && typeof simplifyDebts !== 'boolean') {
      throw Object.assign(new Error('Simplify debts must be true or false'), { statusCode: 400 });
    }
    parsedSimplifyDebts = simplifyDebts === true || simplifyDebts === 'true';
  }
  if (name === undefined && parsedSimplifyDebts === undefined && !req.file && req.body.removeCoverImage !== 'true') {
    throw Object.assign(new Error('Provide a group setting to update'), { statusCode: 400 });
  }
  const groupBeforeUpdate = (await listGroupsForUser(req.user._id))
    .find((group) => group._id === req.params.groupId);
  if (!groupBeforeUpdate) throw Object.assign(new Error('Group or membership not found'), { statusCode: 404 });
  if (groupBeforeUpdate.isPersonal) throw Object.assign(new Error('Personal Expenses settings cannot be changed'), { statusCode: 400 });
  const previousCover = groupBeforeUpdate.coverImageUrl;
  const coverImageUrl = req.file
    ? await uploadImageBuffer(req.file.buffer, 'splitcare/group-covers')
    : undefined;
  const group = await updateGroupSettings({
    groupId: req.params.groupId,
    userId: req.user._id,
    name,
    simplifyDebts: parsedSimplifyDebts,
    coverImageUrl,
    removeCoverImage: req.body.removeCoverImage === 'true',
  });
  let cleanupWarning;
  if (previousCover && previousCover !== group.coverImageUrl) {
    try {
      await deleteImageByUrl(previousCover);
    } catch (error) {
      console.error('Group settings saved, but the previous cover image could not be deleted:', error);
      cleanupWarning = 'Settings saved, but the previous cover image could not be deleted.';
    }
  }
  res.json({ data: cleanupWarning ? { ...group, warning: cleanupWarning } : group });
};

export const addMember = async (req, res) => {
  const { identifier } = req.body || {};
  if (typeof identifier !== 'string' || !identifier.trim()) {
    throw Object.assign(new Error('Enter a username or email address'), { statusCode: 400 });
  }
  res.status(201).json({
    data: await addGroupMember({
      groupId: req.params.groupId,
      requesterId: req.user._id,
      identifier,
    }),
  });
};

export const removeMember = async (req, res) => {
  res.json({
    data: await removeGroupMember({
      groupId: req.params.groupId,
      requesterId: req.user._id,
      memberId: req.params.memberId,
    }),
  });
};

export const settle = async (req, res) => {
  res.status(201).json({
    data: await recordSettlement({
      groupId: req.params.groupId,
      payerId: req.user._id,
      payeeId: req.body?.payeeId,
      amount: req.body?.amount,
      currency: req.body?.currency,
      note: req.body?.note || null,
      proofBuffer: req.file?.buffer || null,
    }),
  });
};

export const simplify = async (req, res) => {
  res.json({ data: await simplifyDebts(req.params.groupId, req.user._id) });
};