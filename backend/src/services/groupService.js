import crypto from 'node:crypto';
import { query, withTransaction } from '../db/index.js';

const groupCode = () => crypto.randomBytes(4).toString('hex').toUpperCase();
const hydrate = async (row, client = null) => {
	const runQuery = client ? client.query.bind(client) : query;
	const members = await runQuery('SELECT u.id AS "_id", u.username, u.email, u.fullnamae, u.coverimage FROM users u JOIN group_members gm ON gm.user_id = u.id WHERE gm.group_id = $1 ORDER BY u.fullnamae', [row._id]);
	return { ...row, members: members.rows };
};

export const ensurePersonalExpenseGroup = async (userId) => withTransaction(async (client) => {
	const result = await client.query(
		`INSERT INTO groups (name, group_code, created_by, is_personal)
		 VALUES ('Personal Expenses', $1, $2, TRUE)
		 ON CONFLICT (created_by) WHERE is_personal = TRUE
		 DO UPDATE SET name = 'Personal Expenses'
		 RETURNING id AS "_id", name, group_code AS "groupCode",
		           created_by AS "createdBy", is_personal AS "isPersonal",
		           created_at AS "createdAt"`,
		[groupCode(), userId],
	);
	const group = result.rows[0];
	await client.query(
		'DELETE FROM group_members WHERE group_id = $1 AND user_id <> $2',
		[group._id, userId],
	);
	await client.query(
		'INSERT INTO group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
		[group._id, userId],
	);
	return hydrate(group, client);
});

