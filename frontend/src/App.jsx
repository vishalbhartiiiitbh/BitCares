import { useEffect, useState } from "react";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";
const emptyForm = { username: "", email: "", fullnamae: "", password: "" };

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });
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
      <Dashboard user={user} accessToken={accessToken} onLogout={signOut} />
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

function Dashboard({ user, accessToken, onLogout }) {
  const firstName = user.fullnamae?.split(" ")[0] || user.username;
  const [groups, setGroups] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [showExpenseForm, setShowExpenseForm] = useState(false);
  const [showGroupForm, setShowGroupForm] = useState(false);
  const [showJoinForm, setShowJoinForm] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [formMessage, setFormMessage] = useState("");
  const authHeaders = { Authorization: `Bearer ${accessToken}` };

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

  const createGroup = async (event) => {
    event.preventDefault();
    try {
      const group = await apiRequest("/groups", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          name: new FormData(event.currentTarget).get("name"),
        }),
      });
      setGroups((current) => [group, ...current]);
      setShowGroupForm(false);
    } catch (error) {
      setFormMessage(error.message);
    }
  };

  const joinGroup = async (event) => {
    event.preventDefault();
    try {
      const groupCode = new FormData(event.currentTarget).get("groupCode");
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
  const friends = [
    ...new Map(
      groups
        .flatMap((group) => group.members || [])
        .map((member) => [member._id, member]),
    ).values(),
  ];

  return (
    <main className="dashboard-page">
      <nav className="dashboard-nav">
        <Brand />
        <div className="nav-links">
          <span className="active">Overview</span>
          <span>Groups</span>
          <span>Activity</span>
        </div>
        <div className="profile-control">
          <button
            className="profile-trigger"
            onClick={() => setShowProfileMenu((current) => !current)}
            aria-expanded={showProfileMenu}
            aria-label="Open profile menu"
          >
            <span className="avatar">{firstName.slice(0, 1)}</span>
            <span>{firstName}</span>
            <small>⌄</small>
          </button>
          {showProfileMenu && (
            <div className="profile-menu">
              <div className="profile-summary">
                <strong>{user.fullnamae || user.username}</strong>
                <span>{user.email}</span>
              </div>
              <button
                onClick={() => {
                  setShowProfile(true);
                  setShowProfileMenu(false);
                }}
              >
                Profile
              </button>
              <button className="logout-menu-button" onClick={onLogout}>
                Log out
              </button>
            </div>
          )}
        </div>
      </nav>
      <div className="dashboard-shell">
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
              <button>+ add</button>
            </div>
            {friends.slice(0, 5).map((member) => (
              <span className="side-friend" key={member._id}>
                ♟ {member.fullnamae || member.username}
              </span>
            ))}
            {!friends.length && (
              <p className="side-empty">Your friends appear here</p>
            )}
          </div>
          <div className="invite-card">
            <strong>Invite friends</strong>
            <input placeholder="Enter an email address" />
            <button>Send invite</button>
          </div>
        </aside>
        <section className="dashboard-content">
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
              label="MEMBERS"
              value={friends.length.toString().padStart(2, "0")}
              note="across your groups"
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
          {showGroupForm && (
            <Modal
              title="Create a group"
              onClose={() => setShowGroupForm(false)}
            >
              <form onSubmit={createGroup}>
                <label>
                  Group name
                  <input name="name" placeholder="Lisbon weekend" required />
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
                  <input name="groupCode" placeholder="A1B2C3D4" maxLength="8" autoCapitalize="characters" required />
                </label>
                <button className="submit-button">Join group</button>
              </form>
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
              <div className="profile-details">
                <div>
                  <span>FULL NAME</span>
                  <strong>{user.fullnamae || "Not provided"}</strong>
                </div>
                <div>
                  <span>USERNAME</span>
                  <strong>@{user.username}</strong>
                </div>
                <div>
                  <span>EMAIL</span>
                  <strong>{user.email}</strong>
                </div>
                <div>
                  <span>MEMBER SINCE</span>
                  <strong>
                    {new Date(user.createdAt).toLocaleDateString()}
                  </strong>
                </div>
              </div>
              <button
                className="submit-button profile-logout"
                onClick={onLogout}
              >
                Log out
              </button>
            </Modal>
          )}
        </section>
        <aside className="dashboard-right-rail">
          <p className="eyebrow">SPLITCARE PLUS</p>
          <div className="plus-mark">✦</div>
          <h2>Make every split feel effortless.</h2>
          <p>
            Invite your people, settle faster, and keep every shared expense in
            one calm place.
          </p>
          <button onClick={() => setShowGroupForm(true)}>Create a group</button>
          <button onClick={() => setShowJoinForm(true)}>Join with code</button>
        </aside>
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
function Group({ initials, name, amount, note, tone, groupCode, onSimplify, onLeave }) {
  return (
    <div className="group-row">
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
        <button onClick={onSimplify}>Settle</button>
        <button onClick={onLeave}>Leave</button>
      </div>
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
