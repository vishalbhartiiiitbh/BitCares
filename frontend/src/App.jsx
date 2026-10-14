import { useEffect, useState } from "react";

const API_URL = import.meta.env.VITE_API_URL || "/api";
const emptyForm = { username: "", email: "", fullnamae: "", password: "" };

async function apiRequest(path, options = {}) {
  const isFormData = options.body instanceof FormData;
  let response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...options,
      credentials: "include",
      headers: isFormData ? { ...options.headers } : { "Content-Type": "application/json", ...options.headers },
    });
  } catch {
    throw new Error("Cannot connect to the backend. Start the API on port 5000.");
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Something went wrong");
  return payload.data;
}

function calculateItemizedShares(items, participants) {
  const totals = new Map(participants.map((id) => [id, 0]));
  items.forEach((item) => {
    const assigned = item.participantIds.filter((id) => totals.has(id));
    if (!assigned.length) return;
    const cents = Math.round((Number(item.amount) || 0) * 100);
    const share = Math.floor(cents / assigned.length);
    let remainder = cents - share * assigned.length;
    assigned.forEach((id) => {
      totals.set(id, totals.get(id) + share + (remainder > 0 ? 1 : 0));
      if (remainder > 0) remainder -= 1;
    });
  });
  return participants.map((id) => (totals.get(id) / 100).toFixed(2));
}

function getDefaultSplitValues(strategy, participants, totalAmount) {
  const defaults = {};
  if (strategy === 'EQUAL' || strategy === 'ITEMIZED') return defaults;
  if (strategy === 'PERCENTAGE') {
    const cents = 10000;
    const share = Math.floor(cents / participants.length);
    let remainder = cents - share * participants.length;
    participants.forEach((id) => {
      defaults[id] = ((share + (remainder > 0 ? 1 : 0)) / 100).toFixed(2);
      if (remainder > 0) remainder -= 1;
    });
    return defaults;
  }
  if (strategy === 'SHARES') {
    participants.forEach((id) => { defaults[id] = '1'; });
    return defaults;
  }
  if (strategy === 'ADJUSTMENT') {
    participants.forEach((id) => { defaults[id] = '0'; });
    return defaults;
  }
  const totalCents = Math.round((Number(totalAmount) || 0) * 100);
  const share = Math.floor(totalCents / participants.length);
  let remainder = totalCents - share * participants.length;
  participants.forEach((id) => {
    defaults[id] = ((share + (remainder > 0 ? 1 : 0)) / 100).toFixed(2);
    if (remainder > 0) remainder -= 1;
  });
  return defaults;
}

const expenseSplitModes = [
  { id: 'EQUAL', label: 'Split equally' },
  { id: 'EXACT', label: 'Split by exact amounts' },
  { id: 'PERCENTAGE', label: 'Split by percentages' },
  { id: 'SHARES', label: 'Split by shares' },
  { id: 'ADJUSTMENT', label: 'Split by adjustment' },
  { id: 'REIMBURSEMENT', label: 'Split by reimbursement' },
  { id: 'ITEMIZED', label: 'Itemized expenses' },
];