export const createGroup = async ({ name, createdBy, memberIds = [], memberIdentifiers = [] }) => withTransaction(async (client) => {
	const identifiers = [...new Set(memberIdentifiers.map((identifier) => identifier.trim().toLowerCase()).filter(Boolean))];
	const resolvedMemberIds = [];
	for (const identifier of identifiers) {
		const result = await client.query(
			'SELECT id AS "_id" FROM users WHERE LOWER(username) = $1 OR LOWER(email) = $1',
			[identifier],
		);
		if (!result.rowCount) {
			throw Object.assign(new Error(`No SplitCare user found with username or email "${identifier}"`), { statusCode: 404 });
		}
		if (result.rowCount > 1) {
			throw Object.assign(new Error(`The username or email "${identifier}" matches more than one user`), { statusCode: 409 });
		}
		resolvedMemberIds.push(result.rows[0]._id);
	}

	const allMemberIds = [...new Set([...memberIds, ...resolvedMemberIds])];
	if (allMemberIds.length) {
		const existingMembers = await client.query(
			'SELECT id FROM users WHERE id = ANY($1::uuid[])',
			[allMemberIds],
		);
		if (existingMembers.rowCount !== allMemberIds.length) {
			throw Object.assign(new Error('One or more selected group members could not be found'), { statusCode: 404 });
		}
	}

	const created = await client.query('INSERT INTO groups (name, group_code, created_by) VALUES ($1,$2,$3) RETURNING id AS "_id", name, group_code AS "groupCode", created_by AS "createdBy", created_at AS "createdAt"', [name.trim(), groupCode(), createdBy]);
	const id = created.rows[0]._id;
	for (const member of [...new Set([createdBy, ...allMemberIds])]) await client.query('INSERT INTO group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, member]);
	return hydrate(created.rows[0], client);
});
export const listGroupsForUser = async (userId) => { const result = await query('SELECT g.id AS "_id", g.name, g.group_code AS "groupCode", g.created_by AS "createdBy", g.is_personal AS "isPersonal", g.cover_image_url AS "coverImageUrl", g.simplify_debts AS "simplifyDebts", g.created_at AS "createdAt" FROM groups g JOIN group_members gm ON gm.group_id = g.id WHERE gm.user_id = $1 ORDER BY g.created_at DESC', [userId]); return Promise.all(result.rows.map((row) => hydrate(row))); };
export const addGroupMember = async ({ groupId, requesterId, identifier }) => withTransaction(async (client) => {
	const groupResult = await client.query(
		'SELECT id AS "_id", name, group_code AS "groupCode", created_by AS "createdBy", is_personal AS "isPersonal", created_at AS "createdAt" FROM groups WHERE id = $1',
		[groupId],
	);
	const group = groupResult.rows[0];
	if (!group) throw Object.assign(new Error('Group not found'), { statusCode: 404 });
	if (group.isPersonal) throw Object.assign(new Error('Personal Expenses can only contain your account'), { statusCode: 400 });

	const requester = await client.query(
		'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
		[groupId, requesterId],
	);
	if (!requester.rowCount) throw Object.assign(new Error('Only group members can add people'), { statusCode: 403 });

	const normalizedIdentifier = identifier.trim().toLowerCase();
	const targetResult = await client.query(
		'SELECT id AS "_id" FROM users WHERE LOWER(username) = $1 OR LOWER(email) = $1',
		[normalizedIdentifier],
	);
	if (!targetResult.rowCount) {
		throw Object.assign(new Error('No SplitCare account was found with that username or email'), { statusCode: 404 });
	}
	const targetId = targetResult.rows[0]._id;
	if (targetId === requesterId) {
		throw Object.assign(new Error('You are already a member of this group'), { statusCode: 409 });
	}

	const inserted = await client.query(
		'INSERT INTO group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING user_id',
		[groupId, targetId],
	);
	if (!inserted.rowCount) {
		throw Object.assign(new Error('That person is already in this group'), { statusCode: 409 });
	}
	return hydrate(group, client);
});
export const getGroupBalances = async (groupId, userId) => {
	const membership = await query(
		'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
		[groupId, userId],
	);
	if (!membership.rowCount) {
		throw Object.assign(new Error('Group or membership not found'), { statusCode: 404 });
	}

	const result = await query(
		`SELECT u.id AS "_id", u.username, u.fullnamae, b.currency,
		        COALESCE(SUM(CASE
		          WHEN b.user1 = u.id THEN b.net_owed
		          WHEN b.user2 = u.id THEN -b.net_owed
		          ELSE 0
		        END), 0)::text AS "netBalance"
		 FROM group_members gm
		 JOIN users u ON u.id = gm.user_id
		 LEFT JOIN balances b ON b.group_id = gm.group_id
		 WHERE gm.group_id = $1
		 GROUP BY u.id, u.username, u.fullnamae, b.currency
		 ORDER BY u.fullnamae`,
		[groupId],
	);
	return result.rows;
};
export const updateGroupSettings = async ({ groupId, userId, name, simplifyDebts, coverImageUrl, removeCoverImage = false }) => withTransaction(async (client) => {
	const membership = await client.query(
		`SELECT g.id, g.name, g.group_code AS "groupCode", g.created_by AS "createdBy",
		        g.is_personal AS "isPersonal", g.cover_image_url AS "coverImageUrl",
		        g.simplify_debts AS "simplifyDebts", g.created_at AS "createdAt"
		 FROM groups g JOIN group_members gm ON gm.group_id = g.id
		 WHERE g.id = $1 AND gm.user_id = $2 FOR UPDATE OF g`,
		[groupId, userId],
	);
	if (!membership.rowCount) throw Object.assign(new Error('Group or membership not found'), { statusCode: 404 });
	const group = membership.rows[0];
	if (group.isPersonal) throw Object.assign(new Error('Personal Expenses settings cannot be changed'), { statusCode: 400 });
	const nextName = name === undefined ? group.name : name.trim();
	const nextSimplifyDebts = simplifyDebts === undefined ? group.simplifyDebts : simplifyDebts;
	const nextCoverImageUrl = coverImageUrl || (removeCoverImage ? null : group.coverImageUrl);
	const result = await client.query(
		`UPDATE groups
		 SET name = $1, simplify_debts = $2, cover_image_url = $3
		 WHERE id = $4
		 RETURNING id AS "_id", name, group_code AS "groupCode",
		           created_by AS "createdBy", is_personal AS "isPersonal",
		           cover_image_url AS "coverImageUrl", simplify_debts AS "simplifyDebts",
		           created_at AS "createdAt"`,
		[nextName, nextSimplifyDebts, nextCoverImageUrl, groupId],
	);
	return hydrate(result.rows[0], client);
});

export const removeGroupMember = async ({ groupId, requesterId, memberId }) => withTransaction(async (client) => {
	const group = await client.query(
		'SELECT id, created_by AS "createdBy", is_personal AS "isPersonal" FROM groups WHERE id = $1 FOR UPDATE',
		[groupId],
	);
	if (!group.rowCount) throw Object.assign(new Error('Group not found'), { statusCode: 404 });
	if (group.rows[0].isPersonal) throw Object.assign(new Error('Personal Expenses members cannot be removed'), { statusCode: 400 });
	const requester = await client.query(
		'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
		[groupId, requesterId],
	);
	if (!requester.rowCount) throw Object.assign(new Error('Only group members can manage members'), { statusCode: 403 });
	if (memberId === requesterId) throw Object.assign(new Error('Use Leave group to remove yourself'), { statusCode: 400 });
	if (memberId === group.rows[0].createdBy) throw Object.assign(new Error('The group creator cannot be removed'), { statusCode: 400 });
	const target = await client.query(
		'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
		[groupId, memberId],
	);
	if (!target.rowCount) throw Object.assign(new Error('Group member not found'), { statusCode: 404 });
	const unsettled = await client.query(
		'SELECT 1 FROM balances WHERE group_id = $1 AND net_owed <> 0 AND (user1 = $2 OR user2 = $2) LIMIT 1',
		[groupId, memberId],
	);
	if (unsettled.rowCount) throw Object.assign(new Error('Settle this member’s balances before removing them'), { statusCode: 400 });
	await client.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, memberId]);
	return hydrate({
		_id: groupId,
		...((await client.query(
			`SELECT name, group_code AS "groupCode", created_by AS "createdBy",
			        is_personal AS "isPersonal", cover_image_url AS "coverImageUrl",
			        simplify_debts AS "simplifyDebts", created_at AS "createdAt"
			 FROM groups WHERE id = $1`,
			[groupId],
		)).rows[0]),
	}, client);
});
export const joinGroupByCode = async ({ groupCode: code, userId }) => { const result = await query('SELECT id AS "_id", name, group_code AS "groupCode", created_by AS "createdBy", is_personal AS "isPersonal", created_at AS "createdAt" FROM groups WHERE group_code = $1', [code.trim().toUpperCase()]); if (!result.rowCount) throw Object.assign(new Error('Group code not found'), { statusCode: 404 }); if (result.rows[0].isPersonal) throw Object.assign(new Error('Personal Expenses is private to its owner'), { statusCode: 403 }); await query('INSERT INTO group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [result.rows[0]._id, userId]); return hydrate(result.rows[0]); };
const ensureGroupIsSettled = async (client, groupId) => {
	const unsettled = await client.query(
		'SELECT 1 FROM balances WHERE group_id = $1 AND net_owed <> 0 LIMIT 1',
		[groupId],
	);
	if (unsettled.rowCount) {
		throw Object.assign(new Error('Settle all group balances before leaving or deleting this group'), { statusCode: 400 });
	}
};

export const leaveGroup = async (groupId, userId) => withTransaction(async (client) => {
	const group = await client.query('SELECT id, is_personal FROM groups WHERE id = $1 FOR UPDATE', [groupId]);
	if (!group.rowCount) throw Object.assign(new Error('Group not found'), { statusCode: 404 });
	if (group.rows[0].is_personal) throw Object.assign(new Error('Personal Expenses cannot be left'), { statusCode: 400 });

	const membership = await client.query(
		'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
		[groupId, userId],
	);
	if (!membership.rowCount) throw Object.assign(new Error('Group membership not found'), { statusCode: 404 });

	await ensureGroupIsSettled(client, groupId);
	await client.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
	const remainingMembers = await client.query('SELECT 1 FROM group_members WHERE group_id = $1 LIMIT 1', [groupId]);
	if (!remainingMembers.rowCount) {
		await client.query('DELETE FROM groups WHERE id = $1', [groupId]);
		return { groupId, removed: true, groupDeleted: true };
	}
	return { groupId, removed: true, groupDeleted: false };
});

export const deleteGroup = async (groupId, userId) => withTransaction(async (client) => {
	const group = await client.query(
		'SELECT id, is_personal FROM groups WHERE id = $1 AND created_by = $2 FOR UPDATE',
		[groupId, userId],
	);
	if (!group.rowCount) {
		const exists = await client.query('SELECT 1 FROM groups WHERE id = $1', [groupId]);
		if (!exists.rowCount) throw Object.assign(new Error('Group not found'), { statusCode: 404 });
		throw Object.assign(new Error('Only the group creator can delete this group'), { statusCode: 403 });
	}
	if (group.rows[0].is_personal) throw Object.assign(new Error('Personal Expenses cannot be deleted'), { statusCode: 400 });

	await ensureGroupIsSettled(client, groupId);
	await client.query('DELETE FROM groups WHERE id = $1', [groupId]);
	return { groupId, deleted: true };
});
