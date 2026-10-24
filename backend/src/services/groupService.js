import crypto from 'node:crypto';
import Decimal from 'decimal.js';
import { query, withTransaction } from '../db/index.js';
import { simplifyDebts } from './debtSimplifier.js';
import { getExchangeRate } from './exchangeRateService.js';
import { recordGroupActivity } from './groupActivityService.js';
import { normalizeGroupBalances, normalizeGroupBalancesInTransaction } from './groupCurrencyService.js';

/** Generate a short, uppercase invite code for a newly created group. */
const groupCode = () => crypto.randomBytes(4).toString('hex').toUpperCase();
/** Add the group's member records to a database group row. */
const hydrate = async (row, client = null) => {
	const runQuery = client ? client.query.bind(client) : query;
	const members = await runQuery('SELECT u.id AS "_id", u.username, u.email, u.fullnamae, u.coverimage FROM users u JOIN group_members gm ON gm.user_id = u.id WHERE gm.group_id = $1 ORDER BY u.fullnamae', [row._id]);
	return { ...row, members: members.rows };
};

/** Return the user's private expense group, creating it when it does not exist. */
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

/** Create a shared group, resolve invitees, add memberships, and record its creation activity. */
export const createGroup = async ({ name, createdBy, memberIds = [], memberIdentifiers = [], simplifyDebts = false, coverImageUrl = null, currency = 'INR' }) => withTransaction(async (client) => {
	const identifiers = [...new Set(memberIdentifiers.map((identifier) => identifier.trim().toLowerCase()).filter(Boolean))];
	const resolvedMemberIds = [];
	for (const identifier of identifiers) {
		const result = await client.query(
			'SELECT id AS "_id" FROM users WHERE LOWER(username) = $1 OR LOWER(email) = $1',
			[identifier],
		);
		if (!result.rowCount) {
			throw Object.assign(new Error(`No Splitpayerly user found with username or email "${identifier}"`), { statusCode: 404 });
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

	const created = await client.query(
		`INSERT INTO groups (name, group_code, created_by, simplify_debts, cover_image_url, currency)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING id AS "_id", name, group_code AS "groupCode", created_by AS "createdBy",
		           simplify_debts AS "simplifyDebts", cover_image_url AS "coverImageUrl",
		           currency, created_at AS "createdAt"`,
		[name.trim(), groupCode(), createdBy, simplifyDebts, coverImageUrl, currency],
	);
	const id = created.rows[0]._id;
	for (const member of [...new Set([createdBy, ...allMemberIds])]) await client.query('INSERT INTO group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, member]);
	const creator = await client.query('SELECT fullnamae FROM users WHERE id = $1', [createdBy]);
	await recordGroupActivity(client, {
		groupId: id,
		actorId: createdBy,
		activityType: 'GROUP_CREATED',
		description: `Group created: ${name.trim()}`,
		details: `${creator.rows[0]?.fullnamae || 'A member'} created this group.`,
	});
	return hydrate(created.rows[0], client);
});
/** List the user's groups with member details attached. */
export const listGroupsForUser = async (userId) => { const result = await query('SELECT g.id AS "_id", g.name, g.group_code AS "groupCode", g.created_by AS "createdBy", g.is_personal AS "isPersonal", g.cover_image_url AS "coverImageUrl", g.simplify_debts AS "simplifyDebts", g.currency, g.created_at AS "createdAt" FROM groups g JOIN group_members gm ON gm.group_id = g.id WHERE gm.user_id = $1 AND NOT g.is_friend_ledger ORDER BY g.created_at DESC', [userId]); return Promise.all(result.rows.map((row) => hydrate(row))); };
/** Resolve an account identifier and add that account to a group transactionally. */
export const addGroupMember = async ({ groupId, requesterId, identifier }) => withTransaction(async (client) => {
	const groupResult = await client.query(
		'SELECT id AS "_id", name, group_code AS "groupCode", created_by AS "createdBy", is_personal AS "isPersonal", is_friend_ledger AS "isFriendLedger", currency, created_at AS "createdAt" FROM groups WHERE id = $1',
		[groupId],
	);
	const group = groupResult.rows[0];
	if (!group) throw Object.assign(new Error('Group not found'), { statusCode: 404 });
	if (group.isPersonal) throw Object.assign(new Error('Personal Expenses can only contain your account'), { statusCode: 400 });
	if (group.isFriendLedger) throw Object.assign(new Error('This private friend ledger cannot be managed as a group'), { statusCode: 400 });

	const requester = await client.query(
		'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
		[groupId, requesterId],
	);
	if (!requester.rowCount) throw Object.assign(new Error('Only group members can add people'), { statusCode: 403 });

	const normalizedIdentifier = identifier.trim().toLowerCase();
	const targetResult = await client.query(
		'SELECT id AS "_id", fullnamae, username FROM users WHERE LOWER(username) = $1 OR LOWER(email) = $1',
		[normalizedIdentifier],
	);
	if (!targetResult.rowCount) {
		throw Object.assign(new Error('No Splitpayerly account was found with that username or email'), { statusCode: 404 });
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
	const requesterName = await client.query('SELECT fullnamae FROM users WHERE id = $1', [requesterId]);
	const targetName = targetResult.rows[0].fullnamae || targetResult.rows[0].username;
	await recordGroupActivity(client, {
		groupId,
		actorId: requesterId,
		activityType: 'MEMBER_ADDED',
		description: `Member added: ${targetName}`,
		details: `${requesterName.rows[0]?.fullnamae || 'A group member'} added ${targetName} to ${group.name}.`,
	});
	return hydrate(group, client);
});
/** Return the signed-in member's simplified amounts owed to or by group members. */
export const getGroupBalances = async (groupId, userId) => {
	await normalizeGroupBalances(groupId, userId);
	const group = await query(
		'SELECT is_friend_ledger FROM groups WHERE id = $1',
		[groupId],
	);
	if (group.rows[0]?.is_friend_ledger) {
		throw Object.assign(new Error('Use the friend history page to view this private ledger'), { statusCode: 404 });
	}
	const transfers = await simplifyDebts(groupId, userId);
	const personalTransfers = transfers.filter((transfer) => transfer.from === userId || transfer.to === userId);
	if (!personalTransfers.length) return [];

	const counterpartIds = [...new Set(personalTransfers.map((transfer) => (
		transfer.from === userId ? transfer.to : transfer.from
	)))];
	const members = await query(
		'SELECT id AS "_id", username, fullnamae, coverimage FROM users WHERE id = ANY($1::uuid[])',
		[counterpartIds],
	);
	const membersById = new Map(members.rows.map((member) => [member._id, member]));
	return personalTransfers.map((transfer) => {
		const isOwed = transfer.to === userId;
		const memberId = isOwed ? transfer.from : transfer.to;
		return {
			...membersById.get(memberId),
			currency: transfer.currency,
			netBalance: `${isOwed ? '' : '-'}${transfer.amount}`,
		};
	});
};
/** Aggregate group and direct-friend balances in the user's preferred currency. */
export const getDashboardBalanceSummary = async (userId) => {
	const userResult = await query(
		'SELECT default_currency AS "defaultCurrency" FROM users WHERE id = $1',
		[userId],
	);
	if (!userResult.rowCount) throw Object.assign(new Error('User not found'), { statusCode: 404 });
	const currency = userResult.rows[0].defaultCurrency || 'INR';
	const sharedGroups = (await listGroupsForUser(userId)).filter((group) => !group.isPersonal);
	const sharedEntries = (await Promise.all(sharedGroups.map(async (group) => {
		const balances = await getGroupBalances(group._id, userId);
		return balances.map((balance) => ({
			key: group._id,
			name: group.name,
			currency: balance.currency || 'INR',
			amount: balance.netBalance,
		}));
	}))).flat();
	const directBalances = await query(
		`SELECT g.id AS "groupId", friend.id AS "friendId",
		        COALESCE(friend.fullnamae, friend.username) AS name,
		        b.currency, b.net_owed::text AS amount,
		        (b.user1 = $1) AS "userIsLow"
		 FROM friend_ledgers f
		 JOIN groups g ON g.id = f.group_id
		 JOIN balances b ON b.group_id = g.id
		 JOIN users friend ON friend.id = CASE
		   WHEN f.user_low = $1 THEN f.user_high ELSE f.user_low END
		 WHERE (f.user_low = $1 OR f.user_high = $1)
		   AND b.net_owed <> 0 AND (b.user1 = $1 OR b.user2 = $1)`,
		[userId],
	);
	const directEntries = directBalances.rows.map((balance) => ({
		key: `direct:${balance.groupId}:${balance.friendId}`,
		name: `With ${balance.name}`,
		currency: balance.currency || 'INR',
		amount: new Decimal(balance.amount).mul(balance.userIsLow ? 1 : -1).toString(),
	}));
	const entries = [...sharedEntries, ...directEntries];
	const currencies = [...new Set(entries.map((entry) => entry.currency))];
	// Present one dashboard total by converting each underlying balance to the user's preferred currency.
	const rates = Object.fromEntries(await Promise.all(currencies.map(async (fromCurrency) => ([
		fromCurrency,
		await getExchangeRate(fromCurrency, currency),
	]))));
	const groupedBalances = new Map();
	for (const entry of entries) {
		const balance = groupedBalances.get(entry.key) || {
			id: entry.key,
			name: entry.name,
			youOwe: new Decimal(0),
			youAreOwed: new Decimal(0),
		};
		const converted = new Decimal(entry.amount).mul(rates[entry.currency] || 1);
		if (converted.isNegative()) balance.youOwe = balance.youOwe.plus(converted.abs());
		else balance.youAreOwed = balance.youAreOwed.plus(converted);
		groupedBalances.set(entry.key, balance);
	}
	const balances = [...groupedBalances.values()].map((balance) => ({
		id: balance.id,
		name: balance.name,
		youOwe: balance.youOwe.toFixed(2),
		youAreOwed: balance.youAreOwed.toFixed(2),
	}));
	const youOwe = balances.reduce((total, balance) => total.plus(balance.youOwe), new Decimal(0));
	const youAreOwed = balances.reduce((total, balance) => total.plus(balance.youAreOwed), new Decimal(0));
	/** Select the highest balances for one direction of the dashboard summary. */
	const sortByAmount = (field) => balances
		.filter((balance) => new Decimal(balance[field]).greaterThan(0))
		.sort((first, second) => new Decimal(second[field]).minus(first[field]).toNumber());
	return {
		currency,
		totalBalance: youAreOwed.minus(youOwe).toFixed(2),
		youOwe: youOwe.toFixed(2),
		youAreOwed: youAreOwed.toFixed(2),
		outgoingBalances: sortByAmount('youOwe'),
		incomingBalances: sortByAmount('youAreOwed'),
	};
};
/** Update group settings and convert existing balances atomically when currency changes. */
export const updateGroupSettings = async ({ groupId, userId, name, simplifyDebts, currency, coverImageUrl, removeCoverImage = false }) => withTransaction(async (client) => {
	const membership = await client.query(
		`SELECT g.id, g.name, g.group_code AS "groupCode", g.created_by AS "createdBy",
		        g.is_personal AS "isPersonal", g.is_friend_ledger AS "isFriendLedger", g.cover_image_url AS "coverImageUrl",
		        g.simplify_debts AS "simplifyDebts", g.currency, g.created_at AS "createdAt"
		 FROM groups g JOIN group_members gm ON gm.group_id = g.id
		 WHERE g.id = $1 AND gm.user_id = $2 FOR UPDATE OF g`,
		[groupId, userId],
	);
	if (!membership.rowCount) throw Object.assign(new Error('Group or membership not found'), { statusCode: 404 });
	const group = membership.rows[0];
	if (group.isPersonal) throw Object.assign(new Error('Personal Expenses settings cannot be changed'), { statusCode: 400 });
	if (group.isFriendLedger) throw Object.assign(new Error('This private friend ledger cannot be changed as a group'), { statusCode: 400 });
	if (currency !== undefined && currency !== group.currency) {
		if (group.createdBy !== userId) {
			throw Object.assign(new Error('Only the group creator can change its base currency'), { statusCode: 403 });
		}
		if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
			throw Object.assign(new Error('Choose a valid group currency'), { statusCode: 400 });
		}
		await normalizeGroupBalancesInTransaction(client, groupId, userId);
		const conversionRate = await getExchangeRate(group.currency, currency);
		const scaledCurrencies = new Set([group.currency]);
		const [activityRows, settlementRows, allocationRows, expenseRows, itemRows] = await Promise.all([
			client.query(
				'SELECT id, amount::text AS amount, currency FROM group_activity WHERE group_id = $1 AND amount IS NOT NULL AND currency IS NOT NULL',
				[groupId],
			),
			client.query(
				'SELECT id, amount::text AS amount, currency FROM group_settlements WHERE group_id = $1',
				[groupId],
			),
			client.query(
				'SELECT id, amount::text AS amount, currency, exchange_rate::text AS "exchangeRate" FROM friend_settlement_allocations WHERE group_id = $1',
				[groupId],
			),
			client.query(
				'SELECT id, total_amount::text AS amount FROM expenses WHERE group_id = $1 AND currency = $2',
				[groupId, group.currency],
			),
			client.query(
				`SELECT ei.id, ei.amount::text AS amount
				 FROM expense_items ei JOIN expenses e ON e.id = ei.expense_id
				 WHERE e.group_id = $1 AND e.currency = $2`,
				[groupId, group.currency],
			),
		]);
		[...activityRows.rows, ...settlementRows.rows, ...allocationRows.rows]
			.forEach((row) => scaledCurrencies.add(row.currency));
		const rates = new Map(await Promise.all([...scaledCurrencies].map(async (sourceCurrency) => [
			sourceCurrency,
			sourceCurrency === currency ? 1 : await getExchangeRate(sourceCurrency, currency),
		])));
		/** Convert a positive ledger amount while retaining cent-level precision. */
		const convertPositiveAmount = (amount, rate) => {
			const converted = new Decimal(amount).mul(rate).toDecimalPlaces(2);
			if (converted.lte(0)) {
				throw Object.assign(
					new Error('A historical payment is too small to convert safely into the selected currency'),
					{ statusCode: 409 },
				);
			}
			return converted.toFixed(2);
		};
		[...expenseRows.rows, ...itemRows.rows].forEach((row) => convertPositiveAmount(row.amount, conversionRate));

		await client.query(
			`UPDATE balances SET net_owed = ROUND(net_owed * $1::numeric, 2),
			                     currency = $2, updated_at = NOW()
			 WHERE group_id = $3 AND currency = $4`,
			[conversionRate, currency, groupId, group.currency],
		);
		await client.query(
			`UPDATE expense_splits es
			 SET amount_owed = ROUND(es.amount_owed * $2::numeric, 2),
			     split_value = CASE WHEN e.split_strategy <> ALL(ARRAY['PERCENTAGE', 'SHARES'])
			       THEN ROUND(es.split_value * $2::numeric, 2)
			       ELSE es.split_value END
			 FROM expenses e
			 WHERE es.expense_id = e.id AND e.group_id = $1`,
			[groupId, conversionRate],
		);
		await client.query(
			`UPDATE expense_items SET amount = ROUND(amount * $2::numeric, 2)
			 WHERE expense_id IN (SELECT id FROM expenses WHERE group_id = $1)`,
			[groupId, conversionRate],
		);
		await client.query(
			`UPDATE expense_item_splits eis
			 SET amount_owed = ROUND(eis.amount_owed * $2::numeric, 2)
			 FROM expense_items ei
			 JOIN expenses e ON e.id = ei.expense_id
			 WHERE eis.item_id = ei.id AND e.group_id = $1`,
			[groupId, conversionRate],
		);
		await client.query(
			`UPDATE expenses
			 SET total_amount = ROUND(total_amount * $2::numeric, 2),
			     conversion_rate = ROUND(COALESCE(conversion_rate, 1) * $2::numeric, 10),
			     currency = $3
			 WHERE group_id = $1 AND currency = $4`,
			[groupId, conversionRate, currency, group.currency],
		);
		for (const row of activityRows.rows) {
			const rate = rates.get(row.currency);
			await client.query(
				'UPDATE group_activity SET amount = ROUND(amount * $2::numeric, 2), currency = $3 WHERE id = $1',
				[row.id, rate, currency],
			);
		}
		for (const row of settlementRows.rows) {
			const rate = rates.get(row.currency);
			await client.query(
				'UPDATE group_settlements SET amount = $2, currency = $3 WHERE id = $1',
				[row.id, convertPositiveAmount(row.amount, rate), currency],
			);
		}
		for (const row of allocationRows.rows) {
			const rate = rates.get(row.currency);
			await client.query(
				`UPDATE friend_settlement_allocations
				 SET amount = $2, currency = $3, exchange_rate = $4
				 WHERE id = $1`,
				[
					row.id,
					convertPositiveAmount(row.amount, rate),
					currency,
					new Decimal(row.exchangeRate).div(rate).toDecimalPlaces(8).toFixed(8),
				],
			);
		}
	}
	const nextName = name === undefined ? group.name : name.trim();
	const nextSimplifyDebts = simplifyDebts === undefined ? group.simplifyDebts : simplifyDebts;
	const nextCoverImageUrl = coverImageUrl || (removeCoverImage ? null : group.coverImageUrl);
	const changes = [];
	if (nextName !== group.name) changes.push(`renamed the group to “${nextName}”`);
	if (currency !== undefined && currency !== group.currency) changes.push(`changed the group base currency from ${group.currency} to ${currency}`);
	if (nextSimplifyDebts !== group.simplifyDebts) {
		changes.push(`turned debt simplification ${nextSimplifyDebts ? 'on' : 'off'}`);
	}
	if (nextCoverImageUrl !== group.coverImageUrl) changes.push(nextCoverImageUrl ? 'changed the group picture' : 'removed the group picture');
	const result = await client.query(
		`UPDATE groups
		 SET name = $1, simplify_debts = $2, cover_image_url = $3, currency = $4
		 WHERE id = $5
		 RETURNING id AS "_id", name, group_code AS "groupCode",
		           created_by AS "createdBy", is_personal AS "isPersonal",
		           cover_image_url AS "coverImageUrl", simplify_debts AS "simplifyDebts",
		           currency,
		           created_at AS "createdAt"`,
		[nextName, nextSimplifyDebts, nextCoverImageUrl, currency || group.currency, groupId],
	);
	if (changes.length) {
		const actor = await client.query('SELECT fullnamae FROM users WHERE id = $1', [userId]);
		await recordGroupActivity(client, {
			groupId,
			actorId: userId,
			activityType: 'GROUP_SETTINGS_UPDATED',
			description: 'Group settings updated',
			details: `${actor.rows[0]?.fullnamae || 'A group member'} ${changes.join(' and ')}.`,
		});
	}
	return hydrate(result.rows[0], client);
});

/** Remove a group member only when permissions and unsettled-balance rules allow it. */
export const removeGroupMember = async ({ groupId, requesterId, memberId }) => withTransaction(async (client) => {
	const group = await client.query(
		'SELECT id, created_by AS "createdBy", is_personal AS "isPersonal", is_friend_ledger AS "isFriendLedger" FROM groups WHERE id = $1 FOR UPDATE',
		[groupId],
	);
	if (!group.rowCount) throw Object.assign(new Error('Group not found'), { statusCode: 404 });
	if (group.rows[0].isPersonal) throw Object.assign(new Error('Personal Expenses members cannot be removed'), { statusCode: 400 });
	if (group.rows[0].isFriendLedger) throw Object.assign(new Error('Members cannot be removed from a private friend ledger'), { statusCode: 400 });
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
	const removedMember = await client.query('SELECT fullnamae, username FROM users WHERE id = $1', [memberId]);
	const unsettled = await client.query(
		'SELECT 1 FROM balances WHERE group_id = $1 AND net_owed <> 0 AND (user1 = $2 OR user2 = $2) LIMIT 1',
		[groupId, memberId],
	);
	if (unsettled.rowCount) throw Object.assign(new Error('Settle this member’s balances before removing them'), { statusCode: 400 });
	const actor = await client.query('SELECT fullnamae FROM users WHERE id = $1', [requesterId]);
	const memberName = removedMember.rows[0].fullnamae || removedMember.rows[0].username;
	await recordGroupActivity(client, {
		groupId,
		actorId: requesterId,
		activityType: 'MEMBER_REMOVED',
		description: `Member removed: ${memberName}`,
		details: `${actor.rows[0]?.fullnamae || 'A group member'} removed ${memberName} from the group.`,
	});
	await client.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, memberId]);
	return hydrate({
		_id: groupId,
		...((await client.query(
			`SELECT name, group_code AS "groupCode", created_by AS "createdBy",
			        is_personal AS "isPersonal", cover_image_url AS "coverImageUrl",
			        simplify_debts AS "simplifyDebts", currency, created_at AS "createdAt"
			 FROM groups WHERE id = $1`,
			[groupId],
		)).rows[0]),
	}, client);
});
/** Add a user to the group identified by an invite code and record the join activity. */
export const joinGroupByCode = async ({ groupCode: code, userId }) => withTransaction(async (client) => {
	const result = await client.query(
		`SELECT id AS "_id", name, group_code AS "groupCode", created_by AS "createdBy",
		        is_personal AS "isPersonal", is_friend_ledger AS "isFriendLedger",
		        currency, created_at AS "createdAt"
		 FROM groups WHERE group_code = $1`,
		[code.trim().toUpperCase()],
	);
	if (!result.rowCount) throw Object.assign(new Error('Group code not found'), { statusCode: 404 });
	const group = result.rows[0];
	if (group.isPersonal) throw Object.assign(new Error('Personal Expenses is private to its owner'), { statusCode: 403 });
	if (group.isFriendLedger) throw Object.assign(new Error('This private friend ledger cannot be joined with a group code'), { statusCode: 403 });
	const joined = await client.query(
		'INSERT INTO group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING user_id',
		[group._id, userId],
	);
	if (joined.rowCount) {
		const actor = await client.query('SELECT fullnamae FROM users WHERE id = $1', [userId]);
		await recordGroupActivity(client, {
			groupId: group._id,
			actorId: userId,
			activityType: 'MEMBER_JOINED',
			description: `Member joined: ${actor.rows[0]?.fullnamae || 'A group member'}`,
			details: `${actor.rows[0]?.fullnamae || 'A group member'} joined ${group.name}.`,
		});
	}
	return hydrate(group, client);
});
/** Reject operations that would remove a group while members still owe balances. */
const ensureGroupIsSettled = async (client, groupId) => {
	const unsettled = await client.query(
		'SELECT 1 FROM balances WHERE group_id = $1 AND net_owed <> 0 LIMIT 1',
		[groupId],
	);
	if (unsettled.rowCount) {
		throw Object.assign(new Error('Settle all group balances before leaving or deleting this group'), { statusCode: 400 });
	}
};

/** Remove the current member from a group after checking outstanding balances. */
export const leaveGroup = async (groupId, userId) => withTransaction(async (client) => {
	const group = await client.query('SELECT id, is_personal, is_friend_ledger FROM groups WHERE id = $1 FOR UPDATE', [groupId]);
	if (!group.rowCount) throw Object.assign(new Error('Group not found'), { statusCode: 404 });
	if (group.rows[0].is_personal) throw Object.assign(new Error('Personal Expenses cannot be left'), { statusCode: 400 });
	if (group.rows[0].is_friend_ledger) throw Object.assign(new Error('A private friend ledger cannot be left'), { statusCode: 400 });

	const membership = await client.query(
		'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
		[groupId, userId],
	);
	if (!membership.rowCount) throw Object.assign(new Error('Group membership not found'), { statusCode: 404 });

	await ensureGroupIsSettled(client, groupId);
	const actor = await client.query('SELECT fullnamae FROM users WHERE id = $1', [userId]);
	await recordGroupActivity(client, {
		groupId,
		actorId: userId,
		activityType: 'MEMBER_LEFT',
		description: `Member left: ${actor.rows[0]?.fullnamae || 'A group member'}`,
		details: `${actor.rows[0]?.fullnamae || 'A group member'} left the group.`,
	});
	await client.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
	const remainingMembers = await client.query('SELECT 1 FROM group_members WHERE group_id = $1 LIMIT 1', [groupId]);
	if (!remainingMembers.rowCount) {
		await client.query('DELETE FROM groups WHERE id = $1', [groupId]);
		return { groupId, removed: true, groupDeleted: true };
	}
	return { groupId, removed: true, groupDeleted: false };
});

/** Delete a group and its data when the requester owns a settled group. */
export const deleteGroup = async (groupId, userId) => withTransaction(async (client) => {
	const group = await client.query(
		'SELECT id, is_personal, is_friend_ledger FROM groups WHERE id = $1 AND created_by = $2 FOR UPDATE',
		[groupId, userId],
	);
	if (!group.rowCount) {
		const exists = await client.query('SELECT 1 FROM groups WHERE id = $1', [groupId]);
		if (!exists.rowCount) throw Object.assign(new Error('Group not found'), { statusCode: 404 });
		throw Object.assign(new Error('Only the group creator can delete this group'), { statusCode: 403 });
	}
	if (group.rows[0].is_personal) throw Object.assign(new Error('Personal Expenses cannot be deleted'), { statusCode: 400 });
	if (group.rows[0].is_friend_ledger) throw Object.assign(new Error('A private friend ledger cannot be deleted as a group'), { statusCode: 400 });

	await ensureGroupIsSettled(client, groupId);
	await client.query('DELETE FROM groups WHERE id = $1', [groupId]);
	return { groupId, deleted: true };
});

/** Retrieve whiteboard content only for a current group member. */
export const getGroupWhiteboard = async (groupId, userId) => {
	const result = await query(
		`SELECT wb.content, wb.updated_at AS "updatedAt",
		        wb.updated_by AS "updatedBy", u.fullnamae AS "updatedByName"
		 FROM group_members gm
		 JOIN groups g ON g.id = gm.group_id AND NOT g.is_friend_ledger
		 LEFT JOIN group_whiteboards wb ON wb.group_id = gm.group_id
		 LEFT JOIN users u ON u.id = wb.updated_by
		 WHERE gm.group_id = $1 AND gm.user_id = $2`,
		[groupId, userId],
	);
	if (!result.rowCount) throw Object.assign(new Error('Group or membership not found'), { statusCode: 404 });
	return {
		content: result.rows[0].content || '',
		updatedAt: result.rows[0].updatedAt,
		updatedBy: result.rows[0].updatedBy,
		updatedByName: result.rows[0].updatedByName,
	};
};

/** Save or clear a member's group whiteboard and record the change in activity. */
export const saveGroupWhiteboard = async ({ groupId, userId, content }) => withTransaction(async (client) => {
	const membership = await client.query(
		`SELECT g.name AS "groupName", g.is_friend_ledger AS "isFriendLedger",
		        u.fullnamae AS "updatedByName"
		 FROM group_members gm
		 JOIN groups g ON g.id = gm.group_id
		 JOIN users u ON u.id = gm.user_id
		 WHERE gm.group_id = $1 AND gm.user_id = $2`,
		[groupId, userId],
	);
	if (!membership.rowCount) throw Object.assign(new Error('Group or membership not found'), { statusCode: 404 });
	if (membership.rows[0].isFriendLedger) throw Object.assign(new Error('A private friend ledger has no group whiteboard'), { statusCode: 404 });

	const result = await client.query(
		`INSERT INTO group_whiteboards (group_id, content, updated_by, updated_at)
		 VALUES ($1, $2, $3, NOW())
		 ON CONFLICT (group_id) DO UPDATE
		 SET content = EXCLUDED.content,
		     updated_by = EXCLUDED.updated_by,
		     updated_at = EXCLUDED.updated_at
		 RETURNING content, updated_at AS "updatedAt", updated_by AS "updatedBy"`,
		[groupId, content.trim(), userId],
	);
	const updatedByName = membership.rows[0].updatedByName;
	const action = content.trim() ? 'updated' : 'cleared';
	await recordGroupActivity(client, {
		groupId,
		actorId: userId,
		activityType: 'WHITEBOARD_UPDATED',
		description: `Whiteboard ${action}`,
		details: `${updatedByName || 'A group member'} ${action} the group whiteboard.`,
	});
	return { ...result.rows[0], updatedByName };
});
