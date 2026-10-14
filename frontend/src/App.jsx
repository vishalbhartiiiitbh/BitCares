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
  const [groupDetailsBusy, setGroupDetailsBusy] = useState(false);
  const [groupName, setGroupName] = useState('');
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

  const createGroup = async (event) => {
    event.preventDefault();
    const name = groupName.trim();
    if (!name) {
      setFormMessage('Group name is required');
      return;
    }
    try {
      const group = await apiRequest("/groups", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ name }),
      });
      setGroups((current) => [group, ...current]);
      setShowGroupForm(false);
      setGroupName('');
      setFormMessage(`Group created. Share code: ${group.groupCode}`);
    } catch (error) {
      setFormMessage(error.message);
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
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const group = groups.find((item) => item._id === values.groupId);
    try {
      const expense = await apiRequest("/expenses", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          groupId: values.groupId,
          paidBy: user._id,
          totalAmount: values.totalAmount,
          description: values.description,
          splitStrategy: "EQUAL",
          participants: group?.members?.map((member) => member._id) || [
            user._id,
          ],
        }),
      });
      setExpenses((current) => [expense, ...current]);
      setShowExpenseForm(false);
    } catch (error) {
      setFormMessage(error.message);
    }
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
    } catch (error) {
      setFormMessage(error.message);
    }
  };
  const openGroupDetails = async (group) => {
    setSelectedGroup(group);
    setGroupDetailsBusy(true);
    try {
      setGroupTransactions(await apiRequest(`/expenses?groupId=${group._id}`, { headers: authHeaders }));
    } catch (error) {
      setFormMessage(error.message);
    } finally {
      setGroupDetailsBusy(false);
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
                <button className="side-group" key={group._id}>
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
                onClick={() => setShowExpenseForm(true)}
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
              onClose={() => setShowGroupForm(false)}
            >
              <form onSubmit={createGroup}>
                <label>
                  Group name
                  <input name="name" value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="Lisbon weekend" required />
                </label>
                <button className="submit-button">Create group</button>
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
              onClose={() => setShowExpenseForm(false)}
            >
              <form onSubmit={addExpense}>
                <label>
                  Description
                  <input
                    name="description"
                    placeholder="Dinner at Prego"
                    required
                  />
                </label>
                <label>
                  Amount
                  <input
                    name="totalAmount"
                    type="number"
                    min="0.01"
                    step="0.01"
                    placeholder="42.50"
                    required
                  />
                </label>
                <label>
                  Group
                  <select name="groupId" required defaultValue="">
                    <option value="" disabled>
                      Select a group
                    </option>
                    {groups.map((group) => (
                      <option key={group._id} value={group._id}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="submit-button">Save expense</button>
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
              busy={groupDetailsBusy}
              onClose={() => setSelectedGroup(null)}
              onJoin={() => { setSelectedGroup(null); setShowJoinForm(true); }}
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

function GroupDetails({ group, transactions, busy, onClose, onJoin }) {
  return (
    <div className="group-details-backdrop" onMouseDown={onClose}>
      <section className="group-details" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        <div className="group-details-header">
          <div><p className="eyebrow">GROUP DETAILS</p><h2>{group.name}</h2><span>{group.members?.length || 0} members</span></div>
          <div className="join-code-card"><small>JOINING CODE</small><strong>{group.groupCode || "Not assigned"}</strong><button onClick={onJoin}>Join another group</button></div>
        </div>
        <div className="group-details-grid">
          <div><p className="eyebrow">MEMBERS</p><div className="member-list">{(group.members || []).map((member) => <div className="member-row" key={member._id}><span className="member-avatar">{(member.fullnamae || member.username).slice(0, 1).toUpperCase()}</span><div><b>{member.fullnamae || member.username}</b><small>@{member.username}</small></div></div>)}</div></div>
          <div><p className="eyebrow">TRANSACTIONS</p>{busy ? <p className="empty-state">Loading transactions…</p> : transactions.length ? <div className="transaction-list">{transactions.map((transaction) => <div className="transaction-row" key={transaction._id}><div><b>{transaction.description}</b><small>{transaction.paidByName || transaction.paidByUsername || "Member"} paid · {new Date(transaction.createdAt).toLocaleDateString()}</small></div><strong>{transaction.currency} {transaction.totalAmount}</strong></div>)}</div> : <p className="empty-state">No transactions in this group yet.</p>}</div>
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
function Modal({ title, onClose, children }) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
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
