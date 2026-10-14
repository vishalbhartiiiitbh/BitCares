import crypto from 'node:crypto';
import { query, withTransaction } from '../db/index.js';

const groupCode = () => crypto.randomBytes(4).toString('hex').toUpperCase();
const hydrate = async (row, client = null) => {
	const runQuery = client ? client.query.bind(client) : query;
	const members = await runQuery('SELECT u.id AS "_id", u.username, u.email, u.fullnamae FROM users u JOIN group_members gm ON gm.user_id = u.id WHERE gm.group_id = $1', [row._id]);
	return { ...row, members: members.rows };
};

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
export const listGroupsForUser = async (userId) => { const result = await query('SELECT g.id AS "_id", g.name, g.group_code AS "groupCode", g.created_by AS "createdBy", g.created_at AS "createdAt" FROM groups g JOIN group_members gm ON gm.group_id = g.id WHERE gm.user_id = $1 ORDER BY g.created_at DESC', [userId]); return Promise.all(result.rows.map((row) => hydrate(row))); };
export const getGroupBalances = async (groupId, userId) => {
	const membership = await query(
		'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
		[groupId, userId],
	);
	if (!membership.rowCount) {
		throw Object.assign(new Error('Group or membership not found'), { statusCode: 404 });
	}

	const result = await query(
		`SELECT u.id AS "_id", u.username, u.fullnamae,
		        COALESCE(SUM(CASE
		          WHEN b.user1 = u.id THEN b.net_owed
		          WHEN b.user2 = u.id THEN -b.net_owed
		          ELSE 0
		        END), 0)::text AS "netBalance"
		 FROM group_members gm
		 JOIN users u ON u.id = gm.user_id
		 LEFT JOIN balances b ON b.group_id = gm.group_id
		 WHERE gm.group_id = $1
		 GROUP BY u.id, u.username, u.fullnamae
		 ORDER BY u.fullnamae`,
		[groupId],
	);
	return result.rows;
};
export const updateGroupName = async (groupId, userId, name) => {
	const result = await query(
		`UPDATE groups SET name = $1
		 WHERE id = $2 AND created_by = $3
		 RETURNING id AS "_id", name, group_code AS "groupCode",
		           created_by AS "createdBy", created_at AS "createdAt"`,
		[name.trim(), groupId, userId],
	);
	if (result.rowCount) return result.rows[0];

	const group = await query('SELECT 1 FROM groups WHERE id = $1', [groupId]);
	if (!group.rowCount) throw Object.assign(new Error('Group not found'), { statusCode: 404 });
	throw Object.assign(new Error('Only the group creator can change group settings'), { statusCode: 403 });
};
export const joinGroupByCode = async ({ groupCode: code, userId }) => { const result = await query('SELECT id AS "_id", name, group_code AS "groupCode", created_by AS "createdBy", created_at AS "createdAt" FROM groups WHERE group_code = $1', [code.trim().toUpperCase()]); if (!result.rowCount) throw Object.assign(new Error('Group code not found'), { statusCode: 404 }); await query('INSERT INTO group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [result.rows[0]._id, userId]); return hydrate(result.rows[0]); };
export const leaveGroup = async (groupId, userId) => withTransaction(async (client) => { const unsettled = await client.query('SELECT 1 FROM balances WHERE group_id = $1 AND (user1 = $2 OR user2 = $2) AND net_owed <> 0 LIMIT 1', [groupId, userId]); if (unsettled.rowCount) throw Object.assign(new Error('Cannot leave group with unsettled balances'), { statusCode: 400 }); const result = await client.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2 RETURNING group_id', [groupId, userId]); if (!result.rowCount) throw Object.assign(new Error('Group or membership not found'), { statusCode: 404 }); return { groupId, removed: true }; });