function App() {
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState(emptyForm);
  const [user, setUser] = useState(null);
  const [accessToken, setAccessToken] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiRequest("/users/refresh-token", { method: "POST" })
      .then(async (data) => {
        setAccessToken(data.accessToken);
        const current = await apiRequest("/users/me", {
          headers: { Authorization: `Bearer ${data.accessToken}` },
        });
        setUser(current.user);
      })
      .catch(() => {});
  }, []);

  const updateField = (event) => {
    setForm((current) => ({
      ...current,
      [event.target.name]: event.target.value,
    }));
    setMessage("");
  };

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const body =
        mode === "register"
          ? form
          : { email: form.email, password: form.password };
      const data = await apiRequest(`/users/${mode}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setUser(data.user);
      setAccessToken(data.accessToken);
      setForm(emptyForm);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    try {
      await apiRequest("/users/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch {
      // Clear local state even if the server session has expired.
    }
    setUser(null);
    setAccessToken("");
  };

  if (user)
    return (
      <Dashboard
        user={user}
        accessToken={accessToken}
        onLogout={signOut}
        onProfileUpdated={setUser}
      />
    );

  return (
    <main className="auth-page">
      <section className="story-panel">
        <Brand />
        <div className="story-copy">
          <p className="eyebrow">Shared money, less friction</p>
          <h1>Keep the good times. Lose the awkward maths.</h1>
          <p className="lede">
            A calmer way to split dinners, trips, and everyday life with the
            people who matter.
          </p>
        </div>
        <div className="settlement-card">
          <span className="settlement-circle">
            <strong>82%</strong>
            <small>settled</small>
          </span>
          <span>
            <b>Weekend in Lisbon</b>
            <strong>Everyone is square.</strong>
            <small>Last update · just now</small>
          </span>
        </div>
        <div className="story-footer">
          <span>01</span>
          <i />
          <span>make shared spending feel simple</span>
        </div>
      </section>
      <section className="form-panel">
        <div className="form-meta">
          <span>YOUR SHARED WALLET</span>
          <span>EST. 2026</span>
        </div>
        <div className="auth-card">
          <div className="mobile-brand">
            <Brand />
          </div>
          <div className="mode-tabs" role="tablist">
            <button
              className={mode === "login" ? "selected" : ""}
              onClick={() => {
                setMode("login");
                setMessage("");
              }}
            >
              Sign in
            </button>
            <button
              className={mode === "register" ? "selected" : ""}
              onClick={() => {
                setMode("register");
                setMessage("");
              }}
            >
              Create account
            </button>
          </div>
          <p className="eyebrow">
            {mode === "login" ? "Welcome back" : "Start a group"}
          </p>
          <h2>
            {mode === "login" ? "Good to see you." : "Let’s split smarter."}
          </h2>
          <p className="form-intro">
            {mode === "login"
              ? "Pick up where your shared plans left off."
              : "Set up your account and bring your people together."}
          </p>
          <form onSubmit={submit}>
            {mode === "register" && (
              <>
                <label>
                  Full name
                  <input
                    name="fullnamae"
                    value={form.fullnamae}
                    onChange={updateField}
                    placeholder="Alex Morgan"
                    required
                  />
                </label>
                <label>
                  Username
                  <input
                    name="username"
                    value={form.username}
                    onChange={updateField}
                    placeholder="alexm"
                    minLength="3"
                    required
                  />
                </label>
              </>
            )}
            <label>
              Email
              <input
                name="email"
                type="email"
                value={form.email}
                onChange={updateField}
                placeholder="alex@example.com"
                required
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                value={form.password}
                onChange={updateField}
                placeholder="8 characters minimum"
                minLength="8"
                required
              />
            </label>
            {message && <p className="error-message">{message}</p>}
            <button className="submit-button" disabled={busy}>
              {busy
                ? "Connecting…"
                : mode === "login"
                  ? "Enter SplitCare →"
                  : "Create my account →"}
            </button>
          </form>
          <p className="legal-copy">
            By continuing, you agree to keep shared expenses kind, clear, and
            transparent.
          </p>
        </div>
      </section>
    </main>
  );
}

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">÷</span> splitcare
    </div>
  );
}

function Dashboard({ user, accessToken, onLogout, onProfileUpdated }) {
  const firstName = user.fullnamae?.split(" ")[0] || user.username;
  const [groups, setGroups] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [friends, setFriends] = useState([]);
  const [friendRequests, setFriendRequests] = useState([]);
  const [friendSort, setFriendSort] = useState('alphabetical');
  const [activePage, setActivePage] = useState('overview');
  const [friendIdentifierType, setFriendIdentifierType] = useState('username');
  const [friendIdentifier, setFriendIdentifier] = useState('');
  const [friendBusy, setFriendBusy] = useState(false);
  const [friendError, setFriendError] = useState('');
  const [showExpenseForm, setShowExpenseForm] = useState(false);
  const [showGroupForm, setShowGroupForm] = useState(false);
  const [showJoinForm, setShowJoinForm] = useState(false);
  const [showAddFriend, setShowAddFriend] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [friendToRemove, setFriendToRemove] = useState(null);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [groupTransactions, setGroupTransactions] = useState([]);
  const [groupBalances, setGroupBalances] = useState([]);
  const [groupSettlements, setGroupSettlements] = useState([]);
  const [groupDetailsError, setGroupDetailsError] = useState('');
  const [groupSettlementError, setGroupSettlementError] = useState('');
  const [groupDetailsBusy, setGroupDetailsBusy] = useState(false);
  const [groupBalancesBusy, setGroupBalancesBusy] = useState(false);
  const [settlementsBusy, setSettlementsBusy] = useState(false);
  const [groupSettingsBusy, setGroupSettingsBusy] = useState(false);
  const [groupSettingsError, setGroupSettingsError] = useState('');
  const [expenseDraft, setExpenseDraft] = useState({
    description: '',
    totalAmount: '',
    currency: 'INR',
    groupId: '',
    paidBy: user._id,
    participantIds: [user._id],
    strategy: 'EQUAL',
    splitValues: {},
    items: [],
    note: '',
    paymentProof: null,
  });
  const [expenseError, setExpenseError] = useState('');
  const [expenseBusy, setExpenseBusy] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupMemberIds, setGroupMemberIds] = useState([]);
  const [groupMemberIdentifier, setGroupMemberIdentifier] = useState('');
  const [groupError, setGroupError] = useState('');
  const [groupBusy, setGroupBusy] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [profileForm, setProfileForm] = useState({ username: user.username || '', email: user.email || '', fullnamae: user.fullnamae || '', phone: user.phone || '', currentPassword: '', newPassword: '', coverimage: null });
  const [passwordUpdateEnabled, setPasswordUpdateEnabled] = useState(false);
  const [currentPasswordVerified, setCurrentPasswordVerified] = useState(false);
  const [usernameAvailability, setUsernameAvailability] = useState({ username: '', status: 'checking' });
  const [photoPreview, setPhotoPreview] = useState('');
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [formMessage, setFormMessage] = useState("");
  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  useEffect(() => {
    if (!profileForm.coverimage) {
      setPhotoPreview('');
      return undefined;
    }
    const preview = URL.createObjectURL(profileForm.coverimage);
    setPhotoPreview(preview);
    return () => URL.revokeObjectURL(preview);
  }, [profileForm.coverimage]);

  useEffect(() => {
    const username = profileForm.username.trim().toLowerCase();
    if (!showProfile || !username || username.length > 40) return undefined;

    let active = true;
    setUsernameAvailability({ username, status: 'checking' });
    const timeout = setTimeout(() => {
      apiRequest(`/users/profile/username-availability?username=${encodeURIComponent(username)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
        .then(({ available }) => {
          if (active) setUsernameAvailability({ username, status: available ? 'available' : 'taken' });
        })
        .catch(() => {
          if (active) setUsernameAvailability({ username, status: 'error' });
        });
    }, 300);

    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [profileForm.username, showProfile, user._id, accessToken]);

  useEffect(() => {
    Promise.all([
      apiRequest("/groups", { headers: authHeaders }),
      apiRequest("/expenses", { headers: authHeaders }),
    ])
      .then(([groupData, expenseData]) => {
        setGroups(groupData || []);
        setExpenses(expenseData || []);
      })
      .catch((error) => setFormMessage(error.message));
  }, [accessToken]);

  const refreshFriendData = async () => {
    const [friendData, requestData] = await Promise.all([
      apiRequest('/friends', { headers: authHeaders }),
      apiRequest('/friends/requests', { headers: authHeaders }),
    ]);
    setFriends(friendData);
    setFriendRequests(requestData);
  };

  useEffect(() => {
    let active = true;
    const loadFriends = () => Promise.all([
      apiRequest('/friends', { headers: authHeaders }),
      apiRequest('/friends/requests', { headers: authHeaders }),
    ])
      .then(([friendData, requestData]) => {
        if (!active) return;
        setFriends(friendData);
        setFriendRequests(requestData);
      })
      .catch((error) => {
        if (active) setFormMessage(error.message);
      });

    void loadFriends();
    const interval = window.setInterval(() => void loadFriends(), 20000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [accessToken]);

  const sendFriendRequest = async (event) => {
    event.preventDefault();
    setFriendBusy(true);
    setFriendError('');
    try {
      await apiRequest('/friends/requests', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          [friendIdentifierType]: friendIdentifier.trim(),
        }),
      });
      setFriendIdentifier('');
      setShowAddFriend(false);
      setFormMessage('Friend request sent.');
    } catch (error) {
      setFriendError(error.message);
    } finally {
      setFriendBusy(false);
    }
  };

  const respondToFriendRequest = async (requestId, action) => {
    setFriendBusy(true);
    setFriendError('');
    try {
      await apiRequest(`/friends/requests/${requestId}/respond`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ action }),
      });
      await refreshFriendData();
    } catch (error) {
      setFriendError(error.message);
    } finally {
      setFriendBusy(false);
    }
  };

  const removeFriend = async () => {
    if (!friendToRemove) return;
    setFriendBusy(true);
    setFriendError('');
    try {
      const result = await apiRequest(`/friends/${friendToRemove._id}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      await refreshFriendData();
      setFriendToRemove(null);
      setFormMessage(result.message);
    } catch (error) {
      setFriendError(error.message);
    } finally {
      setFriendBusy(false);
    }
  };

  const closeGroupForm = () => {
    setShowGroupForm(false);
    setGroupName('');
    setGroupMemberIds([]);
    setGroupMemberIdentifier('');
    setGroupError('');
  };

  const createGroup = async (event) => {
    event.preventDefault();
    const name = groupName.trim();
    if (!name) {
      setGroupError('Group name is required');
      return;
    }
    setGroupBusy(true);
    setGroupError('');
    try {
      const group = await apiRequest("/groups", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          name,
          memberIds: groupMemberIds,
          memberIdentifiers: groupMemberIdentifier.trim() ? [groupMemberIdentifier.trim()] : [],
        }),
      });
      setGroups((current) => [group, ...current]);
      setShowGroupForm(false);
      setGroupName('');
      setGroupMemberIds([]);
      setGroupMemberIdentifier('');
      setGroupError('');
      setFormMessage(`Group created. Share code: ${group.groupCode}`);
    } catch (error) {
      setGroupError(error.message);
    } finally {
      setGroupBusy(false);
    }
  };

  const joinGroup = async (event) => {
    event.preventDefault();
    const groupCode = joinCode.trim().toUpperCase();
    if (!groupCode) {
      setFormMessage('Group code is required');
      return;
    }
    try {
      const group = await apiRequest("/groups/join", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ groupCode }),
      });
      setGroups((current) => [
        group,
        ...current.filter((item) => item._id !== group._id),
      ]);
      setShowJoinForm(false);
      setJoinCode('');
      setFormMessage(`Joined ${group.name}.`);
    } catch (error) {
      setFormMessage(error.message);
    }
  };

  const addExpense = async (event) => {
    event.preventDefault();
    const group = groups.find((item) => item._id === expenseDraft.groupId);
    const participants = expenseDraft.participantIds;
    if (!participants.length) {
      setExpenseError('Select at least one person to split this expense with.');
      return;
    }
    if (expenseDraft.strategy === 'ITEMIZED' && expenseDraft.items.some((item) =>
      !item.description.trim() || !(Number(item.amount) > 0) || !item.participantIds.some((id) => participants.includes(id)))) {
      setExpenseError('Each item needs a description, a positive amount, and at least one selected person.');
      return;
    }
    const splitValues = expenseDraft.strategy === 'ITEMIZED'
      ? calculateItemizedShares(expenseDraft.items, participants)
      : participants.map((id) => {
        if (expenseDraft.strategy === 'EQUAL') return null;
        return expenseDraft.splitValues[id] ?? getDefaultSplitValues(expenseDraft.strategy, participants, expenseDraft.totalAmount)[id];
      });
    const amount = expenseDraft.strategy === 'ITEMIZED'
      ? (expenseDraft.items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0)).toFixed(2)
      : expenseDraft.totalAmount;
    if (['EXACT', 'REIMBURSEMENT'].includes(expenseDraft.strategy)
      && Math.abs(splitValues.reduce((sum, value) => sum + Number(value), 0) - Number(amount)) > 0.001) {
      setExpenseError('The split amounts must add up to the expense total.');
      return;
    }
    if (expenseDraft.strategy === 'PERCENTAGE'
      && Math.abs(splitValues.reduce((sum, value) => sum + Number(value), 0) - 100) > 0.001) {
      setExpenseError('The percentages must add up to 100%.');
      return;
    }
    if (expenseDraft.strategy === 'ADJUSTMENT'
      && Math.abs(splitValues.reduce((sum, value) => sum + Number(value), 0)) > 0.001) {
      setExpenseError('Adjustments must balance to zero.');
      return;
    }
    if (expenseDraft.strategy === 'SHARES' && splitValues.some((value) => !(Number(value) > 0))) {
      setExpenseError('Each person must have at least one share.');
      return;
    }
    const body = new FormData();
    body.set('groupId', expenseDraft.groupId);
    body.set('paidBy', expenseDraft.paidBy);
    body.set('totalAmount', amount);
    body.set('description', expenseDraft.description);
    body.set('currency', expenseDraft.currency);
    body.set('splitStrategy', expenseDraft.strategy);
    body.set('type', expenseDraft.strategy === 'REIMBURSEMENT' ? 'REIMBURSEMENT' : 'EXPENSE');
    body.set('participants', JSON.stringify(participants));
    if (expenseDraft.strategy !== 'EQUAL') body.set('values', JSON.stringify(splitValues));
    if (expenseDraft.strategy === 'ITEMIZED') {
      body.set('items', JSON.stringify(expenseDraft.items.map(({ description, amount: itemAmount, participantIds }) => ({
        description,
        amount: itemAmount,
        participantIds: participantIds.filter((id) => participants.includes(id)),
      }))));
    }
    if (expenseDraft.note.trim()) body.set('note', expenseDraft.note.trim());
    if (expenseDraft.paymentProof) body.set('paymentProof', expenseDraft.paymentProof);
    setExpenseBusy(true);
    setExpenseError('');
    try {
      const expense = await apiRequest('/expenses', {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body,
      });
      setExpenses((current) => [expense, ...current]);
      setShowExpenseForm(false);
      if (selectedGroup?._id === expenseDraft.groupId) {
        await openGroupDetails({ ...selectedGroup, ...group });
      }
    } catch (error) {
      setExpenseError(error.message);
    } finally {
      setExpenseBusy(false);
    }
  };

  const openExpenseForm = (groupId = '') => {
    const group = groups.find((item) => item._id === groupId);
    const participantIds = group?.members?.map((member) => member._id) || [user._id];
    setExpenseDraft({
      description: '',
      totalAmount: '',
      currency: 'INR',
      groupId,
      paidBy: user._id,
      participantIds,
      strategy: 'EQUAL',
      splitValues: {},
      items: [],
      note: '',
      paymentProof: null,
    });
    setExpenseError('');
    setShowExpenseForm(true);
  };

  const updateExpenseDraft = (key, value) => setExpenseDraft((current) => ({ ...current, [key]: value }));
  const changeExpenseGroup = (groupId) => {
    const group = groups.find((item) => item._id === groupId);
    const participantIds = group?.members?.map((member) => member._id) || [user._id];
    setExpenseDraft((current) => ({
      ...current,
      groupId,
      paidBy: participantIds.includes(current.paidBy) ? current.paidBy : user._id,
      participantIds,
      splitValues: {},
      items: current.items.map((item) => ({ ...item, participantIds: item.participantIds.filter((id) => participantIds.includes(id)) })),
    }));
  };

  const simplifyGroup = async (groupId) => {
    try {
      const transactions = await apiRequest(
        `/groups/${groupId}/simplify-debts`,
        { headers: authHeaders },
      );
      setFormMessage(
        transactions.length
          ? `${transactions.length} settlement${transactions.length === 1 ? "" : "s"} suggested.`
          : "This group is already settled.",
      );
    } catch (error) {
      setFormMessage(error.message);
    }
  };
  const leaveGroup = async (groupId) => {
    try {
      await apiRequest(`/groups/${groupId}/leave`, {
        method: "POST",
        headers: authHeaders,
      });
      setGroups((current) => current.filter((group) => group._id !== groupId));
      return true;
    } catch (error) {
      setFormMessage(error.message);
      return false;
    }
  };
  const openGroupDetails = async (group) => {
    setSelectedGroup(group);
    setGroupDetailsBusy(true);
    setGroupBalancesBusy(true);
    setGroupSettlements([]);
    setGroupDetailsError('');
    try {
      const [transactions, balances] = await Promise.all([
        apiRequest(`/expenses?groupId=${group._id}`, { headers: authHeaders }),
        apiRequest(`/groups/${group._id}/balances`, { headers: authHeaders }),
      ]);
      setGroupTransactions(transactions);
      setGroupBalances(balances);
    } catch (error) {
      setGroupDetailsError(error.message);
      setFormMessage(error.message);
    } finally {
      setGroupDetailsBusy(false);
      setGroupBalancesBusy(false);
    }
  };
  const loadGroupSettlements = async (groupId) => {
    setSettlementsBusy(true);
    setGroupSettlementError('');
    try {
      setGroupSettlements(await apiRequest(`/groups/${groupId}/simplify-debts`, { headers: authHeaders }));
    } catch (error) {
      setGroupSettlementError(error.message);
    } finally {
      setSettlementsBusy(false);
    }
  };
  const renameGroup = async (groupId, name) => {
    setGroupSettingsBusy(true);
    setGroupSettingsError('');
    try {
      const updatedGroup = await apiRequest(`/groups/${groupId}`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ name }),
      });
      setGroups((current) => current.map((group) => group._id === groupId ? { ...group, ...updatedGroup } : group));
      setSelectedGroup((current) => current?._id === groupId ? { ...current, ...updatedGroup } : current);
    } catch (error) {
      setGroupSettingsError(error.message);
    } finally {
      setGroupSettingsBusy(false);
    }
  };
  const updateProfileField = (event) => setProfileForm((current) => ({ ...current, [event.target.name]: event.target.type === 'file' ? event.target.files[0] : event.target.value }));
  const verifyProfilePassword = async () => {
    setProfileBusy(true);
    setProfileError('');
    try {
      await apiRequest('/users/profile/verify-password', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ currentPassword: profileForm.currentPassword }),
      });
      setCurrentPasswordVerified(true);
    } catch (error) {
      setProfileError(error.message);
    } finally {
      setProfileBusy(false);
    }
  };
  const updateProfile = async (event) => {
    event.preventDefault();
    const username = profileForm.username.trim().toLowerCase();
    if (username !== user.username.toLowerCase() && usernameAvailability.status !== 'available') {
      setProfileError(usernameAvailability.status === 'taken'
        ? 'That username is already taken. Please choose a different one.'
        : usernameAvailability.status === 'error'
          ? 'Could not check username availability. Please try again.'
          : 'Please wait for the username availability check to finish.');
      return;
    }
    if (passwordUpdateEnabled && !currentPasswordVerified) {
      setProfileError('Verify your current password before setting a new one.');
      return;
    }
    setProfileBusy(true);
    setProfileError('');
    const body = new FormData();
    ['username', 'email', 'fullnamae', 'phone'].forEach((key) => body.append(key, profileForm[key]));
    if (profileForm.coverimage) body.append('coverimage', profileForm.coverimage);
    if (passwordUpdateEnabled) {
      body.append('currentPassword', profileForm.currentPassword);
      body.append('newPassword', profileForm.newPassword);
    }
    try {
      const result = await apiRequest(`/users/profile/${user._id}`, { method: 'PUT', headers: authHeaders, body });
      onProfileUpdated(result.user);
      setProfileForm({ username: result.user.username || '', email: result.user.email || '', fullnamae: result.user.fullnamae || '', phone: result.user.phone || '', currentPassword: '', newPassword: '', coverimage: null });
      setPasswordUpdateEnabled(false);
      setCurrentPasswordVerified(false);
      setShowProfile(false);
      setFormMessage(result.cleanupWarning || 'Profile updated successfully.');
    } catch (error) {
      if (error.message.includes('username is already taken')) {
        setUsernameAvailability({ username, status: 'taken' });
      } else {
        setFormMessage(error.message);
        setProfileError(error.message);
      }
    } finally {
      setProfileBusy(false);
    }
  };
  const sortedFriends = [...friends].sort((first, second) => friendSort === 'alphabetical'
    ? (first.fullnamae || first.username).localeCompare(second.fullnamae || second.username, undefined, { sensitivity: 'base' })
    : new Date(second.addedAt) - new Date(first.addedAt));
  const pendingFriendRequests = friendRequests.filter((request) => request.status === 'pending');
  const expenseGroup = groups.find((group) => group._id === expenseDraft.groupId);
  const expenseMembers = expenseGroup?.members || [user];
  const selectedExpenseMembers = expenseMembers.filter((member) => expenseDraft.participantIds.includes(member._id));
  const itemizedTotal = expenseDraft.items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const expenseSplitDefaults = getDefaultSplitValues(expenseDraft.strategy, expenseDraft.participantIds, expenseDraft.totalAmount);
  const splitModeTotal = selectedExpenseMembers.reduce((sum, member) => sum + (
    Number(expenseDraft.splitValues[member._id] ?? expenseSplitDefaults[member._id]) || 0
  ), 0);

  return (
    <main className="dashboard-page">
      <nav className="dashboard-nav">
        <Brand />
        <div className="nav-links">
          <button className={activePage === 'overview' ? 'active' : ''} type="button" onClick={() => setActivePage('overview')}>Overview</button>
          <button className={activePage === 'friends' ? 'active' : ''} type="button" onClick={() => setActivePage('friends')}>Friends</button>
        </div>
        <div className="notification-control">
          <button
            className="notification-trigger"
            type="button"
            aria-label={`Notifications, ${pendingFriendRequests.length} pending friend requests`}
            aria-expanded={showNotifications}
            onClick={() => setShowNotifications((shown) => !shown)}
          >
            <span aria-hidden="true">♧</span>
            {pendingFriendRequests.length > 0 && <span className="notification-count">{pendingFriendRequests.length}</span>}
          </button>
          {showNotifications && (
            <div className="notification-panel">
              <div className="notification-panel-heading">
                <strong>Notifications</strong>
                <button type="button" onClick={() => setShowNotifications(false)} aria-label="Close notifications">×</button>
              </div>
              {friendRequests.length ? friendRequests.map((request) => (
                <div className="notification-item" key={request._id}>
                  <div className="notification-copy">
                    <strong>{request.senderName || request.senderUsername}</strong>
                    <span>{request.status === 'pending' ? 'sent you a friend request' : `Friend request ${request.status}`}</span>
                    <small>{new Date(request.createdAt).toLocaleDateString()}</small>
                  </div>
                  {request.status === 'pending' && (
                    <div className="notification-actions">
                      <button type="button" disabled={friendBusy} onClick={() => respondToFriendRequest(request._id, 'accept')}>Accept</button>
                      <button type="button" disabled={friendBusy} onClick={() => respondToFriendRequest(request._id, 'decline')}>Decline</button>
                    </div>
                  )}
                </div>
              )) : <p className="notification-empty">No notifications yet.</p>}
              {friendError && <p className="error-message notification-error">{friendError}</p>}
            </div>
          )}
        </div>
        <div className="profile-control">
          <button
            className="profile-trigger"
            onClick={() => setShowProfileMenu((current) => !current)}
            aria-expanded={showProfileMenu}
            aria-label="Open profile menu"
          >
            {user.coverimage
              ? <img className="avatar profile-avatar-image" src={user.coverimage} alt="" />
              : <span className="avatar">{firstName.slice(0, 1)}</span>}
            <span>{firstName}</span>
            <small>⌄</small>
          </button>
          {showProfileMenu && (
            <div className="profile-menu">
              <div className="profile-summary">
                {user.coverimage
                  ? <img className="profile-menu-avatar" src={user.coverimage} alt="" />
                  : <span className="profile-menu-avatar profile-menu-avatar-fallback">{firstName.slice(0, 1)}</span>}
                <strong>{user.fullnamae || user.username}</strong>
                <span>{user.email}</span>
              </div>
              <button
                onClick={() => {
                  setProfileForm({ username: user.username || '', email: user.email || '', fullnamae: user.fullnamae || '', phone: user.phone || '', currentPassword: '', newPassword: '', coverimage: null });
                  setPasswordUpdateEnabled(false);
                  setCurrentPasswordVerified(false);
                  setProfileError('');
                  setUsernameAvailability({ username: user.username.toLowerCase(), status: 'checking' });
                  setShowProfile(true);
                  setShowProfileMenu(false);
                }}
              >
                Edit profile
              </button>
              <button className="logout-menu-button" onClick={onLogout}>
                Log out
              </button>
            </div>
          )}
        </div>
      </nav>
      <div className={`dashboard-shell ${activePage === 'friends' ? 'friend-management-shell' : ''}`}>
        <aside className="dashboard-sidebar">
          <div className="side-links">
            <button className="side-link active">
              ▣ <span>Dashboard</span>
            </button>
            <button className="side-link">
              ⚑ <span>Recent activity</span>
            </button>
            <button className="side-link">
              ☷ <span>All expenses</span>
            </button>
          </div>
          <div className="side-section">
            <div className="side-heading">
              <span>GROUPS</span>
              <span className="side-heading-actions">
                <button onClick={() => setShowGroupForm(true)}>+ add</button>
                <button onClick={() => setShowJoinForm(true)}>join</button>
              </span>
            </div>
            {groups.length ? (
              groups.map((group) => (
                <button className="side-group" key={group._id} type="button" onClick={() => openGroupDetails(group)}>
                  <span className="mini-group-icon">
                    {group.name.slice(0, 1).toUpperCase()}
                  </span>
                  {group.name}
                </button>
              ))
            ) : (
              <p className="side-empty">No groups yet</p>
            )}
          </div>
          <div className="side-section">
            <div className="side-heading">
              <span>FRIENDS</span>
              <button type="button" onClick={() => { setFriendError(''); setShowAddFriend(true); }}>+ add</button>
            </div>
            <label className="friend-sort-control">
              <span>Sort friends</span>
              <select value={friendSort} onChange={(event) => setFriendSort(event.target.value)}>
                <option value="alphabetical">Alphabetical</option>
                <option value="recent">Recently added</option>
              </select>
            </label>
            {sortedFriends.map((friend) => (
              <div className="side-friend" key={friend._id}>
                {friend.coverimage
                  ? <img src={friend.coverimage} alt="" />
                  : <span className="side-friend-avatar">{(friend.fullnamae || friend.username).slice(0, 1).toUpperCase()}</span>}
                <span className="side-friend-name">{friend.fullnamae || friend.username}</span>
                <button
                  className="remove-friend-button"
                  type="button"
                  aria-label={`Remove ${friend.fullnamae || friend.username} as a friend`}
                  title="Remove friend"
                  onClick={() => { setFriendError(''); setFriendToRemove(friend); }}
                >
                  ×
                </button>
              </div>
            ))}
            {!friends.length && (
              <p className="side-empty">Your friends appear here</p>
            )}
          </div>
          <button className="friend-add-card" type="button" onClick={() => { setFriendError(''); setShowAddFriend(true); }}>Add friend by username or email</button>
        </aside>
        <section className="dashboard-content">
          {activePage === 'friends' ? (
            <div className="friend-management-page">
              <div className="friend-management-heading">
                <div>
                  <p className="eyebrow">YOUR PEOPLE</p>
                  <h1>Friends</h1>
                  <p>Manage your friends, requests, and connections.</p>
                </div>
                <button className="primary-action" type="button" onClick={() => { setFriendError(''); setShowAddFriend(true); }}>+ Add a friend</button>
              </div>

              {formMessage && <p className="friend-page-message">{formMessage}</p>}
              {friendError && <p className="error-message">{friendError}</p>}

              <div className="friend-management-toolbar">
                <span>{friends.length} {friends.length === 1 ? 'friend' : 'friends'}</span>
                <label className="friend-sort-control">
                  <span>Sort friends</span>
                  <select value={friendSort} onChange={(event) => setFriendSort(event.target.value)}>
                    <option value="alphabetical">Alphabetical</option>
                    <option value="recent">Recently added</option>
                  </select>
                </label>
              </div>

              {sortedFriends.length ? (
                <div className="friend-profile-grid">
                  {sortedFriends.map((friend) => (
                    <article className="friend-profile-card" key={friend._id}>
                      <div className="friend-profile-main">
                        {friend.coverimage
                          ? <img className="friend-profile-photo" src={friend.coverimage} alt={`${friend.fullnamae || friend.username}'s profile`} />
                          : <span className="friend-profile-photo friend-profile-photo-fallback">{(friend.fullnamae || friend.username).slice(0, 1).toUpperCase()}</span>}
                        <div className="friend-profile-identity">
                          <h2>{friend.fullnamae || friend.username}</h2>
                          <span>@{friend.username}</span>
                        </div>
                      </div>
                      <div className="friend-profile-details">
                        <span>Email</span>
                        <strong>{friend.email}</strong>
                        <span>Friends since</span>
                        <strong>{new Date(friend.addedAt).toLocaleDateString()}</strong>
                      </div>
                      <button
                        className="friend-profile-remove"
                        type="button"
                        onClick={() => { setFriendError(''); setFriendToRemove(friend); }}
                      >
                        Remove friend
                      </button>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="friends-empty-state">
                  <span>♟</span>
                  <h2>Your friend list is empty</h2>
                  <p>Add a friend by their SplitCare username or registered email. They’ll appear here after accepting.</p>
                  <button className="primary-action" type="button" onClick={() => { setFriendError(''); setShowAddFriend(true); }}>Add your first friend</button>
                </div>
              )}

              <section className="friend-requests-section">
                <div className="friend-requests-heading">
                  <div>
                    <p className="eyebrow">CONNECTIONS</p>
                    <h2>Friend request history</h2>
                  </div>
                  <span>{pendingFriendRequests.length} pending</span>
                </div>
                {friendRequests.length ? (
                  <div className="friend-request-list">
                    {friendRequests.map((request) => (
                      <article className="friend-request-row" key={request._id}>
                        {request.senderPhoto
                          ? <img src={request.senderPhoto} alt="" />
                          : <span className="friend-request-avatar">{(request.senderName || request.senderUsername).slice(0, 1).toUpperCase()}</span>}
                        <div>
                          <strong>{request.senderName || request.senderUsername}</strong>
                          <span>@{request.senderUsername} · {new Date(request.createdAt).toLocaleDateString()}</span>
                        </div>
                        {request.status === 'pending'
                          ? <div className="friend-request-actions">
                              <button type="button" disabled={friendBusy} onClick={() => respondToFriendRequest(request._id, 'accept')}>Accept</button>
                              <button type="button" disabled={friendBusy} onClick={() => respondToFriendRequest(request._id, 'decline')}>Decline</button>
                            </div>
                          : <span className={`friend-request-status ${request.status}`}>{request.status}</span>}
                      </article>
                    ))}
                  </div>
                ) : <p className="friends-request-empty">No friend requests yet.</p>}
              </section>
            </div>
          ) : (
          <>
          <div className="welcome-row">
            <div>
              <p className="eyebrow">Tuesday, September 23</p>
              <h1>Dashboard</h1>
              <p className="lede">See what you owe and what’s owed to you.</p>
            </div>
            <div className="action-row">
              <button
                className="quiet-button"
                onClick={() => setShowGroupForm(true)}
              >
                + New group
              </button>
              <button
                className="quiet-button"
                onClick={() => setShowJoinForm(true)}
              >
                Join with code
              </button>
              <button
                className="primary-action"
                onClick={() => openExpenseForm('')}
              >
                Add an expense
              </button>
            </div>
          </div>
          {formMessage && (
            <p className="error-message dashboard-message">{formMessage}</p>
          )}
          <div className="stat-grid">
            <Stat
              label="TRACKED EXPENSES"
              value={expenses.length.toString().padStart(2, "0")}
              note="from your connected account"
              highlight
            />
            <Stat
              label="ACTIVE GROUPS"
              value={groups.length.toString().padStart(2, "0")}
              note="shared spaces"
            />
            <Stat
              label="FRIENDS"
              value={friends.length.toString().padStart(2, "0")}
              note="accepted connections"
            />
          </div>
          <div className="balance-strip">
            <Stat
              label="TOTAL BALANCE"
              value="₹0.00"
              note="all groups"
              highlight
            />
            <Stat label="YOU OWE" value="₹0.00" note="across your groups" />
            <Stat
              label="YOU ARE OWED"
              value="₹0.00"
              note="across your groups"
            />
          </div>
          <div className="balance-columns">
            <Panel title="You owe" eyebrow="OUTGOING BALANCES">
              {groups.length ? (
                groups
                  .slice(0, 3)
                  .map((group) => (
                    <BalanceRow
                      key={group._id}
                      name={group.name}
                      amount="₹0.00"
                      tone="coral"
                    />
                  ))
              ) : (
                <p className="empty-state">You don’t owe anyone yet.</p>
              )}
            </Panel>
            <Panel title="You are owed" eyebrow="INCOMING BALANCES">
              {groups.length ? (
                groups
                  .slice(0, 3)
                  .map((group) => (
                    <BalanceRow
                      key={group._id}
                      name={group.name}
                      amount="₹0.00"
                      tone="mint"
                    />
                  ))
              ) : (
                <p className="empty-state">Nobody owes you yet.</p>
              )}
            </Panel>
          </div>
          <div className="content-grid">
            <Panel title="Active groups" eyebrow="Your spaces">
              {groups.length ? (
                groups.map((group) => (
                  <Group
                    key={group._id}
                    initials={group.name.slice(0, 2).toUpperCase()}
                    name={group.name}
                    groupCode={group.groupCode}
                    amount={`${group.members?.length || 0} members`}
                    note="connected"
                    tone="coral"
                    onSimplify={() => simplifyGroup(group._id)}
                    onLeave={() => leaveGroup(group._id)}
                    onOpen={() => openGroupDetails(group)}
                  />
                ))
              ) : (
                <p className="empty-state">
                  No groups yet. Create your first shared space.
                </p>
              )}
            </Panel>
            <Panel title="Recent activity" eyebrow="THE PAPER TRAIL">
              {expenses.length ? (
                expenses
                  .slice(0, 4)
                  .map((expense) => (
                    <Activity
                      key={expense._id}
                      title={expense.description}
                      detail={`${expense.currency} · ${new Date(expense.createdAt).toLocaleDateString()}`}
                      amount={`${expense.currency} ${expense.totalAmount}`}
                    />
                  ))
              ) : (
                <p className="empty-state">
                  Expenses you add will appear here.
                </p>
              )}
            </Panel>
          </div>
          </>
          )}
          {showGroupForm && (
            <Modal
              title="Create a group"
              onClose={closeGroupForm}
            >
              <form onSubmit={createGroup}>
                <label>
                  Group name
                  <input name="name" value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="Lisbon weekend" required />
                </label>
                <fieldset className="group-member-picker">
                  <legend>Add friends</legend>
                  {friends.length ? friends.map((friend) => (
                    <label className="group-friend-option" key={friend._id}>
                      <input
                        type="checkbox"
                        checked={groupMemberIds.includes(friend._id)}
                        onChange={(event) => {
                          setGroupMemberIds((current) => event.target.checked
                            ? [...current, friend._id]
                            : current.filter((id) => id !== friend._id));
                        }}
                      />
                      <span>
                        <strong>{friend.fullnamae || friend.username}</strong>
                        <small>@{friend.username}</small>
                      </span>
                    </label>
                  )) : <p className="group-member-empty">You can add friends here after connecting with them.</p>}
                </fieldset>
                <label>
                  Add by username or email
                  <input
                    type="text"
                    value={groupMemberIdentifier}
                    onChange={(event) => setGroupMemberIdentifier(event.target.value)}
                    placeholder="username or friend@example.com"
                    autoComplete="off"
                  />
                </label>
                <p className="modal-help group-member-help">The person must have a SplitCare account. You’ll be added to the group automatically.</p>
                {groupError && <p className="error-message">{groupError}</p>}
                <button className="submit-button" disabled={groupBusy}>{groupBusy ? 'Creating…' : 'Create group'}</button>
              </form>
            </Modal>
          )}
          {showJoinForm && (
            <Modal title="Join a group" onClose={() => setShowJoinForm(false)}>
              <p className="modal-help">Enter the group code shared by the group owner.</p>
              <form onSubmit={joinGroup}>
                <label>
                  Group code
                  <input name="groupCode" value={joinCode} onChange={(event) => setJoinCode(event.target.value.toUpperCase())} placeholder="A1B2C3D4" maxLength="8" autoCapitalize="characters" required />
                </label>
                <button className="submit-button">Join group</button>
              </form>
            </Modal>
          )}
          {showAddFriend && (
            <Modal title="Add a friend" onClose={() => setShowAddFriend(false)}>
              <p className="modal-help">Send a request using their username or the email address they registered with on SplitCare. They will appear in your friends list after accepting.</p>
              <form onSubmit={sendFriendRequest}>
                <label>
                  Find by
                  <select value={friendIdentifierType} onChange={(event) => setFriendIdentifierType(event.target.value)}>
                    <option value="username">Username</option>
                    <option value="email">Email address</option>
                  </select>
                </label>
                <label>
                  {friendIdentifierType === 'email' ? 'Email address' : 'Username'}
                  <input
                    type={friendIdentifierType === 'email' ? 'email' : 'text'}
                    value={friendIdentifier}
                    onChange={(event) => setFriendIdentifier(event.target.value)}
                    placeholder={friendIdentifierType === 'email' ? 'Friend’s registered email' : '@username'}
                    required
                  />
                </label>
                {friendError && <p className="error-message">{friendError}</p>}
                <button className="submit-button" disabled={friendBusy}>{friendBusy ? 'Sending…' : 'Send friend request'}</button>
              </form>
            </Modal>
          )}
          {friendToRemove && (
            <Modal title="Remove friend?" onClose={() => {
              if (!friendBusy) {
                setFriendError('');
                setFriendToRemove(null);
              }
            }}>
              <p className="modal-help">
                Remove <strong>{friendToRemove.fullnamae || friendToRemove.username}</strong> from your friends? You will both be removed from each other’s friend lists. You can send a new friend request later.
              </p>
              {friendError && <p className="error-message">{friendError}</p>}
              <div className="remove-friend-actions">
                <button type="button" className="cancel-friend-removal" disabled={friendBusy} onClick={() => {
                  setFriendError('');
                  setFriendToRemove(null);
                }}>Keep friend</button>
                <button type="button" className="confirm-friend-removal" disabled={friendBusy} onClick={removeFriend}>
                  {friendBusy ? 'Removing…' : 'Remove friend'}
                </button>
              </div>
            </Modal>
          )}
          {showExpenseForm && (
            <Modal
              title="Add an expense"
              className={selectedGroup ? 'group-expense-modal' : ''}
              onClose={() => setShowExpenseForm(false)}
            >
              <form className="expense-entry-form" onSubmit={addExpense}>
                <div className="expense-description-row">
                  <label>Description<input value={expenseDraft.description} onChange={(event) => updateExpenseDraft('description', event.target.value)} placeholder="Dinner at Prego" maxLength="500" required /></label>
                  <label>Amount<input value={expenseDraft.strategy === 'ITEMIZED' ? itemizedTotal.toFixed(2) : expenseDraft.totalAmount} onChange={(event) => updateExpenseDraft('totalAmount', event.target.value)} type="number" min="0.01" step="0.01" placeholder="0.00" readOnly={expenseDraft.strategy === 'ITEMIZED'} required /></label>
                  <label>Currency
                    <select value={expenseDraft.currency} onChange={(event) => updateExpenseDraft('currency', event.target.value)}>
                      <option value="INR">INR ₹</option><option value="USD">USD $</option><option value="EUR">EUR €</option>
                      <option value="GBP">GBP £</option><option value="CAD">CAD $</option><option value="AUD">AUD $</option>
                    </select>
                  </label>
                </div>

                <label>Group
                  <select value={expenseDraft.groupId} onChange={(event) => changeExpenseGroup(event.target.value)}>
                    <option value="">Personal expense</option>
                    {groups.map((group) => <option key={group._id} value={group._id}>{group.name}</option>)}
                  </select>
                </label>

                <label>Who paid?
                  <select value={expenseDraft.paidBy} onChange={(event) => updateExpenseDraft('paidBy', event.target.value)}>
                    {expenseMembers.map((member) => <option key={member._id} value={member._id}>{member._id === user._id ? 'You' : member.fullnamae || member.username}</option>)}
                  </select>
                </label>

                <fieldset className="expense-participants">
                  <legend>Who is included in this expense?</legend>
                  <div className="expense-participant-list">
                    {expenseMembers.map((member) => (
                      <label key={member._id}>
                        <input
                          type="checkbox"
                          checked={expenseDraft.participantIds.includes(member._id)}
                          onChange={(event) => setExpenseDraft((current) => {
                            const participantIds = event.target.checked
                              ? [...current.participantIds, member._id]
                              : current.participantIds.filter((id) => id !== member._id);
                            return {
                              ...current,
                              participantIds,
                              splitValues: { ...current.splitValues, [member._id]: undefined },
                              items: current.items.map((item) => ({
                                ...item,
                                participantIds: event.target.checked
                                  ? item.participantIds
                                  : item.participantIds.filter((id) => id !== member._id),
                              })),
                            };
                          })}
                        />
                        <span>{member._id === user._id ? 'You' : member.fullnamae || member.username}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>

                <fieldset className="expense-split-picker">
                  <legend>How should the expense be split?</legend>
                  <div className="expense-split-tabs">
                    {expenseSplitModes.map((mode) => (
                      <button
                        key={mode.id}
                        type="button"
                        className={expenseDraft.strategy === mode.id ? 'selected' : ''}
                        onClick={() => setExpenseDraft((current) => ({
                          ...current,
                          strategy: mode.id,
                          splitValues: {},
                        }))}
                      >{mode.label}</button>
                    ))}
                  </div>
                  <div className="expense-split-editor">
                    <h3>{expenseSplitModes.find((mode) => mode.id === expenseDraft.strategy)?.label}</h3>
                    {expenseDraft.strategy === 'EQUAL' && <p>The total will be divided evenly between the selected people.</p>}
                    {['EXACT', 'PERCENTAGE', 'SHARES', 'ADJUSTMENT', 'REIMBURSEMENT'].includes(expenseDraft.strategy) && (
                      <>
                        {selectedExpenseMembers.map((member) => (
                          <label className="expense-split-value" key={member._id}>
                            <span>{member._id === user._id ? 'You' : member.fullnamae || member.username}</span>
                            <input
                              type="number"
                              min={expenseDraft.strategy === 'ADJUSTMENT' ? undefined : '0'}
                              step="0.01"
                              value={expenseDraft.splitValues[member._id] ?? expenseSplitDefaults[member._id] ?? ''}
                              onChange={(event) => setExpenseDraft((current) => ({ ...current, splitValues: { ...current.splitValues, [member._id]: event.target.value } }))}
                              placeholder={expenseDraft.strategy === 'ADJUSTMENT' ? '+/- amount' : '0'}
                              required
                            />
                            <small>{expenseDraft.strategy === 'PERCENTAGE' ? '%' : expenseDraft.strategy === 'SHARES' ? 'share(s)' : expenseDraft.strategy === 'ADJUSTMENT' ? 'adjustment' : expenseDraft.currency}</small>
                          </label>
                        ))}
                        <div className="expense-split-total">
                          <span>{expenseDraft.strategy === 'PERCENTAGE' ? 'PERCENT TOTAL' : expenseDraft.strategy === 'ADJUSTMENT' ? 'ADJUSTMENT TOTAL' : expenseDraft.strategy === 'SHARES' ? 'SHARES TOTAL' : 'AMOUNT TOTAL'}</span>
                          <strong>{splitModeTotal.toFixed(2)}{expenseDraft.strategy === 'PERCENTAGE' ? '%' : expenseDraft.strategy === 'SHARES' ? ' shares' : ` ${expenseDraft.currency}`}</strong>
                          {(expenseDraft.strategy === 'EXACT' || expenseDraft.strategy === 'REIMBURSEMENT') && <small>{(Number(expenseDraft.totalAmount) - splitModeTotal).toFixed(2)} remaining</small>}
                        </div>
                      </>
                    )}
                    {expenseDraft.strategy === 'ITEMIZED' && (
                      <div className="expense-itemized-editor">
                        {expenseDraft.items.map((item) => (
                          <article key={item.id}>
                            <div className="expense-item-fields">
                              <input aria-label="Item description" value={item.description} onChange={(event) => setExpenseDraft((current) => ({ ...current, items: current.items.map((candidate) => candidate.id === item.id ? { ...candidate, description: event.target.value } : candidate) }))} placeholder="Item name" required />
                              <input aria-label="Item amount" type="number" min="0.01" step="0.01" value={item.amount} onChange={(event) => setExpenseDraft((current) => ({ ...current, items: current.items.map((candidate) => candidate.id === item.id ? { ...candidate, amount: event.target.value } : candidate) }))} placeholder="0.00" required />
                              <button type="button" onClick={() => setExpenseDraft((current) => ({ ...current, items: current.items.filter((candidate) => candidate.id !== item.id) }))} aria-label="Remove item">×</button>
                            </div>
                            <div className="expense-item-participants">
                              {selectedExpenseMembers.map((member) => (
                                <label key={member._id}><input type="checkbox" checked={item.participantIds.includes(member._id)} onChange={(event) => setExpenseDraft((current) => ({ ...current, items: current.items.map((candidate) => candidate.id === item.id ? { ...candidate, participantIds: event.target.checked ? [...candidate.participantIds, member._id] : candidate.participantIds.filter((id) => id !== member._id) } : candidate) }))} />{member._id === user._id ? 'You' : member.username}</label>
                              ))}
                            </div>
                          </article>
                        ))}
                        <button type="button" className="expense-add-item" onClick={() => setExpenseDraft((current) => ({ ...current, items: [...current.items, { id: `${Date.now()}-${Math.random()}`, description: '', amount: '', participantIds: current.participantIds }] }))}>＋ Add item</button>
                      </div>
                    )}
                  </div>
                </fieldset>

                {expenseDraft.strategy === 'REIMBURSEMENT' && <p className="modal-help">Enter how much each selected person should reimburse; amounts must add up to the total.</p>}
                <div className="expense-proof-fields">
                  <label>Payment proof (optional)<input type="file" accept="image/*" onChange={(event) => updateExpenseDraft('paymentProof', event.target.files?.[0] || null)} /></label>
                  {expenseDraft.paymentProof && <small>{expenseDraft.paymentProof.name}</small>}
                  <label>Note (optional)<textarea value={expenseDraft.note} onChange={(event) => updateExpenseDraft('note', event.target.value)} rows="3" placeholder="Add a note about this expense" /></label>
                </div>
                {expenseError && <p className="error-message" role="alert">{expenseError}</p>}
                <div className="expense-form-actions">
                  <button type="button" className="quiet-button" onClick={() => setShowExpenseForm(false)}>Cancel</button>
                  <button className="submit-button" disabled={expenseBusy || !selectedExpenseMembers.length || (expenseDraft.strategy === 'ITEMIZED' && !expenseDraft.items.length)}>{expenseBusy ? 'Saving…' : 'Save expense'}</button>
                </div>
              </form>
            </Modal>
          )}
          {showProfile && (
            <Modal title="Your profile" onClose={() => setShowProfile(false)}>
              <form onSubmit={updateProfile} className="profile-edit-form">
                <div className="profile-editor-summary">
                  {photoPreview || user.coverimage
                    ? <img className="profile-editor-avatar" src={photoPreview || user.coverimage} alt="Profile" />
                    : <span className="profile-editor-avatar profile-editor-avatar-fallback">{firstName.slice(0, 1)}</span>}
                  <div>
                    <strong>{user.fullnamae || user.username}</strong>
                    <span>@{user.username}</span>
                  </div>
                </div>
                <label className="profile-photo-picker">Profile photo<input name="coverimage" type="file" accept="image/*" onChange={updateProfileField} /></label>
                <label>Username<input name="username" value={profileForm.username} onChange={updateProfileField} maxLength="40" required /></label>
                {profileForm.username.trim() && (
                  <p className={`username-status ${usernameAvailability.status}`} role="status" aria-live="polite">
                    {usernameAvailability.username !== profileForm.username.trim().toLowerCase() || usernameAvailability.status === 'checking'
                      ? 'Checking username…'
                      : usernameAvailability.status === 'available'
                        ? 'Username is available.'
                        : usernameAvailability.status === 'taken'
                          ? 'That username is already taken. Please choose a different one.'
                          : usernameAvailability.status === 'error'
                            ? 'Could not check username availability. Please try again.'
                            : 'Enter a username of 1 to 40 characters.'}
                  </p>
                )}
                <label>Email<input name="email" type="email" value={profileForm.email} onChange={updateProfileField} required /></label>
                <label>Full name<input name="fullnamae" value={profileForm.fullnamae} onChange={updateProfileField} required /></label>
                <label>Phone<input name="phone" value={profileForm.phone} onChange={updateProfileField} placeholder="Optional" /></label>
                <button className="password-update-toggle" type="button" aria-expanded={passwordUpdateEnabled} onClick={() => {
                  setPasswordUpdateEnabled((enabled) => !enabled);
                  setProfileForm((current) => ({ ...current, currentPassword: '', newPassword: '' }));
                  setCurrentPasswordVerified(false);
                  setProfileError('');
                }}>
                  {passwordUpdateEnabled ? 'Cancel password update' : 'Update password'}
                </button>
                {passwordUpdateEnabled && (
                  <div className="password-update-fields">
                    <label>Current password<input name="currentPassword" type="password" value={profileForm.currentPassword} onChange={updateProfileField} autoComplete="current-password" disabled={currentPasswordVerified} required /></label>
                    {currentPasswordVerified
                      ? <>
                          <p className="password-verified-message">Current password verified.</p>
                          <label>New password<input name="newPassword" type="password" value={profileForm.newPassword} onChange={updateProfileField} minLength="8" autoComplete="new-password" required /></label>
                        </>
                      : <button className="verify-password-button" type="button" onClick={verifyProfilePassword} disabled={profileBusy || !profileForm.currentPassword}>
                          {profileBusy ? 'Verifying…' : 'Verify current password'}
                        </button>}
                  </div>
                )}
                {profileError && <p className="error-message">{profileError}</p>}
                <button className="submit-button" disabled={profileBusy}>{profileBusy ? 'Saving…' : 'Save profile'}</button>
              </form>
              <button className="submit-button profile-logout" onClick={onLogout}>Log out</button>
            </Modal>
          )}
          {selectedGroup && (
            <GroupDetails
              group={selectedGroup}
              transactions={groupTransactions}
              transactionsBusy={groupDetailsBusy}
              balances={groupBalances}
              balancesBusy={groupBalancesBusy}
              settlements={groupSettlements}
              detailsError={groupDetailsError}
              settlementError={groupSettlementError}
              settlementsBusy={settlementsBusy}
              settingsBusy={groupSettingsBusy}
              settingsError={groupSettingsError}
              user={user}
              onClose={() => setSelectedGroup(null)}
              onJoin={() => { setSelectedGroup(null); setShowJoinForm(true); }}
              onAddExpense={() => openExpenseForm(selectedGroup._id)}
              onSettle={() => loadGroupSettlements(selectedGroup._id)}
              onRename={(name) => renameGroup(selectedGroup._id, name)}
              onLeave={async () => {
                if (await leaveGroup(selectedGroup._id)) setSelectedGroup(null);
              }}
            />
          )}
        </section>
        {activePage !== 'friends' && <aside className="dashboard-right-rail">
          <p className="eyebrow">SPLITCARE PLUS</p>
          <div className="plus-mark">✦</div>
          <h2>Make every split feel effortless.</h2>
          <p>
            Invite your people, settle faster, and keep every shared expense in
            one calm place.
          </p>
          <button onClick={() => setShowGroupForm(true)}>Create a group</button>
          <button onClick={() => setShowJoinForm(true)}>Join with code</button>
        </aside>}
      </div>
    </main>
  );
}

function Stat({ label, value, note, highlight }) {
  return (
    <article className={`stat-card ${highlight ? "highlight" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  );
}
function Panel({ eyebrow, title, children }) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2>{title}</h2>
        </div>
      </div>
      {children}
    </section>
  );
}
function Group({ initials, name, amount, note, tone, groupCode, onSimplify, onLeave, onOpen }) {
  return (
    <div className="group-row group-row-clickable" onClick={onOpen} role="button" tabIndex="0" onKeyDown={(event) => { if (event.key === "Enter") onOpen(); }}>
      <span className={`group-icon ${tone}`}>{initials}</span>
      <div>
        <b>{name}</b>
          <small>code: {groupCode || "not assigned"}</small>
      </div>
      <div className="group-amount">
        <b>{amount}</b>
        <small>{note}</small>
      </div>
      <div className="group-actions">
        <button onClick={(event) => { event.stopPropagation(); onSimplify(); }}>Settle</button>
        <button onClick={(event) => { event.stopPropagation(); onLeave(); }}>Leave</button>
      </div>
    </div>
  );
}

function GroupDetails({
  group,
  transactions,
  transactionsBusy,
  balances,
  balancesBusy,
  settlements,
  detailsError,
  settlementError,
  settlementsBusy,
  settingsBusy,
  settingsError,
  user,
  onClose,
  onJoin,
  onAddExpense,
  onSettle,
  onRename,
  onLeave,
}) {
  const [activeTab, setActiveTab] = useState('activity');
  const [hideUninvolved, setHideUninvolved] = useState(false);
  const [nameDraft, setNameDraft] = useState(group.name);
  const isOwner = group.createdBy === user._id;
  const visibleTransactions = hideUninvolved
    ? transactions.filter((transaction) => transaction.paidBy === user._id || transaction.participantIds?.includes(user._id))
    : transactions;
  const memberName = (id) => {
    const member = group.members?.find((item) => item._id === id);
    return member?.fullnamae || member?.username || 'Group member';
  };
  const exportTransactions = () => {
    const rows = [
      ['Date', 'Description', 'Paid by', 'Amount', 'Currency'],
      ...transactions.map((transaction) => [
        new Date(transaction.createdAt).toLocaleDateString(),
        transaction.description,
        transaction.paidByName || transaction.paidByUsername || 'Member',
        transaction.totalAmount,
        transaction.currency,
      ]),
    ];
    const csv = rows.map((row) => row.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${group.name.replace(/[^a-z0-9-_]+/gi, '-')}-expenses.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  useEffect(() => setNameDraft(group.name), [group._id, group.name]);

  return (
    <div className="group-details-backdrop" onMouseDown={onClose}>
      <section className="group-details group-workspace" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        <header className="group-workspace-header">
          <div className="group-workspace-identity">
            <span className="group-workspace-avatar">{group.name.slice(0, 1).toUpperCase()}</span>
            <div>
              <p className="eyebrow">GROUP</p>
              <h2>{group.name}</h2>
              <span>{group.members?.length || 0} {(group.members?.length || 0) === 1 ? 'person' : 'people'}</span>
            </div>
          </div>
          <div className="group-workspace-actions">
            <button className="group-add-expense" onClick={onAddExpense}>＋ Add an expense</button>
            <button className="group-settle-button" onClick={() => { setActiveTab('balances'); onSettle(); }}>Settle up</button>
          </div>
          <div className="group-id-card">
            <span>GROUP ID</span><strong>{group.groupCode || 'Not assigned'}</strong>
            <small>ID: {group._id}</small>
            <button onClick={onJoin}>Join another group</button>
          </div>
        </header>

        <nav className="group-workspace-tabs" aria-label="Group sections">
          <button className={activeTab === 'activity' ? 'active' : ''} onClick={() => setActiveTab('activity')}>☷ Activity</button>
          <button className={activeTab === 'balances' ? 'active' : ''} onClick={() => setActiveTab('balances')}>◉ Balances</button>
          <button className={activeTab === 'settings' ? 'active' : ''} onClick={() => setActiveTab('settings')}>⚙ Settings</button>
        </nav>

        {detailsError && <p className="error-message group-detail-error" role="alert">{detailsError}</p>}

        <div className="group-workspace-body">
          <main className="group-workspace-content">
            {activeTab === 'activity' && (
              <section>
                <div className="group-section-heading">
                  <div><p className="eyebrow">THE PAPER TRAIL</p><h3>Group activity</h3></div>
                  <span>{transactions.length} expenses</span>
                </div>
                {transactionsBusy ? <p className="empty-state">Loading group activity…</p> : visibleTransactions.length ? (
                  <div className="transaction-list">
                    {visibleTransactions.map((transaction) => (
                      <article className="transaction-row" key={transaction._id}>
                        <span className="transaction-icon">▤</span>
                        <div><b>{transaction.description}</b><small>{transaction.paidByName || transaction.paidByUsername || 'Member'} paid · {new Date(transaction.createdAt).toLocaleDateString()}</small>{transaction.note && <small>{transaction.note}</small>}{transaction.items?.map((item, itemIndex) => <small key={`${transaction._id}-${itemIndex}`}>{item.description}: {transaction.currency} {item.amount}</small>)}{transaction.paymentProofUrl && <a className="expense-proof-link" href={transaction.paymentProofUrl} target="_blank" rel="noreferrer">View payment proof</a>}</div>
                        <strong>{transaction.currency} {transaction.totalAmount}</strong>
                      </article>
                    ))}
                  </div>
                ) : <p className="empty-state">{hideUninvolved ? 'No group expenses involving you.' : 'No expenses in this group yet. Add the first one to get started.'}</p>}
              </section>
            )}
            {activeTab === 'balances' && (
              <section>
                <div className="group-section-heading">
                  <div><p className="eyebrow">WHO OWES WHOM</p><h3>Group balances</h3></div>
                  <button className="group-inline-action" onClick={onSettle} disabled={settlementsBusy}>{settlementsBusy ? 'Calculating…' : 'Refresh settle-up plan'}</button>
                </div>
                {balancesBusy ? <p className="empty-state">Loading group balances…</p> : balances.length ? (
                  <div className="group-balances-list">
                    {balances.map((balance) => {
                      const amount = Number(balance.netBalance);
                      const label = Math.abs(amount) < 0.005 ? 'settled up' : amount > 0 ? 'gets back' : 'owes';
                      return (
                        <article className="group-balance-row" key={`${balance._id}-${balance.currency || 'INR'}`}>
                          <span className={`member-avatar ${amount > 0 ? 'mint' : amount < 0 ? 'coral-bg' : ''}`}>{(balance.fullnamae || balance.username).slice(0, 1).toUpperCase()}</span>
                          <div><strong>{balance.fullnamae || balance.username}</strong><small>@{balance.username}</small></div>
                          <p className={amount > 0 ? 'balance-positive' : amount < 0 ? 'balance-negative' : ''}>{label}{Math.abs(amount) >= 0.005 && <> <b>{balance.currency || 'INR'} {Math.abs(amount).toFixed(2)}</b></>}</p>
                        </article>
                      );
                    })}
                  </div>
                ) : <p className="empty-state">No group balances to show.</p>}
                <div className="settlement-plan">
                  <h4>Suggested settlements</h4>
                  {settlementsBusy ? <p>Finding the simplest way to settle…</p> : settlements.length ? settlements.map((settlement, index) => (
                    <div className="settlement-plan-row" key={`${settlement.from}-${settlement.to}-${settlement.currency}-${index}`}>
                      <span><strong>{memberName(settlement.from)}</strong> pays <strong>{memberName(settlement.to)}</strong></span>
                      <b>{settlement.currency} {Number(settlement.amount).toFixed(2)}</b>
                    </div>
                  )) : settlementError ? <p className="error-message">{settlementError}</p> : <p>Choose “Settle up” to calculate suggested payments, or this group may already be settled.</p>}
                </div>
              </section>
            )}
            {activeTab === 'settings' && (
              <section className="group-settings-panel">
                <div className="group-section-heading"><div><p className="eyebrow">GROUP SETTINGS</p><h3>Manage this group</h3></div></div>
                {isOwner ? (
                  <form onSubmit={(event) => { event.preventDefault(); onRename(nameDraft.trim()); }}>
                    <label>Group name<input value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} maxLength="120" required /></label>
                    {settingsError && <p className="error-message">{settingsError}</p>}
                    <button className="group-setting-button" disabled={settingsBusy || nameDraft.trim() === group.name}>{settingsBusy ? 'Saving…' : 'Save group name'}</button>
                  </form>
                ) : <p className="modal-help">Only {memberName(group.createdBy)} can change this group’s name.</p>}
                <label className="group-hide-toggle"><input type="checkbox" checked={hideUninvolved} onChange={(event) => setHideUninvolved(event.target.checked)} /> Hide expenses I’m not involved in</label>
                <button className="group-setting-button" onClick={exportTransactions}>Export expenses as CSV</button>
                <button className="group-setting-button group-leave-button" onClick={() => {
                  if (window.confirm('Leave this group? You cannot leave while you have unsettled balances.')) onLeave();
                }}>Leave group</button>
              </section>
            )}
          </main>

          <aside className="group-workspace-sidebar">
            <div className="group-sidebar-heading"><span>◉</span><h3>Group balances</h3></div>
            {balancesBusy ? <p className="empty-state">Loading…</p> : balances.map((balance) => {
              const amount = Number(balance.netBalance);
              if (Math.abs(amount) < 0.005) return null;
              return (
                <div className="group-sidebar-balance" key={`${balance._id}-${balance.currency || 'INR'}`}>
                  <span className={`member-avatar ${amount > 0 ? 'mint' : 'coral-bg'}`}>{(balance.fullnamae || balance.username).slice(0, 1).toUpperCase()}</span>
                  <div><strong>{balance.fullnamae || balance.username}</strong><small className={amount > 0 ? 'balance-positive' : 'balance-negative'}>{amount > 0 ? 'gets back' : 'owes'} {balance.currency || 'INR'} {Math.abs(amount).toFixed(2)}</small></div>
                </div>
              );
            })}
            {!balancesBusy && !balances.some((balance) => Math.abs(Number(balance.netBalance)) >= 0.005) && <p className="empty-state">Everyone is settled up.</p>}
            <button className="group-view-balances" onClick={() => setActiveTab('balances')}>View details →</button>
            <div className="group-sidebar-members">
              <h3>People in this group</h3>
              {(group.members || []).map((member) => (
                <div className="group-sidebar-member" key={member._id}>
                  <span className="member-avatar">{(member.fullnamae || member.username).slice(0, 1).toUpperCase()}</span>
                  <span>{member.fullnamae || member.username}</span>
                </div>
              ))}
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}
function Activity({ title, detail, amount }) {
  return (
    <div className="activity-row">
      <span className="activity-dot" />
      <div>
        <b>{title}</b>
        <small>{detail}</small>
      </div>
      <b>{amount}</b>
    </div>
  );
}
function BalanceRow({ name, amount, tone }) {
  return (
    <div className="balance-row">
      <span className={`balance-avatar ${tone}`}>
        {name.slice(0, 1).toUpperCase()}
      </span>
      <div>
        <b>{name}</b>
        <small>settled balance</small>
      </div>
      <strong>{amount}</strong>
    </div>
  );
}
function Modal({ title, onClose, children, className = '' }) {
  return (
    <div className={`modal-backdrop ${className}`} onMouseDown={onClose}>
      <section
        className="modal"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="modal-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <p className="eyebrow">SplitCare</p>
        <h2>{title}</h2>
        {children}
      </section>
    </div>
  );
}

export default App;
