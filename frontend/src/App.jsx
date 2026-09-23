import { useEffect, useState } from 'react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';
const emptyForm = { username: '', email: '', fullnamae: '', password: '' };

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong');
  return data.data;
}

function App() {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState(emptyForm);
  const [user, setUser] = useState(null);
  const [accessToken, setAccessToken] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiRequest('/users/refresh-token', { method: 'POST' })
      .then((data) => setAccessToken(data.accessToken))
      .catch(() => {});
  }, []);

  const updateField = (event) => {
    setForm((current) => ({ ...current, [event.target.name]: event.target.value }));
    setMessage('');
  };

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const body = mode === 'register' ? form : { email: form.email, password: form.password };
      const data = await apiRequest(`/users/${mode}`, { method: 'POST', body: JSON.stringify(body) });
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
      await apiRequest('/users/logout', { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } });
    } catch {
      // Local state is cleared even when the server session already expired.
    }
    setUser(null);
    setAccessToken('');
  };

  if (user) return <Dashboard user={user} onLogout={signOut} />;

  return (
    <main className="auth-page">
      <section className="story-panel">
        <Brand />
        <div className="story-copy">
          <p className="eyebrow">Shared money, less friction</p>
          <h1>Keep the good times. Lose the awkward maths.</h1>
          <p className="lede">A calmer way to split dinners, trips, and everyday life with the people who matter.</p>
        </div>
        <div className="settlement-card">
          <span className="settlement-circle"><strong>82%</strong><small>settled</small></span>
          <span><b>Weekend in Lisbon</b><strong>Everyone is square.</strong><small>Last update · just now</small></span>
        </div>
        <div className="story-footer"><span>01</span><i /><span>make shared spending feel simple</span></div>
      </section>

      <section className="form-panel">
        <div className="form-meta"><span>YOUR SHARED WALLET</span><span>EST. 2026</span></div>
        <div className="auth-card">
          <div className="mobile-brand"><Brand /></div>
          <div className="mode-tabs" role="tablist">
            <button className={mode === 'login' ? 'selected' : ''} onClick={() => { setMode('login'); setMessage(''); }}>Sign in</button>
            <button className={mode === 'register' ? 'selected' : ''} onClick={() => { setMode('register'); setMessage(''); }}>Create account</button>
          </div>
          <p className="eyebrow">{mode === 'login' ? 'Welcome back' : 'Start a group'}</p>
          <h2>{mode === 'login' ? 'Good to see you.' : 'Let’s split smarter.'}</h2>
          <p className="form-intro">{mode === 'login' ? 'Pick up where your shared plans left off.' : 'Set up your account and bring your people together.'}</p>
          <form onSubmit={submit}>
            {mode === 'register' && <>
              <label>Full name<input name="fullnamae" value={form.fullnamae} onChange={updateField} placeholder="Alex Morgan" required /></label>
              <label>Username<input name="username" value={form.username} onChange={updateField} placeholder="alexm" minLength="3" required /></label>
            </>}
            <label>Email<input name="email" type="email" value={form.email} onChange={updateField} placeholder="alex@example.com" required /></label>
            <label>Password<input name="password" type="password" value={form.password} onChange={updateField} placeholder="8 characters minimum" minLength="8" required /></label>
            {message && <p className="error-message">{message}</p>}
            <button className="submit-button" disabled={busy}>{busy ? 'Connecting…' : mode === 'login' ? 'Enter SplitCare →' : 'Create my account →'}</button>
          </form>
          <p className="legal-copy">By continuing, you agree to keep shared expenses kind, clear, and transparent.</p>
        </div>
      </section>
    </main>
  );
}

function Brand() {
  return <div className="brand"><span className="brand-mark">÷</span> splitcare</div>;
}

function Dashboard({ user, onLogout }) {
  const firstName = user.fullnamae?.split(' ')[0] || user.username;
  return (
    <main className="dashboard-page">
      <nav className="dashboard-nav"><Brand /><div className="nav-links"><span className="active">Overview</span><span>Groups</span><span>Activity</span></div><button className="avatar" onClick={onLogout} title="Sign out">{firstName?.slice(0, 1) || 'U'}</button></nav>
      <section className="dashboard-content">
        <div className="welcome-row"><div><p className="eyebrow">Tuesday, September 23</p><h1>Good morning, {firstName}.</h1><p className="lede">Here’s the shape of your shared spending.</p></div><button className="primary-action">+ Add expense</button></div>
        <div className="stat-grid"><Stat label="YOU ARE OWED" value="$248.60" note="across 3 groups ↑ 12%" highlight /><Stat label="YOU OWE" value="$86.40" note="across 2 groups" /><Stat label="ACTIVE GROUPS" value="04" note="Lisbon is your latest" /></div>
        <div className="content-grid"><Panel title="Active groups" eyebrow="Your spaces" action="View all →"><Group initials="LP" name="Lisbon weekend" amount="$124.30" note="owed to you" tone="coral" /><Group initials="TH" name="The household" amount="-$48.00" note="you owe" tone="sage" /><Group initials="BD" name="Birthday fund" amount="$72.30" note="owed to you" tone="yellow" /></Panel><Panel title="Recent activity" eyebrow="The paper trail"><Activity title="Maya paid you" detail="Dinner at Prego · today" amount="$42.50" /><Activity title="You added an expense" detail="Household supplies · today" amount="$18.00" /><Activity title="Sam settled up" detail="Lisbon weekend · today" amount="$30.00" /></Panel></div>
      </section>
    </main>
  );
}

function Stat({ label, value, note, highlight }) { return <article className={`stat-card ${highlight ? 'highlight' : ''}`}><span>{label}</span><strong>{value}</strong><small>{note}</small></article>; }
function Panel({ eyebrow, title, action, children }) { return <section className="panel"><div className="panel-heading"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div>{action && <button className="quiet-button">{action}</button>}</div>{children}</section>; }
function Group({ initials, name, amount, note, tone }) { return <div className="group-row"><span className={`group-icon ${tone}`}>{initials}</span><div><b>{name}</b><small>3 members · updated today</small></div><div className="group-amount"><b className={note === 'you owe' ? 'negative' : ''}>{amount}</b><small>{note}</small></div></div>; }
function Activity({ title, detail, amount }) { return <div className="activity-row"><span className="activity-dot" /><div><b>{title}</b><small>{detail}</small></div><b>{amount}</b></div>; }

export default App;
