import { useEffect, useRef, useState } from "react";

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

function groupExpensesByMonth(expenses) {
  const months = new Map();
  expenses.forEach((expense) => {
    const date = new Date(expense.createdAt);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    if (!months.has(key)) {
      months.set(key, {
        key,
        label: date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
        expenses: [],
      });
    }
    months.get(key).expenses.push(expense);
  });
  return [...months.values()].sort((first, second) => second.key.localeCompare(first.key));
}

function getExpenseMonthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function SpendingInsights({ transactions, members }) {
  const [monthSelection, setMonthSelection] = useState('');
  const [currencySelection, setCurrencySelection] = useState('');
  const [hoveredMonth, setHoveredMonth] = useState('');
  const [selectedMonth, setSelectedMonth] = useState('');
  const [hoveredDay, setHoveredDay] = useState(null);
  const [selectedDay, setSelectedDay] = useState(null);
  const expenses = transactions.filter((transaction) => (
    transaction.type === 'EXPENSE' && Number(transaction.totalAmount) > 0
  ));
  const monthKeys = [...new Set(expenses.map((expense) => getExpenseMonthKey(new Date(expense.createdAt))))]
    .sort((first, second) => first.localeCompare(second));
  const activeMonth = monthKeys.includes(monthSelection) ? monthSelection : monthKeys.at(-1) || '';
  const monthOptions = monthKeys.map((key) => {
    const [year, month] = key.split('-').map(Number);
    return {
      key,
      label: new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
    };
  });
  const monthExpenses = expenses.filter((expense) => getExpenseMonthKey(new Date(expense.createdAt)) === activeMonth);
  const currencies = [...new Set(monthExpenses.map((expense) => expense.currency || 'INR'))].sort();
  const activeCurrency = currencies.includes(currencySelection) ? currencySelection : currencies[0] || 'INR';
  const selectedExpenses = monthExpenses.filter((expense) => (expense.currency || 'INR') === activeCurrency);
  const memberById = new Map();
  members.forEach((member) => memberById.set(member._id, member.fullnamae || member.username));
  expenses.forEach((expense) => {
    expense.splits?.forEach((split) => {
      if (split.userId && !memberById.has(split.userId)) {
        memberById.set(split.userId, `Former member ${split.userId.slice(0, 6)}`);
      }
    });
  });
  const payers = [...memberById.entries()].map(([id, name]) => ({ id, name }));
  const colors = ['#568bd8', '#b66ada', '#4e56b5', '#e5ab3f', '#4eaa89', '#e36f67', '#5b9cae', '#8f9f43'];
  const colorById = new Map(payers.map((payer, index) => [payer.id, colors[index % colors.length]]));
  const addExpenseShares = (totals, expense) => {
    expense.splits?.forEach((split) => {
      const memberId = split.userId;
      const amount = Number(split.amountOwed);
      if (!memberId || !Number.isFinite(amount) || amount <= 0) return;
      totals.set(memberId, (totals.get(memberId) || 0) + amount);
    });
  };
  const paidTotals = new Map();
  selectedExpenses.forEach((expense) => {
    if (!expense.paidBy) return;
    paidTotals.set(
      expense.paidBy,
      (paidTotals.get(expense.paidBy) || 0) + (Number(expense.totalAmount) || 0),
    );
  });
  const paidData = payers
    .map((payer) => ({ ...payer, amount: paidTotals.get(payer.id) || 0 }))
    .filter((payer) => payer.amount > 0);
  const paidTotal = paidData.reduce((total, payer) => total + payer.amount, 0);
  const shareTotals = new Map();
  const dailyTotals = new Map();
  selectedExpenses.forEach((expense) => {
    addExpenseShares(shareTotals, expense);
    const day = new Date(expense.createdAt).getDate();
    const dayTotals = dailyTotals.get(day) || new Map();
    addExpenseShares(dayTotals, expense);
    dailyTotals.set(day, dayTotals);
  });
  const pieData = payers
    .map((payer) => ({ ...payer, amount: shareTotals.get(payer.id) || 0 }))
    .filter((payer) => payer.amount > 0);
  const activePayers = pieData;
  const monthTotal = pieData.reduce((total, payer) => total + payer.amount, 0);
  const pieRadius = 62;
  const pieCircumference = 2 * Math.PI * pieRadius;
  let pieOffset = 0;
  const selectedMonthDate = activeMonth
    ? new Date(Number(activeMonth.slice(0, 4)), Number(activeMonth.slice(5, 7)) - 1, 1)
    : new Date();
  const daysInMonth = new Date(selectedMonthDate.getFullYear(), selectedMonthDate.getMonth() + 1, 0).getDate();
  const monthlyKeys = monthKeys.slice(-6);
  const monthlyTotals = new Map();
  expenses.filter((expense) => (expense.currency || 'INR') === activeCurrency).forEach((expense) => {
    const monthKey = getExpenseMonthKey(new Date(expense.createdAt));
    const month = monthlyTotals.get(monthKey) || new Map();
    addExpenseShares(month, expense);
    monthlyTotals.set(monthKey, month);
  });
  const monthlyPayers = payers.filter((payer) => monthlyKeys.some((key) => (monthlyTotals.get(key)?.get(payer.id) || 0) > 0));
  const monthlyTotalFor = (key) => [...(monthlyTotals.get(key)?.values() || [])].reduce((sum, amount) => sum + amount, 0);
  const averageMonthlyTotal = monthlyKeys.length
    ? monthlyKeys.reduce((total, key) => total + monthlyTotalFor(key), 0) / monthlyKeys.length
    : 0;
  const chart = { left: 52, right: 700, top: 22, bottom: 208 };
  const chartWidth = chart.right - chart.left;
  const chartHeight = chart.bottom - chart.top;
  const maximumMonthly = Math.max(averageMonthlyTotal, ...monthlyKeys.map(monthlyTotalFor), 1);
  const monthlySlot = chartWidth / Math.max(monthlyKeys.length, 1);
  const payerBarWidth = Math.max(2, Math.min(20, (monthlySlot - 12) / Math.max(monthlyPayers.length, 1)));
  const visibleMonth = hoveredMonth || selectedMonth;
  const visibleDay = hoveredDay ?? selectedDay;
  const averageLine = monthlyKeys.map((key, index) => {
    const x = chart.left + monthlySlot * index + monthlySlot / 2;
    const y = chart.bottom - (averageMonthlyTotal / maximumMonthly) * chartHeight;
    return `${index ? 'L' : 'M'} ${x} ${y}`;
  }).join(' ');
  const monthLabel = (key) => {
    const [year, month] = key.split('-').map(Number);
    return new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  };
  const formatAmount = (amount) => Number(amount).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  const maxDailyAmount = Math.max(...[...dailyTotals.values()].flatMap((totals) => [...totals.values()]), 1);

  return (
    <section className="spending-insights">
      <div className="spending-insights-heading">
        <div><p className="eyebrow">GROUP SPENDING</p><h3>Monthly spending insights</h3></div>
        <div className="spending-insights-controls">
          {monthOptions.length > 0 && (
            <label>Month
              <select value={activeMonth} onChange={(event) => setMonthSelection(event.target.value)}>
                {monthOptions.map((month) => <option key={month.key} value={month.key}>{month.label}</option>)}
              </select>
            </label>
          )}
          {currencies.length > 1 && (
            <label>Currency
              <select value={activeCurrency} onChange={(event) => setCurrencySelection(event.target.value)}>
                {currencies.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
              </select>
            </label>
          )}
        </div>
      </div>
      {!monthKeys.length ? (
        <p className="empty-state">Add group expenses to see monthly spending charts.</p>
      ) : (
        <>
          <div className="spending-insights-summary">
            <div className="spending-chart-card spending-pie-card">
              <div className="spending-chart-title">
                <div><h4>Who paid this month</h4><p>{monthOptions.find((month) => month.key === activeMonth)?.label}</p></div>
                <strong>{activeCurrency} {formatAmount(paidTotal)}</strong>
              </div>
              {paidData.length ? (
                <div className="spending-pie-layout">
                  <svg className="spending-pie" viewBox="0 0 160 160" role="img" aria-label={`Amount paid by each member for ${activeMonth}`}>
                    <circle cx="80" cy="80" r={pieRadius} fill="none" stroke="#edf0ec" strokeWidth="22" />
                    {paidData.map((payer) => {
                      const segment = (payer.amount / paidTotal) * pieCircumference;
                      const circle = (
                        <circle
                          key={payer.id}
                          cx="80"
                          cy="80"
                          r={pieRadius}
                          fill="none"
                          stroke={colorById.get(payer.id)}
                          strokeWidth="22"
                          strokeDasharray={`${segment} ${pieCircumference - segment}`}
                          strokeDashoffset={-pieOffset}
                          transform="rotate(-90 80 80)"
                        >
                          <title>{payer.name} paid: {activeCurrency} {formatAmount(payer.amount)}</title>
                        </circle>
                      );
                      pieOffset += segment;
                      return circle;
                    })}
                    <text x="80" y="76" textAnchor="middle" className="spending-pie-total">{activeCurrency}</text>
                    <text x="80" y="96" textAnchor="middle" className="spending-pie-amount">{formatAmount(paidTotal)}</text>
                  </svg>
                  <ul className="spending-payer-legend">
                    {paidData.map((payer) => (
                      <li key={payer.id}>
                        <span style={{ '--payer-color': colorById.get(payer.id) }} />
                        <div><strong>{payer.name}</strong><small>{Math.round((payer.amount / paidTotal) * 100)}%</small></div>
                        <b>{activeCurrency} {formatAmount(payer.amount)}</b>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : <p className="empty-state">No expenses for this month in {activeCurrency}.</p>}
            </div>
            <div className="spending-chart-card spending-daily-card">
              <div className="spending-chart-title">
                <div><h4>Daily spending</h4><p>Each day of {monthOptions.find((month) => month.key === activeMonth)?.label}</p></div>
              </div>
              <div className="spending-daily-scroll">
                <svg
                  className="spending-daily-chart"
                  viewBox={`0 0 ${Math.max(680, daysInMonth * 28)} 210`}
                  role="img"
                  aria-label={`Daily group expense shares during ${activeMonth}`}
                >
                  {[0, 1, 2, 3].map((tick) => {
                    const value = maxDailyAmount * (3 - tick) / 3;
                    const y = 166 - (value / maxDailyAmount) * 132;
                    return <g key={tick}><line x1="35" x2={Math.max(680, daysInMonth * 28) - 8} y1={y} y2={y} /><text x="30" y={y + 3} textAnchor="end">{formatAmount(value)}</text></g>;
                  })}
                  {Array.from({ length: daysInMonth }, (_, index) => {
                    const day = index + 1;
                    const chartWidth = Math.max(680, daysInMonth * 28);
                    const daySlot = (chartWidth - 54) / daysInMonth;
                    const x = 42 + index * daySlot;
                    const dayTotals = dailyTotals.get(day) || new Map();
                    const width = Math.max(3, Math.min(8, 17 / Math.max(activePayers.length, 1)));
                    return (
                      <g
                        key={day}
                        className="spending-chart-selection"
                        onMouseEnter={() => setHoveredDay(day)}
                        onMouseLeave={() => setHoveredDay(null)}
                      >
                        {(visibleDay === day) && <rect className="spending-selection-band" x={x - 2} y="26" width={daySlot} height="142" />}
                        {activePayers.map((payer, payerIndex) => {
                          const value = dayTotals.get(payer.id) || 0;
                          const height = (value / maxDailyAmount) * 132;
                          return value > 0 ? (
                            <rect
                              key={payer.id}
                              x={x + payerIndex * (width + 1)}
                              y={166 - height}
                              width={width}
                              height={height}
                              rx="2"
                              fill={colorById.get(payer.id)}
                            >
                              <title>Day {day} · {payer.name}'s share: {activeCurrency} {formatAmount(value)}</title>
                            </rect>
                          ) : null;
                        })}
                        <rect
                          className="spending-chart-hit-area"
                          x={x - 2}
                          y="24"
                          width={daySlot}
                          height="154"
                          fill="transparent"
                          role="button"
                          tabIndex="0"
                          aria-label={`Day ${day}, total ${activeCurrency} ${formatAmount([...dayTotals.values()].reduce((sum, amount) => sum + amount, 0))}. Click to pin details.`}
                          onFocus={() => setHoveredDay(day)}
                          onBlur={() => setHoveredDay(null)}
                          onClick={() => setSelectedDay((current) => current === day ? null : day)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              setSelectedDay((current) => current === day ? null : day);
                            }
                          }}
                        />
                        {day === 1 || day % 5 === 0 || day === daysInMonth
                          ? <text x={x + 4} y="190" textAnchor="middle">{day}</text>
                          : null}
                      </g>
                    );
                  })}
                </svg>
              </div>
              {visibleDay !== null && visibleDay !== undefined && (
                <div className="spending-chart-tooltip spending-daily-tooltip" role="status">
                  <div><strong>{monthOptions.find((month) => month.key === activeMonth)?.label} {visibleDay}</strong><b>{activeCurrency} {formatAmount([...((dailyTotals.get(visibleDay)) || new Map()).values()].reduce((sum, amount) => sum + amount, 0))}</b></div>
                  {activePayers.map((payer) => (
                    <p key={payer.id}><span style={{ color: colorById.get(payer.id) }}>{payer.name}</span><strong>{activeCurrency} {formatAmount(dailyTotals.get(visibleDay)?.get(payer.id) || 0)}</strong></p>
                  ))}
                </div>
              )}
              <p className="spending-axis-caption">Day of month · each member’s actual expense share</p>
              <SpendingLegend payers={activePayers} colorById={colorById} />
            </div>
          </div>
          <div className="spending-chart-card spending-monthly-card">
            <div className="spending-chart-title">
              <div><h4>Monthly expenditure</h4><p>Amount paid by each member · last {monthlyKeys.length} months</p></div>
              <strong>{activeCurrency}</strong>
            </div>
            {monthlyKeys.length ? (
              <>
                <div className="spending-monthly-scroll">
                  <div className="spending-monthly-chart-wrap">
                    <svg className="spending-monthly-chart" viewBox="0 0 740 260" role="img" aria-label="Monthly actual expense share by group member">
                    {[0, 1, 2, 3].map((tick) => {
                      const value = maximumMonthly * (3 - tick) / 3;
                      const y = chart.bottom - (value / maximumMonthly) * chartHeight;
                      return <g key={tick}><line x1={chart.left} x2={chart.right} y1={y} y2={y} /><text x={chart.left - 8} y={y + 4} textAnchor="end">{formatAmount(value)}</text></g>;
                    })}
                    {monthlyKeys.map((key, monthIndex) => {
                      const xCenter = chart.left + monthlySlot * monthIndex + monthlySlot / 2;
                      const totals = monthlyTotals.get(key) || new Map();
                      const plottedPayers = monthlyPayers.filter((payer) => (totals.get(payer.id) || 0) > 0);
                      const groupWidth = plottedPayers.length * payerBarWidth;
                      const total = monthlyTotalFor(key);
                      return (
                        <g
                          key={key}
                          className="spending-chart-selection"
                          onMouseEnter={() => setHoveredMonth(key)}
                          onMouseLeave={() => setHoveredMonth('')}
                        >
                          {visibleMonth === key && <rect className="spending-selection-band" x={chart.left + monthlySlot * monthIndex} y={chart.top} width={monthlySlot} height={chart.bottom - chart.top} />}
                          {plottedPayers.map((payer, payerIndex) => {
                            const amount = totals.get(payer.id) || 0;
                            const height = (amount / maximumMonthly) * chartHeight;
                            return <rect key={payer.id} x={xCenter - groupWidth / 2 + payerIndex * payerBarWidth} y={chart.bottom - height} width={Math.max(2, payerBarWidth - 2)} height={height} rx="2" fill={colorById.get(payer.id)}><title>{monthLabel(key)} · {payer.name}'s actual share: {activeCurrency} {formatAmount(amount)}</title></rect>;
                          })}
                          <rect
                            className="spending-chart-hit-area"
                            x={chart.left + monthlySlot * monthIndex}
                            y={chart.top}
                            width={monthlySlot}
                            height={chart.bottom - chart.top}
                            fill="transparent"
                            role="button"
                            tabIndex="0"
                            aria-label={`${monthLabel(key)} total actual expense share ${activeCurrency} ${formatAmount(total)}. Click to pin details.`}
                            onFocus={() => setHoveredMonth(key)}
                            onBlur={() => setHoveredMonth('')}
                            onClick={() => setSelectedMonth((current) => current === key ? '' : key)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                setSelectedMonth((current) => current === key ? '' : key);
                              }
                            }}
                          />
                          <text x={xCenter} y={chart.bottom + 19} textAnchor="middle">{monthLabel(key)}</text>
                        </g>
                      );
                    })}
                    {monthlyKeys.length > 0 && <path d={averageLine} className="spending-average-line"><title>Average monthly spend: {activeCurrency} {formatAmount(averageMonthlyTotal)}</title></path>}
                    {monthlyKeys.map((key, index) => {
                      const x = chart.left + monthlySlot * index + monthlySlot / 2;
                      const y = chart.bottom - (averageMonthlyTotal / maximumMonthly) * chartHeight;
                      return <circle key={key} cx={x} cy={y} r="3.5" className="spending-average-point" />;
                    })}
                    </svg>
                    {visibleMonth && monthlyTotals.has(visibleMonth) && (
                      <div className="spending-chart-tooltip spending-monthly-tooltip" role="status">
                        <div><strong>{monthLabel(visibleMonth)}</strong><b>{activeCurrency} {formatAmount(monthlyTotalFor(visibleMonth))}</b></div>
                        {monthlyPayers.map((payer) => (
                          <p key={payer.id}><span style={{ color: colorById.get(payer.id) }}>{payer.name}</span><strong>{activeCurrency} {formatAmount(monthlyTotals.get(visibleMonth)?.get(payer.id) || 0)}</strong></p>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="spending-chart-legend">
                  <SpendingLegend payers={monthlyPayers} colorById={colorById} />
                  <span className="spending-average-label"><i />Average monthly spend</span>
                </div>
                <div className="spending-monthly-totals">
                  {monthlyKeys.map((key) => (
                    <span key={key}><small>{monthLabel(key)}</small><strong>{activeCurrency} {formatAmount(monthlyTotalFor(key))}</strong></span>
                  ))}
                </div>
              </>
            ) : <p className="empty-state">No monthly spending data yet.</p>}
          </div>
        </>
      )}
    </section>
  );
}

function SpendingLegend({ payers, colorById }) {
  return (
    <div className="spending-payer-key">
      {payers.map((payer) => (
        <span key={payer.id}><i style={{ background: colorById.get(payer.id) }} />{payer.name}</span>
      ))}
    </div>
  );
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

const expenseCategories = [
  { name: 'Entertainment', icon: '🎮', subcategories: ['Games', 'Music', 'Movies', 'Sports', 'Events'] },
  { name: 'Food and drink', icon: '🍽️', subcategories: ['Dining out', 'Groceries', 'Drinks', 'Coffee', 'Takeaway'] },
  { name: 'Home', icon: '🏠', subcategories: ['Furniture', 'Household supplies', 'Rent', 'Repairs', 'Pets'] },
  { name: 'Life', icon: '🎁', subcategories: ['Gifts', 'Health', 'Education', 'Clothing', 'Personal'] },
  { name: 'Transportation', icon: '🚗', subcategories: ['Fuel', 'Public transit', 'Taxi', 'Parking', 'Flights'] },
  { name: 'Uncategorized', icon: '🧾', subcategories: [] },
  { name: 'Utilities', icon: '💡', subcategories: ['Electricity', 'Internet', 'Water', 'Phone', 'Waste'] },
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

function ExpenseLedger({ expenses, title, description, onAddExpense, onOpenExpense, groupExpenses = false, userId }) {
  const totalByCurrency = new Map();
  expenses.forEach((expense) => {
    totalByCurrency.set(expense.currency, (totalByCurrency.get(expense.currency) || 0) + Number(expense.totalAmount));
  });
  return (
    <div className="personal-expenses-page">
      <div className="welcome-row">
        <div>
          <p className="eyebrow">{groupExpenses ? 'YOUR GROUPS' : 'ONLY YOU CAN SEE THIS'}</p>
          <h1>{title}</h1>
          <p className="lede">{description}</p>
        </div>
        <button className="primary-action" type="button" onClick={onAddExpense}>
          {groupExpenses ? '＋ Add an expense' : '＋ Add personal expense'}
        </button>
      </div>
      <div className="personal-expenses-summary">
        <strong>{expenses.length} {expenses.length === 1 ? 'expense' : 'expenses'}</strong>
        <span>{[...totalByCurrency].map(([currency, total]) => `${currency} ${total.toFixed(2)}`).join(' · ') || 'No spending recorded'}</span>
      </div>
      {expenses.length ? (
        groupExpenses ? (
          <GroupActivityList transactions={expenses} userId={userId} onOpenExpense={onOpenExpense} showGroupName />
        ) : (
          <div className="personal-expense-months">
            {groupExpensesByMonth(expenses).map((month) => {
              const totals = new Map();
              month.expenses.forEach((expense) => {
                totals.set(expense.currency, (totals.get(expense.currency) || 0) + Number(expense.totalAmount));
              });
              return (
                <section className="personal-expense-month" key={month.key}>
                  <header>
                    <div><p className="eyebrow">MONTHLY RECORD</p><h2>{month.label}</h2></div>
                    <span>{month.expenses.length} {month.expenses.length === 1 ? 'expense' : 'expenses'} · {[...totals].map(([currency, total]) => `${currency} ${total.toFixed(2)}`).join(' · ')}</span>
                  </header>
                  <div className="personal-expense-list">
                    {month.expenses.map((expense) => (
                      <article
                        className="personal-expense-row"
                        key={expense._id}
                        role="button"
                        tabIndex={0}
                        onClick={() => onOpenExpense(expense)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            onOpenExpense(expense);
                          }
                        }}
                      >
                        <div className="personal-expense-icon">{expenseCategories.find((category) => category.name === expense.category)?.icon || '🧾'}</div>
                        <div className="personal-expense-info">
                          <strong>{expense.description}</strong>
                          <span>{expense.category || 'Uncategorized'}{expense.subcategory ? ` · ${expense.subcategory}` : ''} · {new Date(expense.createdAt).toLocaleDateString()}</span>
                          {expense.note && <small>{expense.note}</small>}
                          {expense.items?.map((item, index) => <small key={`${expense._id}-${index}`}>{item.description}: {expense.currency} {item.amount}</small>)}
                          {expense.paymentProofUrl && <a className="expense-proof-link" href={expense.paymentProofUrl} target="_blank" rel="noreferrer">View receipt</a>}
                        </div>
                        <strong>{expense.currency} {expense.totalAmount}</strong>
                      </article>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )
      ) : (
        <div className="friends-empty-state">
          <span>▤</span>
          <h2>No {groupExpenses ? 'group' : 'personal'} expenses yet</h2>
          <p>{groupExpenses
            ? 'Expenses you and your group members add will appear here, organized by month.'
            : 'Add an expense just for yourself. It will be saved in your private Personal Expenses group and shown under its month.'}</p>
          <button className="primary-action" type="button" onClick={onAddExpense}>
            {groupExpenses ? 'Add your first group expense' : 'Add your first personal expense'}
          </button>
        </div>
      )}
    </div>
  );
}

function RecentActivityPage({ transactions, notifications, friendRequests, groups, userId, friendBusy, friendError, errorMessage, onOpenExpense, onOpenGroup, onRespondToFriendRequest }) {
  const feedItems = [
    ...transactions.map((transaction) => ({ ...transaction, feedType: 'group' })),
    ...notifications.map((notification) => ({ ...notification, feedType: 'notification' })),
    ...friendRequests.map((request) => ({ ...request, feedType: 'friend-request' })),
  ].sort((first, second) => new Date(second.createdAt) - new Date(first.createdAt));
  return (
    <div className="recent-activity-page">
      <div className="welcome-row">
        <div>
          <p className="eyebrow">THE PAPER TRAIL</p>
          <h1>Recent activity</h1>
          <p className="lede">All group activity, updates, and friend requests in one place.</p>
        </div>
      </div>
      {friendError && <p className="error-message" role="alert">{friendError}</p>}
      {errorMessage && <p className="friend-page-message" role="status">{errorMessage}</p>}
      <section className="recent-group-activity">
        <GroupActivityList
          transactions={feedItems}
          userId={userId}
          groups={groups}
          onOpenExpense={onOpenExpense}
          onOpenGroup={onOpenGroup}
          onRespondToFriendRequest={onRespondToFriendRequest}
          friendBusy={friendBusy}
          showGroupName
        />
        {!feedItems.length && <p className="empty-state">Your group activity and notifications will appear here.</p>}
      </section>
    </div>
  );
}

function Dashboard({ user, accessToken, onLogout, onProfileUpdated }) {
  const firstName = user.fullnamae?.split(" ")[0] || user.username;
  const [groups, setGroups] = useState([]);
  const [personalGroup, setPersonalGroup] = useState(null);
  const [expenses, setExpenses] = useState([]);
  const [personalExpenses, setPersonalExpenses] = useState([]);
  const [activityNotifications, setActivityNotifications] = useState([]);
  const [friends, setFriends] = useState([]);
  const [friendRequests, setFriendRequests] = useState([]);
  const [sentFriendRequests, setSentFriendRequests] = useState([]);
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
  const [friendToRemove, setFriendToRemove] = useState(null);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [selectedExpense, setSelectedExpense] = useState(null);
  const [groupTransactions, setGroupTransactions] = useState([]);
  const [groupWhiteboard, setGroupWhiteboard] = useState(null);
  const [groupBalances, setGroupBalances] = useState([]);
  const [groupSettlements, setGroupSettlements] = useState([]);
  const [groupDetailsError, setGroupDetailsError] = useState('');
  const [groupSettlementError, setGroupSettlementError] = useState('');
  const [groupDetailsBusy, setGroupDetailsBusy] = useState(false);
  const [groupBalancesBusy, setGroupBalancesBusy] = useState(false);
  const [settlementsBusy, setSettlementsBusy] = useState(false);
  const [groupSettingsBusy, setGroupSettingsBusy] = useState(false);
  const [groupSettingsError, setGroupSettingsError] = useState('');
  const [addMemberIdentifier, setAddMemberIdentifier] = useState('');
  const [addMemberError, setAddMemberError] = useState('');
  const [addMemberBusy, setAddMemberBusy] = useState(false);
  const [showExpenseCategories, setShowExpenseCategories] = useState(false);
  const [expenseDraft, setExpenseDraft] = useState({
    description: '',
    totalAmount: '',
    currency: 'INR',
    category: 'Uncategorized',
    subcategory: '',
    groupId: '',
    paidBy: user._id,
    participantIds: [user._id],
    strategy: 'EQUAL',
    splitValues: {},
    items: [],
    note: '',
    paymentProof: null,
    existingProofUrl: null,
  });
  const [expenseError, setExpenseError] = useState('');
  const [expenseBusy, setExpenseBusy] = useState(false);
  const [editingExpenseId, setEditingExpenseId] = useState('');
  const [clearExpenseProof, setClearExpenseProof] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupCoverImage, setGroupCoverImage] = useState(null);
  const [groupSimplifyDebts, setGroupSimplifyDebts] = useState(false);
  const [groupMemberIds, setGroupMemberIds] = useState([]);
  const [groupMemberIdentifier, setGroupMemberIdentifier] = useState('');
  const [groupError, setGroupError] = useState('');
  const [groupBusy, setGroupBusy] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const notificationControlRef = useRef(null);
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
    if (!showNotifications) return undefined;
    const closeOnOutsideClick = (event) => {
      if (!notificationControlRef.current?.contains(event.target)) setShowNotifications(false);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [showNotifications]);

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
      apiRequest("/expenses?history=true", { headers: authHeaders }),
      apiRequest("/expenses/personal", { headers: authHeaders }),
    ])
      .then(([groupData, expenseData, personalExpenseData]) => {
        const loadedGroups = groupData || [];
        setGroups(loadedGroups.filter((group) => !group.isPersonal));
        setPersonalGroup(loadedGroups.find((group) => group.isPersonal) || null);
        setExpenses(expenseData || []);
        setPersonalExpenses(personalExpenseData || []);
      })
      .catch((error) => setFormMessage(error.message));
  }, [accessToken]);

  useEffect(() => {
    if (activePage !== 'recent') return;
    Promise.all([
      apiRequest('/expenses?history=true', { headers: authHeaders }),
      apiRequest('/users/notifications', { headers: authHeaders }),
      apiRequest('/friends/requests', { headers: authHeaders }),
      apiRequest('/users/notifications/read', { method: 'PATCH', headers: authHeaders }),
    ])
      .then(([activity, notifications, requests]) => {
        setExpenses(activity || []);
        setActivityNotifications((notifications || []).map((item) => ({
          ...item,
          readAt: item.readAt || new Date().toISOString(),
        })));
        setFriendRequests(requests || []);
      })
      .catch((error) => setFormMessage(error.message));
  }, [activePage, accessToken]);

  useEffect(() => {
    let active = true;
    const loadNotifications = () => apiRequest('/users/notifications', { headers: authHeaders })
      .then((data) => {
        if (active) setActivityNotifications(data || []);
      })
      .catch((error) => {
        if (active) setFormMessage(error.message);
      });
    void loadNotifications();
    const interval = window.setInterval(() => void loadNotifications(), 20000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [accessToken]);

  const refreshFriendData = async () => {
    const [friendData, requestData, sentRequestData] = await Promise.all([
      apiRequest('/friends', { headers: authHeaders }),
      apiRequest('/friends/requests', { headers: authHeaders }),
      apiRequest('/friends/requests/sent', { headers: authHeaders }),
    ]);
    setFriends(friendData);
    setFriendRequests(requestData);
    setSentFriendRequests(sentRequestData);
  };

  useEffect(() => {
    let active = true;
    const loadFriends = () => Promise.all([
      apiRequest('/friends', { headers: authHeaders }),
      apiRequest('/friends/requests', { headers: authHeaders }),
      apiRequest('/friends/requests/sent', { headers: authHeaders }),
    ])
      .then(([friendData, requestData, sentRequestData]) => {
        if (!active) return;
        setFriends(friendData);
        setFriendRequests(requestData);
        setSentFriendRequests(sentRequestData);
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

  const sendGroupFriendRequest = async (memberId) => {
    await apiRequest('/friends/requests', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ userId: memberId }),
    });
    await refreshFriendData();
    setFormMessage('Friend request sent.');
  };

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
      await refreshFriendData();
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
    setGroupCoverImage(null);
    setGroupSimplifyDebts(false);
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
      const body = new FormData();
      body.set('name', name);
      body.set('memberIds', JSON.stringify(groupMemberIds));
      body.set('memberIdentifiers', JSON.stringify(groupMemberIdentifier.trim() ? [groupMemberIdentifier.trim()] : []));
      body.set('simplifyDebts', String(groupSimplifyDebts));
      if (groupCoverImage) body.set('coverImage', groupCoverImage);
      const group = await apiRequest("/groups", {
        method: "POST",
        headers: authHeaders,
        body,
      });
      setGroups((current) => [group, ...current]);
      setShowGroupForm(false);
      setGroupName('');
      setGroupCoverImage(null);
      setGroupSimplifyDebts(false);
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
    body.set('category', expenseDraft.category);
    body.set('subcategory', expenseDraft.subcategory);
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
    if (clearExpenseProof) body.set('removePaymentProof', 'true');
    setExpenseBusy(true);
    setExpenseError('');
    try {
      const isEditing = Boolean(editingExpenseId);
      const expense = await apiRequest(isEditing ? `/expenses/${editingExpenseId}` : '/expenses', {
        method: isEditing ? "PATCH" : "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body,
      });
      setExpenses((current) => isEditing
        ? current.map((item) => item._id === expense._id ? { ...item, ...expense } : item)
        : [{
          ...expense,
          groupName: group?.name || 'Personal Expenses',
          isPersonal: !expenseDraft.groupId,
        }, ...current]);
      if (!expenseDraft.groupId && !isEditing) {
        setPersonalGroup((current) => current || {
          _id: expense.groupId,
          name: 'Personal Expenses',
          isPersonal: true,
        });
        setPersonalExpenses((current) => [expense, ...current]);
      }
      setShowExpenseForm(false);
      setEditingExpenseId('');
      setClearExpenseProof(false);
      setSelectedExpense(null);
      if (isEditing && !expenseDraft.groupId) {
        setPersonalExpenses(await apiRequest('/expenses/personal', { headers: authHeaders }));
      }
      if (isEditing) {
        setFormMessage('Expense updated. The group has been notified.');
        apiRequest('/users/notifications', { headers: authHeaders })
          .then((data) => setActivityNotifications(data || []))
          .catch((error) => setFormMessage(error.message));
      }
      apiRequest('/expenses?history=true', { headers: authHeaders })
        .then((data) => setExpenses(data || []))
        .catch((error) => setFormMessage(`Expense saved, but recent activity could not be refreshed: ${error.message}`));
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
      category: 'Uncategorized',
      subcategory: '',
      groupId,
      paidBy: user._id,
      participantIds,
      strategy: 'EQUAL',
      splitValues: {},
      items: [],
      note: '',
      paymentProof: null,
      existingProofUrl: null,
    });
    setExpenseError('');
    setEditingExpenseId('');
    setClearExpenseProof(false);
    setShowExpenseCategories(false);
    setShowExpenseForm(true);
  };

  const editExpense = (expense) => {
    const group = groups.find((item) => item._id === expense.groupId);
    const participants = expense.participantIds || [user._id];
    setExpenseDraft({
      description: expense.description || '',
      totalAmount: expense.totalAmount || '',
      currency: expense.currency || 'INR',
      category: expense.category || 'Uncategorized',
      subcategory: expense.subcategory || '',
      groupId: group?._id || '',
      paidBy: expense.paidBy || user._id,
      participantIds: participants,
      strategy: expense.splitStrategy || 'EQUAL',
      splitValues: Object.fromEntries((expense.splits || []).map((split) => [split.userId, split.splitValue])),
      items: (expense.items || []).map((item, index) => ({
        id: `${expense._id}-${index}`,
        description: item.description,
        amount: item.amount,
        participantIds: item.participantIds || [],
      })),
      note: expense.note || '',
      paymentProof: null,
      existingProofUrl: expense.paymentProofUrl || null,
    });
    setEditingExpenseId(expense._id);
    setClearExpenseProof(false);
    setExpenseError('');
    setShowExpenseCategories(false);
    setSelectedExpense(null);
    setShowExpenseForm(true);
  };

  const removeExpense = async (expense) => {
    if (!window.confirm(`Delete “${expense.description}” (${expense.currency} ${Number(expense.totalAmount).toFixed(2)})? Group balances will be adjusted and the deletion will appear in group activity.`)) return null;
    try {
      const result = await apiRequest(`/expenses/${expense._id}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      setSelectedExpense(null);
      setExpenses(await apiRequest('/expenses?history=true', { headers: authHeaders }));
      if (expense.groupId && selectedGroup?._id === expense.groupId) {
        await openGroupDetails(selectedGroup);
      }
      if (!expense.groupId || personalGroup?._id === expense.groupId) {
        setPersonalExpenses(await apiRequest('/expenses/personal', { headers: authHeaders }));
      }
      setFormMessage(result.warning || 'Expense deleted and group balances updated.');
      return true;
    } catch (error) {
      setFormMessage(error.message);
      return error.message;
    }
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
      setFormMessage('You left the group. If you were the last member, the settled group and its data were deleted.');
      return true;
    } catch (error) {
      setFormMessage(error.message);
      setGroupSettingsError(error.message);
      return false;
    }
  };
  const removeGroup = async (groupId) => {
    setGroupSettingsBusy(true);
    setGroupSettingsError('');
    try {
      await apiRequest(`/groups/${groupId}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      setGroups((current) => current.filter((group) => group._id !== groupId));
      setSelectedGroup(null);
      setFormMessage('Group and its expenses were deleted.');
      return true;
    } catch (error) {
      setGroupSettingsError(error.message);
      return false;
    } finally {
      setGroupSettingsBusy(false);
    }
  };
  const openGroupDetails = async (group) => {
    setSelectedGroup(group);
    setGroupWhiteboard(null);
    setGroupDetailsBusy(true);
    setGroupBalancesBusy(true);
    setSettlementsBusy(true);
    setGroupSettlements([]);
    setGroupDetailsError('');
    setGroupSettlementError('');
    try {
      const [transactions, balances, settlements, whiteboard] = await Promise.all([
        apiRequest(`/expenses?groupId=${group._id}&history=true`, { headers: authHeaders }),
        apiRequest(`/groups/${group._id}/balances`, { headers: authHeaders }),
        apiRequest(`/groups/${group._id}/simplify-debts`, { headers: authHeaders }),
        apiRequest(`/groups/${group._id}/whiteboard`, { headers: authHeaders }),
      ]);
      setGroupTransactions(transactions);
      setGroupBalances(balances);
      setGroupSettlements(settlements);
      setGroupWhiteboard(whiteboard);
    } catch (error) {
      setGroupDetailsError(error.message);
      setGroupSettlementError(error.message);
      setFormMessage(error.message);
    } finally {
      setGroupDetailsBusy(false);
      setGroupBalancesBusy(false);
      setSettlementsBusy(false);
    }
  };
  const saveGroupWhiteboard = async (groupId, content) => {
    const whiteboard = await apiRequest(`/groups/${groupId}/whiteboard`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ content }),
    });
    setGroupWhiteboard(whiteboard);
    try {
      setGroupTransactions(await apiRequest(`/expenses?groupId=${groupId}&history=true`, { headers: authHeaders }));
    } catch (error) {
      setFormMessage(`Whiteboard saved, but group activity could not be refreshed: ${error.message}`);
    }
    return whiteboard;
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
  const recordGroupSettlement = async (groupId, settlement) => {
    await apiRequest(`/groups/${groupId}/settlements`, {
      method: 'POST',
      headers: authHeaders,
      body: settlement,
    });
    await openGroupDetails(selectedGroup);
  };
  const requestGroupPayment = async (groupId, paymentRequest) => {
    const result = await apiRequest(`/groups/${groupId}/payment-requests`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(paymentRequest),
    });
    setGroupTransactions((current) => [result.activity, ...current]);
    setActivityNotifications((current) => [result.notification, ...current].slice(0, 50));
    setFormMessage(`Payment request sent to ${result.recipientName}.`);
    return result;
  };
  const saveGroupSettings = async (groupId, settings) => {
    setGroupSettingsBusy(true);
    setGroupSettingsError('');
    try {
      const body = new FormData();
      body.set('name', settings.name);
      body.set('simplifyDebts', String(settings.simplifyDebts));
      if (settings.coverImage) body.set('coverImage', settings.coverImage);
      if (settings.removeCoverImage) body.set('removeCoverImage', 'true');
      const { warning, ...updatedGroup } = await apiRequest(`/groups/${groupId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${accessToken}` },
        body,
      });
      setGroups((current) => current.map((group) => group._id === groupId ? { ...group, ...updatedGroup } : group));
      setSelectedGroup((current) => current?._id === groupId ? { ...current, ...updatedGroup } : current);
      setFormMessage(warning || 'Group settings saved.');
      await openGroupDetails(updatedGroup);
      return true;
    } catch (error) {
      setGroupSettingsError(error.message);
      return false;
    } finally {
      setGroupSettingsBusy(false);
    }
  };
  const addMemberToGroup = async (groupId, identifier) => {
    setAddMemberBusy(true);
    setAddMemberError('');
    try {
      const updatedGroup = await apiRequest(`/groups/${groupId}/members`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ identifier }),
      });
      setGroups((current) => current.map((group) => group._id === groupId ? { ...group, ...updatedGroup } : group));
      setSelectedGroup((current) => current?._id === groupId ? { ...current, ...updatedGroup } : current);
      setAddMemberIdentifier('');
      await openGroupDetails(updatedGroup);
      return true;
    } catch (error) {
      setAddMemberError(error.message);
      return false;
    } finally {
      setAddMemberBusy(false);
    }
  };
  const removeMemberFromGroup = async (groupId, memberId) => {
    setGroupSettingsBusy(true);
    setGroupSettingsError('');
    try {
      const updatedGroup = await apiRequest(`/groups/${groupId}/members/${memberId}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      setGroups((current) => current.map((group) => group._id === groupId ? { ...group, ...updatedGroup } : group));
      setSelectedGroup((current) => current?._id === groupId ? { ...current, ...updatedGroup } : current);
      setFormMessage('Group member removed.');
      await openGroupDetails(updatedGroup);
      return true;
    } catch (error) {
      setGroupSettingsError(error.message);
      return false;
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
  const notificationItems = activityNotifications.filter((notification) => (
    ['PAYMENT_REQUEST', 'PAYMENT_RECEIVED'].includes(notification.notificationType)
  ));
  const expenseGroup = groups.find((group) => group._id === expenseDraft.groupId);
  const expenseMembers = expenseGroup?.members || [user];
  const selectedExpenseMembers = expenseMembers.filter((member) => expenseDraft.participantIds.includes(member._id));
  const itemizedTotal = expenseDraft.items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const expenseSplitDefaults = getDefaultSplitValues(expenseDraft.strategy, expenseDraft.participantIds, expenseDraft.totalAmount);
  const splitModeTotal = selectedExpenseMembers.reduce((sum, member) => sum + (
    Number(expenseDraft.splitValues[member._id] ?? expenseSplitDefaults[member._id]) || 0
  ), 0);
  const groupExpenses = expenses.filter((expense) => expense.groupId && !expense.isPersonal && !['ACTIVITY', 'SETTLEMENT'].includes(expense.type));
  const groupActivity = expenses.filter((entry) => entry.groupId && !entry.isPersonal);

  return (
    <main className="dashboard-page">
      <nav className="dashboard-nav">
        <Brand />
        <div className="nav-links">
          <button className={activePage === 'overview' ? 'active' : ''} type="button" onClick={() => setActivePage('overview')}>Dashboard</button>
          <button className={activePage === 'recent' ? 'active' : ''} type="button" onClick={() => setActivePage('recent')}>Recent activity</button>
          <button className={activePage === 'all-expenses' ? 'active' : ''} type="button" onClick={() => setActivePage('all-expenses')}>All expenses</button>
          <button className={activePage === 'personal' ? 'active' : ''} type="button" onClick={() => setActivePage('personal')}>Personal expenses</button>
          <button className={activePage === 'friends' ? 'active' : ''} type="button" onClick={() => setActivePage('friends')}>Friends</button>
        </div>
        <div className="notification-control" ref={notificationControlRef}>
          <button
            className="notification-trigger"
            type="button"
            aria-label={`Notifications, ${pendingFriendRequests.length + notificationItems.filter((item) => !item.readAt).length} unread`}
            aria-expanded={showNotifications}
            onClick={() => {
              const opening = !showNotifications;
              setShowNotifications(opening);
              setShowProfileMenu(false);
              if (opening) {
                apiRequest('/users/notifications/read', { method: 'PATCH', headers: authHeaders })
                  .then(() => setActivityNotifications((current) => current.map((item) => ({
                    ...item,
                    readAt: item.readAt || new Date().toISOString(),
                  }))))
                  .catch((error) => setFormMessage(error.message));
              }
            }}
          >
            <span aria-hidden="true">♧</span>
            {(pendingFriendRequests.length + notificationItems.filter((item) => !item.readAt).length) > 0 && <span className="notification-count">{pendingFriendRequests.length + notificationItems.filter((item) => !item.readAt).length}</span>}
          </button>
          {showNotifications && (
            <div className="notification-panel">
              <div className="notification-panel-heading">
                <strong>Notifications</strong>
                <button type="button" onClick={() => setShowNotifications(false)} aria-label="Close notifications">×</button>
              </div>
              {pendingFriendRequests.map((request) => (
                <div className="notification-item" key={`friend-request-${request._id}`}>
                  <div className="notification-copy">
                    <strong>{request.senderName || request.senderUsername}</strong>
                    <span>sent you a friend request</span>
                    <small>{new Date(request.createdAt).toLocaleString()}</small>
                  </div>
                  <div className="notification-actions">
                    <button type="button" disabled={friendBusy} onClick={() => {
                      setShowNotifications(false);
                      void respondToFriendRequest(request._id, 'accept');
                    }}>Accept</button>
                    <button type="button" disabled={friendBusy} onClick={() => {
                      setShowNotifications(false);
                      void respondToFriendRequest(request._id, 'decline');
                    }}>Decline</button>
                  </div>
                </div>
              ))}
              {notificationItems.map((notification) => (
                <button
                  className={`notification-item expense-notification-item ${notification.readAt ? '' : 'unread'}`}
                  key={notification._id}
                  type="button"
                  onClick={() => {
                    setShowNotifications(false);
                    const group = groups.find((item) => item._id === notification.groupId);
                    if (group) void openGroupDetails(group);
                    else setActivePage('recent');
                  }}
                >
                  <span className="notification-copy">
                    <strong>{notification.notificationType === 'PAYMENT_REQUEST' ? 'Payment request' : 'Payment received'}</strong>
                    <span>{notification.message}</span>
                    <small>{new Date(notification.createdAt).toLocaleString()}</small>
                  </span>
                </button>
              ))}
              {!pendingFriendRequests.length && !notificationItems.length && (
                <p className="notification-empty">No friend or payment notifications.</p>
              )}
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
            <button className={`side-link ${activePage === 'overview' ? 'active' : ''}`} onClick={() => setActivePage('overview')} type="button">
              ▣ <span>Dashboard</span>
            </button>
            <button className={`side-link ${activePage === 'recent' ? 'active' : ''}`} onClick={() => setActivePage('recent')} type="button">
              ⚑ <span>Recent activity</span>
            </button>
            <button className={`side-link ${activePage === 'all-expenses' ? 'active' : ''}`} onClick={() => setActivePage('all-expenses')} type="button">
              ▤ <span>All expenses</span>
            </button>
            <button className={`side-link ${activePage === 'personal' ? 'active' : ''}`} onClick={() => setActivePage('personal')} type="button">
              ☷ <span>Personal expenses</span>
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
          ) : activePage === 'personal' ? (
            <ExpenseLedger
              expenses={personalExpenses}
              title="Personal expenses"
              description="Your private spending, organized month by month."
              onAddExpense={() => openExpenseForm('')}
              onOpenExpense={setSelectedExpense}
            />
          ) : activePage === 'all-expenses' ? (
            <ExpenseLedger
              expenses={groupExpenses}
              title="All expenses"
              description="Every expense from all the groups you belong to, organized by month."
              onAddExpense={() => openExpenseForm('')}
              onOpenExpense={setSelectedExpense}
              userId={user._id}
              groupExpenses
            />
          ) : activePage === 'recent' ? (
            <RecentActivityPage
              transactions={groupActivity}
              notifications={activityNotifications}
              friendRequests={friendRequests}
              groups={groups}
              userId={user._id}
              friendBusy={friendBusy}
              friendError={friendError}
              errorMessage={formMessage}
              onOpenExpense={setSelectedExpense}
              onOpenGroup={openGroupDetails}
              onRespondToFriendRequest={respondToFriendRequest}
            />
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
              value={expenses.filter((expense) => !['ACTIVITY', 'SETTLEMENT'].includes(expense.type)).length.toString().padStart(2, "0")}
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
                    coverImageUrl={group.coverImageUrl}
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
                <label>
                  Group profile picture (optional)
                  <input type="file" accept="image/*" onChange={(event) => setGroupCoverImage(event.target.files?.[0] || null)} />
                </label>
                <label className="group-hide-toggle group-simplify-toggle">
                  <input type="checkbox" checked={groupSimplifyDebts} onChange={(event) => setGroupSimplifyDebts(event.target.checked)} />
                  Simplify group debts
                </label>
                <p className="modal-help">Debt simplification is off by default. Turn it on to suggest fewer repayments in this group.</p>
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
                      {friend.coverimage
                        ? <img className="group-friend-avatar" src={friend.coverimage} alt="" />
                        : <span className="member-avatar">{(friend.fullnamae || friend.username).slice(0, 1).toUpperCase()}</span>}
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
              title={editingExpenseId ? 'Edit expense' : 'Add an expense'}
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
                <div className="expense-category-picker">
                  <button
                    type="button"
                    className="expense-category-trigger"
                    aria-expanded={showExpenseCategories}
                    onClick={() => setShowExpenseCategories((shown) => !shown)}
                  >
                    <span>{expenseCategories.find((category) => category.name === expenseDraft.category)?.icon}</span>
                    <span><small>Category</small><strong>{expenseDraft.category}{expenseDraft.subcategory ? ` · ${expenseDraft.subcategory}` : ''}</strong></span>
                    <span aria-hidden="true">{showExpenseCategories ? '⌃' : '⌄'}</span>
                  </button>
                  {showExpenseCategories && (
                    <div className="expense-category-options">
                      {expenseCategories.map((category) => (
                        <button
                          type="button"
                          key={category.name}
                          className={expenseDraft.category === category.name ? 'selected' : ''}
                          onClick={() => {
                            setExpenseDraft((current) => ({ ...current, category: category.name, subcategory: '' }));
                            if (!category.subcategories.length) setShowExpenseCategories(false);
                          }}
                        >
                          <span>{category.icon}</span>{category.name}
                        </button>
                      ))}
                    </div>
                  )}
                  {expenseCategories.find((category) => category.name === expenseDraft.category)?.subcategories.length > 0 && (
                    <label className="expense-subcategory">
                      Subcategory (optional)
                      <select value={expenseDraft.subcategory} onChange={(event) => updateExpenseDraft('subcategory', event.target.value)}>
                        <option value="">No subcategory</option>
                        {expenseCategories.find((category) => category.name === expenseDraft.category).subcategories.map((subcategory) => (
                          <option key={subcategory} value={subcategory}>{subcategory}</option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>

                <label>Group
                  <select value={expenseDraft.groupId} onChange={(event) => changeExpenseGroup(event.target.value)} disabled={Boolean(editingExpenseId)}>
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
                  {editingExpenseId && expenseDraft.existingProofUrl && !clearExpenseProof && (
                    <a className="expense-proof-link" href={expenseDraft.existingProofUrl} target="_blank" rel="noreferrer">View current payment proof</a>
                  )}
                  {editingExpenseId && (
                    <label className="expense-proof-remove">
                      <input type="checkbox" checked={clearExpenseProof} onChange={(event) => setClearExpenseProof(event.target.checked)} />
                      Remove existing payment proof
                    </label>
                  )}
                  <label>Note (optional)<textarea value={expenseDraft.note} onChange={(event) => updateExpenseDraft('note', event.target.value)} rows="3" placeholder="Add a note about this expense" /></label>
                </div>
                {expenseError && <p className="error-message" role="alert">{expenseError}</p>}
                <div className="expense-form-actions">
                  <button type="button" className="quiet-button" onClick={() => setShowExpenseForm(false)}>Cancel</button>
                  <button className="submit-button" disabled={expenseBusy || !selectedExpenseMembers.length || (expenseDraft.strategy === 'ITEMIZED' && !expenseDraft.items.length)}>{expenseBusy ? 'Saving…' : editingExpenseId ? 'Save changes' : 'Save expense'}</button>
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
              whiteboard={groupWhiteboard}
              balances={groupBalances}
              balancesBusy={groupBalancesBusy}
              settlements={groupSettlements}
              detailsError={groupDetailsError}
              settlementError={groupSettlementError}
              settlementsBusy={settlementsBusy}
              settingsBusy={groupSettingsBusy}
              settingsError={groupSettingsError}
              addMemberBusy={addMemberBusy}
              addMemberError={addMemberError}
              friends={friends}
              friendRequests={friendRequests}
              sentFriendRequests={sentFriendRequests}
              user={user}
              onClose={() => setSelectedGroup(null)}
              onJoin={() => { setSelectedGroup(null); setShowJoinForm(true); }}
              onAddExpense={() => openExpenseForm(selectedGroup._id)}
              onOpenExpense={setSelectedExpense}
              onSaveWhiteboard={(content) => saveGroupWhiteboard(selectedGroup._id, content)}
              onLoadWhiteboard={async () => {
                const whiteboard = await apiRequest(`/groups/${selectedGroup._id}/whiteboard`, { headers: authHeaders });
                setGroupWhiteboard(whiteboard);
                return whiteboard;
              }}
              onSettle={() => loadGroupSettlements(selectedGroup._id)}
              onRecordSettlement={(settlement) => recordGroupSettlement(selectedGroup._id, settlement)}
              onRequestPayment={(paymentRequest) => requestGroupPayment(selectedGroup._id, paymentRequest)}
              onSendFriendRequest={sendGroupFriendRequest}
              onSaveSettings={(settings) => saveGroupSettings(selectedGroup._id, settings)}
              onAddMember={(identifier) => addMemberToGroup(selectedGroup._id, identifier)}
              onRemoveMember={(memberId) => removeMemberFromGroup(selectedGroup._id, memberId)}
              onDelete={async () => {
                if (await removeGroup(selectedGroup._id)) setSelectedGroup(null);
              }}
              onLeave={async () => {
                if (await leaveGroup(selectedGroup._id)) setSelectedGroup(null);
              }}
            />
          )}
          {selectedExpense && (
            <ExpenseDetails
              expense={selectedExpense}
              group={groups.find((item) => item._id === selectedExpense.groupId) || personalGroup}
              members={groups.find((item) => item._id === selectedExpense.groupId)?.members || [user]}
              userId={user._id}
              accessToken={accessToken}
              onClose={() => setSelectedExpense(null)}
              onEdit={() => editExpense(selectedExpense)}
              onDelete={() => removeExpense(selectedExpense)}
              onCommentAdded={async () => {
                setExpenses(await apiRequest('/expenses?history=true', { headers: authHeaders }));
                if (selectedGroup?._id === selectedExpense.groupId) await openGroupDetails(selectedGroup);
              }}
            />
          )}
        </section>
        {activePage === 'overview' && <aside className="dashboard-right-rail">
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
function Group({ initials, coverImageUrl, name, amount, note, tone, groupCode, onSimplify, onLeave, onOpen }) {
  return (
    <div className="group-row group-row-clickable" onClick={onOpen} role="button" tabIndex="0" onKeyDown={(event) => { if (event.key === "Enter") onOpen(); }}>
      {coverImageUrl
        ? <img className="group-icon group-cover-avatar" src={coverImageUrl} alt="" />
        : <span className={`group-icon ${tone}`}>{initials}</span>}
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
  whiteboard,
  balances,
  balancesBusy,
  settlements,
  detailsError,
  settlementError,
  settlementsBusy,
  settingsBusy,
  settingsError,
  addMemberBusy,
  addMemberError,
  friends,
  friendRequests,
  sentFriendRequests,
  user,
  onClose,
  onJoin,
  onAddExpense,
  onOpenExpense,
  onSaveWhiteboard,
  onLoadWhiteboard,
  onSettle,
  onSaveSettings,
  onAddMember,
  onRemoveMember,
  onRecordSettlement,
  onRequestPayment,
  onSendFriendRequest,
  onDelete,
  onLeave,
}) {
  const [activeTab, setActiveTab] = useState('activity');
  const [hideUninvolved, setHideUninvolved] = useState(false);
  const [activitySearch, setActivitySearch] = useState('');
  const [whiteboardDraft, setWhiteboardDraft] = useState('');
  const [whiteboardBusy, setWhiteboardBusy] = useState(false);
  const [whiteboardError, setWhiteboardError] = useState('');
  const [whiteboardSaved, setWhiteboardSaved] = useState(false);
  const [nameDraft, setNameDraft] = useState(group.name);
  const [simplifyDebtsDraft, setSimplifyDebtsDraft] = useState(group.simplifyDebts !== false);
  const [coverImageDraft, setCoverImageDraft] = useState(null);
  const [removeCoverImage, setRemoveCoverImage] = useState(false);
  const [memberInput, setMemberInput] = useState('');
  const [coverPreview, setCoverPreview] = useState('');
  const [settingsPlanVisible, setSettingsPlanVisible] = useState(false);
  const [memberIdentifierDraft, setMemberIdentifierDraft] = useState('');
  const [friendRequestBusyId, setFriendRequestBusyId] = useState('');
  const [friendRequestError, setFriendRequestError] = useState('');
  const [settlementOpen, setSettlementOpen] = useState(false);
  const [settlementDraft, setSettlementDraft] = useState({ payeeId: '', currency: 'INR', amount: '', note: '', paymentProof: null });
  const [settlementSaveError, setSettlementSaveError] = useState('');
  const [settlementSaveBusy, setSettlementSaveBusy] = useState(false);
  const [paymentRequestOpen, setPaymentRequestOpen] = useState(false);
  const [paymentRequestDraft, setPaymentRequestDraft] = useState({ memberId: '', amount: '', currency: 'INR', note: '' });
  const [paymentRequestError, setPaymentRequestError] = useState('');
  const [paymentRequestBusy, setPaymentRequestBusy] = useState(false);
  const isOwner = group.createdBy === user._id;
  const memberName = (id) => {
    const member = group.members?.find((item) => item._id === id);
    return member?.fullnamae || member?.username || 'Group member';
  };
  const sendFriendRequest = async (memberId) => {
    setFriendRequestBusyId(memberId);
    setFriendRequestError('');
    try {
      await onSendFriendRequest(memberId);
    } catch (error) {
      setFriendRequestError(error.message);
    } finally {
      setFriendRequestBusyId('');
    }
  };
  const visibleTransactions = transactions.filter((transaction) => {
    if (hideUninvolved && transaction.type !== 'ACTIVITY'
      && transaction.paidBy !== user._id
      && !transaction.participantIds?.includes(user._id)) return false;
    const terms = activitySearch.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return true;
    const searchable = [
      transaction.description,
      transaction.details,
      transaction.paidByName,
      transaction.paidByUsername,
      transaction.paidToName,
      transaction.currency,
      transaction.totalAmount,
      ...(transaction.splits || []).map((split) => memberName(split.userId)),
    ].filter(Boolean).join(' ').toLocaleLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
  const saveWhiteboard = async (event) => {
    event.preventDefault();
    setWhiteboardBusy(true);
    setWhiteboardError('');
    setWhiteboardSaved(false);
    try {
      await onSaveWhiteboard(whiteboardDraft);
      setWhiteboardSaved(true);
    } catch (error) {
      setWhiteboardError(error.message);
    } finally {
      setWhiteboardBusy(false);
    }
  };
  const refreshWhiteboard = async () => {
    setWhiteboardBusy(true);
    setWhiteboardError('');
    setWhiteboardSaved(false);
    try {
      const latest = await onLoadWhiteboard();
      setWhiteboardDraft(latest.content || '');
    } catch (error) {
      setWhiteboardError(error.message);
    } finally {
      setWhiteboardBusy(false);
    }
  };
  const printExpenseSummary = () => {
    const reportWindow = window.open('', '_blank');
    if (!reportWindow) {
      window.alert('Allow pop-ups for SplitCare to print or save the group summary as a PDF.');
      return;
    }
    reportWindow.opener = null;
    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[character]);
    const formatReportAmount = (value) => Number(value || 0).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const reportEntries = transactions
      .filter((transaction) => ['EXPENSE', 'REIMBURSEMENT', 'SETTLEMENT'].includes(transaction.type))
      .sort((first, second) => new Date(first.createdAt) - new Date(second.createdAt));
    const reportExpenses = reportEntries.filter((entry) => entry.type !== 'SETTLEMENT');
    const reportSettlements = reportEntries.filter((entry) => entry.type === 'SETTLEMENT');
    const currencies = [...new Set(reportEntries.map((entry) => entry.currency || 'INR'))].sort();
    const rowsByCurrency = currencies.map((currency) => {
      const entriesForCurrency = reportEntries.filter((entry) => (entry.currency || 'INR') === currency);
      const expensesForCurrency = entriesForCurrency.filter((entry) => entry.type !== 'SETTLEMENT');
      const memberTotals = new Map((group.members || []).map((member) => [member._id, 0]));
      const totalAmount = expensesForCurrency.reduce((sum, expense) => sum + (Number(expense.totalAmount) || 0), 0);
      const rows = entriesForCurrency.map((expense) => {
        const shares = new Map();
        (expense.splits || []).forEach((split) => {
          const amount = Number(split.amountOwed);
          if (!Number.isFinite(amount)) return;
          shares.set(split.userId, amount);
        });
        const date = new Date(expense.createdAt);
        const payer = expense.paidByName || expense.paidByUsername || memberName(expense.paidBy);
        const amount = Number(expense.totalAmount) || 0;
        const description = expense.type === 'SETTLEMENT'
          ? expense.note || `Payment to ${expense.paidToName || memberName(expense.paidTo)}`
          : expense.description;
        const memberChanges = (group.members || []).map((member) => {
          const change = expense.type === 'SETTLEMENT'
            ? (member._id === expense.paidTo ? amount : 0) - (member._id === expense.paidBy ? amount : 0)
            : (member._id === expense.paidBy ? amount : 0) - (shares.get(member._id) || 0);
          memberTotals.set(member._id, (memberTotals.get(member._id) || 0) + change);
          const sign = change > 0 ? '+' : change < 0 ? '−' : '';
          return `<td class="money">${sign}${escapeHtml(currency)} ${formatReportAmount(Math.abs(change))}</td>`;
        }).join('');
        return `<tr>
          <td>${escapeHtml(date.toLocaleDateString())}</td>
          <td>${escapeHtml(description)}</td>
          <td>${escapeHtml(payer)}</td>
          <td class="money">${escapeHtml(currency)} ${formatReportAmount(expense.totalAmount)}</td>
          ${memberChanges}
        </tr>`;
      }).join('');
      return `<section class="currency-section">
        <h2>Group ledger in ${escapeHtml(currency)}</h2>
        <table>
          <thead><tr>
            <th>Date</th><th>Description</th><th>Paid by</th><th>Total</th>
            ${(group.members || []).map((member) => `<th>${escapeHtml(member.fullnamae || member.username)}<small>balance change</small></th>`).join('')}
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="${4 + (group.members || []).length}" class="empty">No entries recorded.</td></tr>`}</tbody>
          <tfoot><tr>
            <th colspan="3">Expense total / net change</th><th class="money">${escapeHtml(currency)} ${formatReportAmount(totalAmount)}</th>
            ${(group.members || []).map((member) => {
              const change = memberTotals.get(member._id) || 0;
              const sign = change > 0 ? '+' : change < 0 ? '−' : '';
              return `<th class="money">${sign}${escapeHtml(currency)} ${formatReportAmount(Math.abs(change))}</th>`;
            }).join('')}
          </tr></tfoot>
        </table>
      </section>`;
    }).join('');
    const generatedAt = new Date().toLocaleString();
    const title = `${group.name} - expense summary`;
    reportWindow.document.open();
    reportWindow.document.write(`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>${escapeHtml(title)}</title>
          <style>
            @page { size: A4 landscape; margin: 12mm; }
            * { box-sizing: border-box; }
            body { margin: 0; color: #26332c; font: 12px/1.4 Arial, sans-serif; }
            header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #386d5e; margin-bottom: 20px; padding-bottom: 12px; }
            h1 { margin: 0 0 4px; font-size: 23px; }
            header p { margin: 0; color: #68736a; }
            .meta { color: #68736a; text-align: right; }
            .currency-section { margin: 0 0 22px; }
            h2 { margin: 0 0 8px; font-size: 15px; }
            table { width: 100%; border-collapse: collapse; table-layout: auto; }
            th, td { border: 1px solid #d9e0da; padding: 6px 7px; text-align: left; vertical-align: top; }
            thead { display: table-header-group; }
            th { background: #edf3ef; font-size: 10px; }
            th small { display: block; color: #78847b; font-weight: normal; }
            td { font-size: 10px; }
            .money { text-align: right; white-space: nowrap; }
            tfoot th { background: #f2f5f2; }
            .empty { color: #778078; text-align: center; }
            tr { break-inside: avoid; }
            .print-button { position: fixed; top: 12px; right: 12px; border: 0; border-radius: 5px; background: #398f78; color: white; padding: 10px 14px; font-weight: bold; cursor: pointer; }
            @media print { .print-button { display: none; } }
          </style>
        </head>
        <body>
          <button class="print-button" onclick="window.print()">Print / Save as PDF</button>
          <header>
            <div><h1>${escapeHtml(group.name)}</h1><p>Group expense summary · All expenses and recorded payments</p><p>Member balance change: positive means owed, negative means owes.</p></div>
            <div class="meta">Generated ${escapeHtml(generatedAt)}<br>${reportExpenses.length} expenses · ${reportSettlements.length} payments · ${group.members?.length || 0} members</div>
          </header>
          ${rowsByCurrency || '<p>No group expenses have been recorded yet.</p>'}
        </body>
      </html>`);
    reportWindow.document.close();
    reportWindow.setTimeout(() => reportWindow.print(), 300);
  };
  const exportTransactions = () => {
    const rows = [
      ['Date', 'Description', 'Paid by', 'Amount', 'Currency'],
      ...transactions.filter((transaction) => transaction.type !== 'ACTIVITY').map((transaction) => [
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
  const openSettlementForm = () => {
    setSettlementDraft({
      payeeId: '',
      currency: balances.find((balance) => balance.currency)?.currency || 'INR',
      amount: '',
      note: '',
      paymentProof: null,
    });
    setSettlementSaveError('');
    setSettlementOpen(true);
  };
  const submitSettlement = async (event) => {
    event.preventDefault();
    setSettlementSaveBusy(true);
    setSettlementSaveError('');
    const form = new FormData();
    form.append('payeeId', settlementDraft.payeeId);
    form.append('currency', settlementDraft.currency);
    form.append('amount', settlementDraft.amount);
    form.append('note', settlementDraft.note);
    if (settlementDraft.paymentProof) form.append('paymentProof', settlementDraft.paymentProof);
    try {
      await onRecordSettlement(form);
      setSettlementOpen(false);
    } catch (error) {
      setSettlementSaveError(error.message);
    } finally {
      setSettlementSaveBusy(false);
    }
  };
  const openPaymentRequest = (balance) => {
    setPaymentRequestDraft({
      memberId: balance._id,
      amount: Math.abs(Number(balance.netBalance)).toFixed(2),
      currency: balance.currency || 'INR',
      note: '',
    });
    setPaymentRequestError('');
    setPaymentRequestOpen(true);
  };
  const submitPaymentRequest = async (event) => {
    event.preventDefault();
    setPaymentRequestBusy(true);
    setPaymentRequestError('');
    try {
      await onRequestPayment(paymentRequestDraft);
      setPaymentRequestOpen(false);
    } catch (error) {
      setPaymentRequestError(error.message);
    } finally {
      setPaymentRequestBusy(false);
    }
  };

  useEffect(() => {
    setNameDraft(group.name);
    setSimplifyDebtsDraft(group.simplifyDebts !== false);
    setCoverImageDraft(null);
    setRemoveCoverImage(false);
  }, [group._id, group.name, group.simplifyDebts, group.coverImageUrl]);

  useEffect(() => {
    const latestContent = whiteboard?.content || '';
    setWhiteboardDraft(latestContent);
    if (whiteboardDraft !== latestContent) setWhiteboardSaved(false);
    setWhiteboardError('');
  }, [group._id, whiteboard?.content, whiteboard?.updatedAt]);

  useEffect(() => {
    if (!coverImageDraft) {
      setCoverPreview('');
      return undefined;
    }
    const preview = URL.createObjectURL(coverImageDraft);
    setCoverPreview(preview);
    return () => URL.revokeObjectURL(preview);
  }, [coverImageDraft]);

  const saveSettings = async (event) => {
    event.preventDefault();
    const saved = await onSaveSettings({
      name: nameDraft.trim(),
      simplifyDebts: simplifyDebtsDraft,
      coverImage: coverImageDraft,
      removeCoverImage,
    });
    if (saved) {
      setCoverImageDraft(null);
      setRemoveCoverImage(false);
    }
  };

  const submitAddMember = async () => {
    if (await onAddMember(memberInput.trim())) setMemberInput('');
  };

  return (
    <div className="group-details-backdrop" onMouseDown={onClose}>
      <section className="group-details group-workspace" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        <header className="group-workspace-header">
          <div className="group-workspace-identity">
            {group.coverImageUrl
              ? <img className="group-workspace-avatar group-workspace-cover" src={group.coverImageUrl} alt="" />
              : <span className="group-workspace-avatar">{group.name.slice(0, 1).toUpperCase()}</span>}
            <div>
              <p className="eyebrow">GROUP</p>
              <h2>{group.name}</h2>
              <span>{group.members?.length || 0} {(group.members?.length || 0) === 1 ? 'person' : 'people'}</span>
            </div>
          </div>
          <div className="group-workspace-actions">
            <button className="group-add-expense" onClick={onAddExpense}>＋ Add an expense</button>
            <button className="group-settle-button" onClick={() => { setActiveTab('balances'); onSettle(); openSettlementForm(); }}>Settle up</button>
          </div>
          <div className="group-id-card">
            <span>GROUP ID</span><strong>{group.groupCode || 'Not assigned'}</strong>
            <small>ID: {group._id}</small>
            <button onClick={onJoin}>Join another group</button>
          </div>
        </header>

        <section className="group-whiteboard" aria-labelledby="group-whiteboard-title">
          <div className="group-whiteboard-heading">
            <div>
              <p className="eyebrow">SHARED NOTES</p>
              <h3 id="group-whiteboard-title">Whiteboard</h3>
              <p>Keep reminders, plans, and useful group information here.</p>
            </div>
            <div className="group-whiteboard-actions">
              <button type="button" className="group-inline-action" onClick={refreshWhiteboard} disabled={whiteboardBusy || !onLoadWhiteboard}>Refresh</button>
              <button type="submit" form="group-whiteboard-form" className="group-setting-button" disabled={whiteboardBusy || !whiteboard || whiteboardDraft === (whiteboard.content || '')}>
                {whiteboardBusy ? 'Saving…' : 'Save note'}
              </button>
            </div>
          </div>
          <form id="group-whiteboard-form" onSubmit={saveWhiteboard}>
            <label className="sr-only" htmlFor="group-whiteboard-content">Shared group notes</label>
            <textarea
              id="group-whiteboard-content"
              value={whiteboardDraft}
              onChange={(event) => {
                setWhiteboardDraft(event.target.value);
                setWhiteboardSaved(false);
              }}
              maxLength="5000"
              rows="3"
              placeholder="Add reminders, addresses, plans, or other important group information…"
              disabled={!whiteboard}
            />
            <div className="group-whiteboard-footer">
              <span>
                {whiteboard?.updatedAt
                  ? `Last updated by ${whiteboard.updatedByName || 'a group member'} · ${new Date(whiteboard.updatedAt).toLocaleString()}`
                  : whiteboard ? 'No shared notes yet.' : 'Loading shared notes…'}
                {whiteboardSaved ? ' · Saved' : ''}
              </span>
              <small>{whiteboardDraft.length}/5000</small>
            </div>
            {whiteboardError && <p className="error-message" role="alert">{whiteboardError}</p>}
          </form>
        </section>

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
                  <div className="group-activity-tools">
                    <label className="group-activity-search">
                      <span className="sr-only">Search group activity</span>
                      <input
                        type="search"
                        value={activitySearch}
                        onChange={(event) => setActivitySearch(event.target.value)}
                        placeholder="Search description, member, or amount"
                      />
                    </label>
                    <button type="button" className="group-inline-action group-print-summary" onClick={printExpenseSummary}>Print / Save PDF</button>
                    <span>{visibleTransactions.length} of {transactions.length}</span>
                  </div>
                </div>
                {transactionsBusy ? <p className="empty-state">Loading group activity…</p> : visibleTransactions.length ? (
                  <GroupActivityList transactions={visibleTransactions} userId={user._id} onOpenExpense={onOpenExpense} />
                ) : <p className="empty-state">{activitySearch.trim()
                  ? 'No activity matches your search. Try a description, member name, or amount.'
                  : hideUninvolved ? 'No group expenses involving you.' : 'No expenses in this group yet. Add the first one to get started.'}</p>}
              </section>
            )}
            {activeTab === 'balances' && (
              <section>
                <div className="group-section-heading">
                  <div><p className="eyebrow">YOUR SHARE</p><h3>Your group balances</h3></div>
                  <button className="group-inline-action" onClick={onSettle} disabled={settlementsBusy}>{settlementsBusy ? 'Calculating…' : 'Refresh settle-up plan'}</button>
                </div>
                {balancesBusy ? <p className="empty-state">Loading group balances…</p> : balances.length ? (
                  <div className="group-balances-list">
                    {balances.map((balance) => {
                      const amount = Number(balance.netBalance);
                      const name = balance.fullnamae || balance.username;
                      return (
                        <article className="group-balance-row" key={`${balance._id}-${balance.currency || 'INR'}`}>
                          <span className={`member-avatar ${amount > 0 ? 'mint' : 'coral-bg'}`}>
                            {balance.coverimage
                              ? <img src={balance.coverimage} alt="" />
                              : name.slice(0, 1).toUpperCase()}
                          </span>
                          <div><strong>{name}</strong><small>@{balance.username}</small></div>
                          <p className={amount > 0 ? 'balance-positive' : 'balance-negative'}>{amount > 0 ? `${name} owes you` : `You owe ${name}`} <b>{balance.currency || 'INR'} {Math.abs(amount).toFixed(2)}</b></p>
                          {amount > 0 && <button className="group-inline-action group-request-payment" type="button" onClick={() => openPaymentRequest(balance)}>Request payment</button>}
                        </article>
                      );
                    })}
                  </div>
                ) : <p className="empty-state">You’re settled up in this group.</p>}
                <SpendingInsights transactions={transactions} members={group.members || []} />
                <div className="settlement-plan">
                  <h4>Suggested settlements</h4>
                  <button className="group-inline-action" onClick={() => openSettlementForm()}>Record a payment</button>
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
                <form className="group-settings-form" onSubmit={saveSettings}>
                  <label className="group-cover-picker">
                    <span className="group-cover-preview">
                      {coverPreview || (!removeCoverImage && group.coverImageUrl)
                        ? <img src={coverPreview || group.coverImageUrl} alt="Group cover" />
                        : <span>{group.name.slice(0, 1).toUpperCase()}</span>}
                    </span>
                    <span>Change group cover image</span>
                    <input type="file" accept="image/*" onChange={(event) => {
                      setCoverImageDraft(event.target.files?.[0] || null);
                      setRemoveCoverImage(false);
                    }} />
                  </label>
                  {group.coverImageUrl && !coverPreview && (
                    <label className="group-hide-toggle">
                      <input type="checkbox" checked={removeCoverImage} onChange={(event) => setRemoveCoverImage(event.target.checked)} />
                      Remove group cover image
                    </label>
                  )}
                  <label>Group name<input value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} maxLength="120" required /></label>
                  <div className="group-settings-members">
                    <h4>Group members</h4>
                    {group.members?.map((member) => (
                      <div className="group-settings-member" key={member._id}>
                        {member.coverimage
                          ? <img src={member.coverimage} alt="" />
                          : <span className="member-avatar">{(member.fullnamae || member.username).slice(0, 1).toUpperCase()}</span>}
                        <span><strong>{member.fullnamae || member.username}</strong><small>@{member.username}{member._id === group.createdBy ? ' · Creator' : ''}</small></span>
                        {member._id !== group.createdBy && member._id !== user._id && (
                          <button
                            type="button"
                            className="group-member-remove"
                            disabled={settingsBusy}
                            aria-label={`Remove ${member.fullnamae || member.username} from group`}
                            title="Remove member (their balances must be settled)"
                            onClick={() => {
                              if (window.confirm(`Remove ${member.fullnamae || member.username} from this group? Their balances must be settled first.`)) {
                                onRemoveMember(member._id);
                              }
                            }}
                          >×</button>
                        )}
                      </div>
                    ))}
                    <div className="group-settings-add-member">
                      <label>Add a member by username or email
                        <input value={memberInput} onChange={(event) => setMemberInput(event.target.value)} onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            void submitAddMember();
                          }
                        }} placeholder="Username or email" />
                      </label>
                      <button type="button" className="group-setting-button" onClick={() => void submitAddMember()} disabled={addMemberBusy || !memberInput.trim()}>{addMemberBusy ? 'Adding…' : 'Add member'}</button>
                      {addMemberError && <p className="error-message" role="alert">{addMemberError}</p>}
                    </div>
                  </div>
                  <label className="group-hide-toggle group-simplify-toggle">
                    <input type="checkbox" checked={simplifyDebtsDraft} onChange={(event) => setSimplifyDebtsDraft(event.target.checked)} />
                    Simplify group debts
                  </label>
                  <p className="modal-help">When enabled, your balances and the settlement plan are recalculated from every group expense and recorded payment. Suggestions never move money automatically; record a payment to update the ledger.</p>
                  {settingsError && <p className="error-message" role="alert">{settingsError}</p>}
                  <button className="group-setting-button" disabled={settingsBusy}>{settingsBusy ? 'Saving…' : 'Save group settings'}</button>
                </form>
                <div className="group-simplify-preview">
                  <button className="group-setting-button" type="button" onClick={() => {
                    setSettingsPlanVisible(true);
                    onSettle();
                  }} disabled={settlementsBusy}>
                    {settlementsBusy ? 'Calculating…' : 'Show simplified debt plan'}
                  </button>
                  {settingsPlanVisible && (
                    <div className="group-simplify-plan">
                      {settlementError
                        ? <p className="error-message">{settlementError}</p>
                        : settlements.length
                          ? settlements.map((settlement, index) => (
                            <p key={`${settlement.from}-${settlement.to}-${settlement.currency}-${index}`}>
                              <strong>{memberName(settlement.from)}</strong> pays <strong>{memberName(settlement.to)}</strong> {settlement.currency} {Number(settlement.amount).toFixed(2)}
                            </p>
                          ))
                          : !settlementsBusy && <p>This group is already settled.</p>}
                    </div>
                  )}
                </div>
                <label className="group-hide-toggle"><input type="checkbox" checked={hideUninvolved} onChange={(event) => setHideUninvolved(event.target.checked)} /> Hide expenses I’m not involved in</label>
                <button className="group-setting-button" onClick={exportTransactions}>Export expenses as CSV</button>
                {isOwner && <button className="group-setting-button group-delete-button" disabled={settingsBusy} onClick={() => {
                  if (window.confirm('Permanently delete this group and all its expenses? This is only allowed after every balance is settled.')) onDelete();
                }}>{settingsBusy ? 'Deleting…' : 'Delete group and all its data'}</button>}
                <button className="group-setting-button group-leave-button" onClick={() => {
                  if (window.confirm('Leave this group? All group balances must be settled first. If you are the last member, the group and its data will be deleted.')) onLeave();
                }}>Leave group</button>
              </section>
            )}
          </main>

          <aside className="group-workspace-sidebar">
            <div className="group-sidebar-heading"><span>◉</span><h3>Your balances</h3></div>
            {balancesBusy ? <p className="empty-state">Loading…</p> : balances.map((balance) => {
              const amount = Number(balance.netBalance);
              if (Math.abs(amount) < 0.005) return null;
              return (
                <div className="group-sidebar-balance" key={`${balance._id}-${balance.currency || 'INR'}`}>
                  <span className={`member-avatar ${amount > 0 ? 'mint' : 'coral-bg'}`}>
                    {balance.coverimage
                      ? <img src={balance.coverimage} alt="" />
                      : (balance.fullnamae || balance.username).slice(0, 1).toUpperCase()}
                  </span>
                  <div><strong>{balance.fullnamae || balance.username}</strong><small className={amount > 0 ? 'balance-positive' : 'balance-negative'}>{amount > 0 ? 'owes you' : 'you owe'} {balance.currency || 'INR'} {Math.abs(amount).toFixed(2)}</small></div>
                </div>
              );
            })}
            {!balancesBusy && !balances.some((balance) => Math.abs(Number(balance.netBalance)) >= 0.005) && <p className="empty-state">You’re settled up in this group.</p>}
            <button className="group-view-balances" onClick={() => setActiveTab('balances')}>View details →</button>
            <div className="group-sidebar-members">
              <div className="group-members-heading"><h3>People in this group</h3><span>{group.members?.length || 0}</span></div>
              {(group.members || []).map((member) => (
                <div className="group-sidebar-member" key={member._id}>
                  <span className="member-avatar">
                    {member.coverimage
                      ? <img src={member.coverimage} alt="" />
                      : (member.fullnamae || member.username).slice(0, 1).toUpperCase()}
                  </span>
                  <span className="group-sidebar-member-name">{member.fullnamae || member.username}</span>
                  {member._id !== user._id && (() => {
                    const isFriend = friends.some((friend) => friend._id === member._id);
                    const hasSentRequest = sentFriendRequests.some((request) => request.recipientId === member._id && request.status === 'pending');
                    const hasReceivedRequest = friendRequests.some((request) => request.senderId === member._id && request.status === 'pending');
                    const buttonLabel = isFriend
                      ? 'Friends'
                      : hasSentRequest
                        ? 'Request sent'
                        : hasReceivedRequest
                          ? 'Request received'
                          : friendRequestBusyId === member._id
                            ? 'Sending…'
                            : 'Add friend';
                    return (
                      <button
                        type="button"
                        className="group-member-friend-action"
                        disabled={isFriend || hasSentRequest || hasReceivedRequest || Boolean(friendRequestBusyId)}
                        onClick={() => void sendFriendRequest(member._id)}
                        aria-label={`${buttonLabel}${buttonLabel === 'Add friend' ? `: ${member.fullnamae || member.username}` : ''}`}
                        title={hasReceivedRequest ? 'This member has already sent you a request. Respond from Friends.' : undefined}
                      >
                        {buttonLabel}
                      </button>
                    );
                  })()}
                </div>
              ))}
              {friendRequestError && <p className="error-message" role="alert">{friendRequestError}</p>}
              <form className="group-add-member-form" onSubmit={async (event) => {
                event.preventDefault();
                if (await onAddMember(memberIdentifierDraft.trim())) setMemberIdentifierDraft('');
              }}>
                <label>Add someone by username or email
                  <input type="text" value={memberIdentifierDraft} onChange={(event) => setMemberIdentifierDraft(event.target.value)} placeholder="@username or email" required />
                </label>
                {addMemberError && <p className="error-message" role="alert">{addMemberError}</p>}
                <button type="submit" disabled={addMemberBusy || !memberIdentifierDraft.trim()}>{addMemberBusy ? 'Adding…' : 'Add to group'}</button>
              </form>
            </div>
          </aside>
        </div>
      </section>
      {paymentRequestOpen && (
        <Modal title={`Request payment from ${memberName(paymentRequestDraft.memberId)}`} onClose={() => setPaymentRequestOpen(false)} className="settlement-modal">
          <form className="group-settlement-form" onSubmit={submitPaymentRequest}>
            <p className="modal-help">This sends a payment request to the selected member and records it in the group activity. It does not change the group balance.</p>
            <div className="group-settlement-amount-fields">
              <label>Currency
                <input value={paymentRequestDraft.currency} readOnly />
              </label>
              <label>Amount
                <input
                  type="number"
                  min="0.01"
                  max={Math.abs(Number(balances.find((balance) => balance._id === paymentRequestDraft.memberId && balance.currency === paymentRequestDraft.currency)?.netBalance || 0)).toFixed(2)}
                  step="0.01"
                  value={paymentRequestDraft.amount}
                  onChange={(event) => setPaymentRequestDraft((current) => ({ ...current, amount: event.target.value }))}
                  required
                />
              </label>
            </div>
            <label>Message (optional)
              <textarea value={paymentRequestDraft.note} onChange={(event) => setPaymentRequestDraft((current) => ({ ...current, note: event.target.value }))} maxLength="1000" rows="3" />
            </label>
            {paymentRequestError && <p className="error-message" role="alert">{paymentRequestError}</p>}
            <button className="submit-button" disabled={paymentRequestBusy}>{paymentRequestBusy ? 'Sending request…' : 'Send payment request'}</button>
          </form>
        </Modal>
      )}
      {settlementOpen && (
        <Modal title="Record a payment" onClose={() => setSettlementOpen(false)} className="settlement-modal">
          <form className="group-settlement-form" onSubmit={submitSettlement}>
            <p className="modal-help">Record a payment to someone shown in your balance or simplified settlement plan. The amount cannot exceed what you owe them.</p>
            <label>Paid to
              <select value={settlementDraft.payeeId} onChange={(event) => setSettlementDraft((current) => ({ ...current, payeeId: event.target.value }))} required>
                <option value="">Choose a group member</option>
                {(group.members || []).filter((member) => member._id !== user._id).map((member) => (
                  <option key={member._id} value={member._id}>{member.fullnamae || member.username} (@{member.username})</option>
                ))}
              </select>
            </label>
            <div className="group-settlement-amount-fields">
              <label>Currency
                <select value={settlementDraft.currency} onChange={(event) => setSettlementDraft((current) => ({ ...current, currency: event.target.value }))}>
                  {[...new Set(['INR', ...balances.map((balance) => balance.currency).filter(Boolean)])].map((currency) => <option key={currency}>{currency}</option>)}
                </select>
              </label>
              <label>Amount
                <input type="number" min="0.01" step="0.01" value={settlementDraft.amount} onChange={(event) => setSettlementDraft((current) => ({ ...current, amount: event.target.value }))} required />
              </label>
            </div>
            <label>Payment proof (optional)
              <input type="file" accept="image/*" onChange={(event) => setSettlementDraft((current) => ({ ...current, paymentProof: event.target.files?.[0] || null }))} />
            </label>
            <label>Note (optional)
              <textarea value={settlementDraft.note} onChange={(event) => setSettlementDraft((current) => ({ ...current, note: event.target.value }))} maxLength="1000" rows="3" />
            </label>
            {settlementSaveError && <p className="error-message" role="alert">{settlementSaveError}</p>}
            <button className="submit-button" disabled={settlementSaveBusy || !settlementDraft.payeeId}>{settlementSaveBusy ? 'Saving payment…' : 'Record payment'}</button>
          </form>
        </Modal>
      )}
    </div>
  );
}
function ExpenseDetails({ expense, group, members, userId, accessToken, onClose, onEdit, onDelete, onCommentAdded }) {
  const [comments, setComments] = useState(expense.comments || []);
  const [commentDraft, setCommentDraft] = useState('');
  const [commentBusy, setCommentBusy] = useState(false);
  const [commentError, setCommentError] = useState('');
  const [expenseActionError, setExpenseActionError] = useState('');
  const memberName = (id) => {
    const member = members.find((person) => person._id === id);
    return member?.fullnamae || member?.username || 'Group member';
  };
  useEffect(() => {
    setComments(expense.comments || []);
  }, [expense._id, expense.comments]);

  const postComment = async (event) => {
    event.preventDefault();
    const content = commentDraft.trim();
    if (!content) return;
    setCommentBusy(true);
    setCommentError('');
    try {
      const comment = await apiRequest(`/expenses/${expense._id}/comments`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ content }),
      });
      setComments((current) => [...current, comment]);
      setCommentDraft('');
      await onCommentAdded?.();
    } catch (error) {
      setCommentError(error.message);
    } finally {
      setCommentBusy(false);
    }
  };

  const deleteComment = async (commentId) => {
    setCommentError('');
    try {
      await apiRequest(`/expenses/comments/${commentId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      setComments((current) => current.filter((comment) => comment._id !== commentId));
      await onCommentAdded?.();
    } catch (error) {
      setCommentError(error.message);
    }
  };

  return (
    <div className="expense-details-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="expense-details-dialog" role="dialog" aria-modal="true" aria-labelledby="expense-details-title">
        <button className="modal-close" type="button" onClick={onClose} aria-label="Close expense details">×</button>
        <div className="expense-details-heading">
          <span className="expense-details-icon">{expenseCategories.find((category) => category.name === expense.category)?.icon || '🧾'}</span>
          <div>
            <p className="eyebrow">{group?.name || 'EXPENSE'}</p>
            <h2 id="expense-details-title">{expense.description}</h2>
            <strong>{expense.currency} {Number(expense.totalAmount).toFixed(2)}</strong>
            <span>Added by {expense.paidByName || expense.paidByUsername || 'a group member'} on {new Date(expense.createdAt).toLocaleDateString()}</span>
          </div>
        </div>
        <div className="expense-detail-actions">
          <button className="expense-edit-action" type="button" onClick={onEdit}>Edit expense</button>
          {onDelete && <button className="expense-delete-action" type="button" onClick={async () => {
            setExpenseActionError('');
            const deleted = await onDelete();
            if (typeof deleted === 'string') setExpenseActionError(deleted);
          }}>Delete expense</button>}
        </div>
        {expenseActionError && <p className="error-message" role="alert">{expenseActionError}</p>}
        <div className="expense-details-grid">
          <section>
            <h3>People and shares</h3>
            {(expense.splits || []).map((split) => (
              <div className="expense-details-split" key={split.userId}>
                <span>{split.userId === expense.paidBy ? 'Paid by' : 'Owes'} {memberName(split.userId)}</span>
                <strong>{expense.currency} {Number(split.amountOwed).toFixed(2)}</strong>
              </div>
            ))}
          </section>
          <section>
            <h3>Expense details</h3>
            <p>{expense.category || 'Uncategorized'}{expense.subcategory ? ` · ${expense.subcategory}` : ''}</p>
            <p>Split method: {(expense.splitStrategy || 'EQUAL').toLowerCase().replaceAll('_', ' ')}</p>
            {expense.note && <p>{expense.note}</p>}
            {expense.items?.map((item, index) => (
              <p key={`${expense._id}-detail-${index}`}>{item.description} · {expense.currency} {Number(item.amount).toFixed(2)}</p>
            ))}
            {expense.paymentProofUrl && <a className="expense-proof-link" href={expense.paymentProofUrl} target="_blank" rel="noreferrer">View payment proof</a>}
          </section>
        </div>
        <section className="expense-comments">
          <h3>Comments</h3>
          {comments.length ? (
            <div className="expense-comment-list">
              {comments.map((comment) => (
                <article className="expense-comment" key={comment._id}>
                  <div>
                    <strong>{comment.authorName || memberName(comment.userId)}</strong>
                    <time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time>
                    <p>{comment.content}</p>
                  </div>
                  {comment.userId === userId && (
                    <button type="button" aria-label="Delete your comment" onClick={() => deleteComment(comment._id)}>×</button>
                  )}
                </article>
              ))}
            </div>
          ) : <p className="expense-comments-empty">No comments yet. Add one for your group.</p>}
          <form className="expense-comment-form" onSubmit={postComment}>
            <label className="visually-hidden" htmlFor={`expense-comment-${expense._id}`}>Add a comment</label>
            <textarea
              id={`expense-comment-${expense._id}`}
              value={commentDraft}
              onChange={(event) => setCommentDraft(event.target.value)}
              maxLength="1000"
              rows="3"
              placeholder="Add a comment"
              required
            />
            {commentError && <p className="error-message" role="alert">{commentError}</p>}
            <button className="expense-edit-action" type="submit" disabled={commentBusy || !commentDraft.trim()}>
              {commentBusy ? 'Posting…' : 'Post'}
            </button>
          </form>
        </section>
      </section>
    </div>
  );
}
function GroupActivityList({
  transactions,
  userId,
  onOpenExpense,
  groups = [],
  onOpenGroup,
  onRespondToFriendRequest,
  friendBusy = false,
}) {
  const months = new Map();
  transactions.forEach((transaction) => {
    const date = new Date(transaction.createdAt);
    const key = `${date.getFullYear()}-${date.getMonth()}`;
    if (!months.has(key)) {
      months.set(key, {
        label: date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
        transactions: [],
      });
    }
    months.get(key).transactions.push(transaction);
  });

  return (
    <div className="group-activity-list">
      {[...months.entries()].map(([monthKey, month]) => (
        <section className="group-activity-month" key={monthKey}>
          <h4>{month.label}</h4>
          {month.transactions.map((transaction) => {
            const date = new Date(transaction.createdAt);
            if (transaction.feedType === 'notification') {
              const isPaymentRequest = transaction.notificationType === 'PAYMENT_REQUEST';
              const group = groups.find((item) => item._id === transaction.groupId);
              const canOpenGroup = Boolean(group && typeof onOpenGroup === 'function');
              return (
                <article
                  className={`group-activity-row group-activity-audit ${canOpenGroup ? 'group-activity-clickable' : ''}`}
                  key={`notification-${transaction._id}`}
                  role={canOpenGroup ? 'button' : undefined}
                  tabIndex={canOpenGroup ? 0 : undefined}
                  onClick={canOpenGroup ? () => onOpenGroup(group) : undefined}
                  onKeyDown={canOpenGroup ? (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onOpenGroup(group);
                    }
                  } : undefined}
                >
                  <div className="group-activity-date">
                    <span>{date.toLocaleDateString(undefined, { month: 'short' }).toUpperCase()}</span>
                    <strong>{date.getDate()}</strong>
                  </div>
                  <span className="group-activity-icon">{isPaymentRequest ? '↗' : '💸'}</span>
                  <div className="group-activity-description">
                    <strong>{transaction.message}</strong>
                    <small>{transaction.groupName || (isPaymentRequest ? 'PAYMENT REQUEST' : 'PAYMENT RECEIVED')}</small>
                  </div>
                  <span className="group-activity-update-label">{isPaymentRequest ? 'PAYMENT REQUEST' : 'PAYMENT RECEIVED'}</span>
                </article>
              );
            }
            if (transaction.feedType === 'friend-request') {
              const sender = transaction.senderName || transaction.senderUsername || 'A member';
              const canRespond = transaction.status === 'pending' && typeof onRespondToFriendRequest === 'function';
              return (
                <article className="group-activity-row group-activity-audit" key={`friend-request-${transaction._id}`}>
                  <div className="group-activity-date">
                    <span>{date.toLocaleDateString(undefined, { month: 'short' }).toUpperCase()}</span>
                    <strong>{date.getDate()}</strong>
                  </div>
                  <span className="group-activity-icon">＋</span>
                  <div className="group-activity-description">
                    <strong>{sender} sent you a friend request</strong>
                    <small>{transaction.status === 'pending' ? 'FRIEND REQUEST' : `FRIEND REQUEST ${transaction.status.toUpperCase()}`}</small>
                  </div>
                  {canRespond ? (
                    <div className="notification-actions">
                      <button type="button" disabled={friendBusy} onClick={() => onRespondToFriendRequest(transaction._id, 'accept')}>Accept</button>
                      <button type="button" disabled={friendBusy} onClick={() => onRespondToFriendRequest(transaction._id, 'decline')}>Decline</button>
                    </div>
                  ) : (
                    <span className="group-activity-update-label">{transaction.status.toUpperCase()}</span>
                  )}
                </article>
              );
            }
            if (transaction.type === 'ACTIVITY') {
              const activityIcon = transaction.activityType === 'EXPENSE_DELETED'
                ? '🗑'
                : transaction.activityType === 'EXPENSE_ADDED'
                  ? '＋'
                  : transaction.activityType === 'EXPENSE_UPDATED'
                    ? '✎'
                  : transaction.activityType === 'PAYMENT_REQUESTED'
                    ? '↗'
                  : transaction.activityType === 'COMMENT_ADDED'
                    ? '💬'
                  : transaction.activityType.startsWith('MEMBER_')
                    ? '👥'
                    : '↻';
              const activityLabel = ({
                EXPENSE_ADDED: 'NEW EXPENSE',
                EXPENSE_UPDATED: 'EXPENSE UPDATED',
                EXPENSE_DELETED: 'EXPENSE DELETED',
                COMMENT_ADDED: 'COMMENT ADDED',
                COMMENT_DELETED: 'COMMENT DELETED',
                MEMBER_ADDED: 'MEMBER ADDED',
                MEMBER_JOINED: 'MEMBER JOINED',
                MEMBER_REMOVED: 'MEMBER REMOVED',
                MEMBER_LEFT: 'MEMBER LEFT',
                GROUP_CREATED: 'GROUP CREATED',
                GROUP_SETTINGS_UPDATED: 'SETTINGS UPDATED',
                PAYMENT_REQUESTED: 'PAYMENT REQUESTED',
              })[transaction.activityType] || 'GROUP ACTIVITY';
              return (
                <article className={`group-activity-row group-activity-audit ${transaction.groupName ? 'with-group-name' : ''}`} key={`ACTIVITY-${transaction._id}`}>
                  <div className="group-activity-date">
                    <span>{date.toLocaleDateString(undefined, { month: 'short' }).toUpperCase()}</span>
                    <strong>{date.getDate()}</strong>
                  </div>
                  <span className="group-activity-icon">{activityIcon}</span>
                  <div className="group-activity-description">
                    <strong>{transaction.description}</strong>
                    <small>{transaction.details}</small>
                  </div>
                  {transaction.groupName && <span className="group-activity-group-name">{transaction.groupName}</span>}
                  <span className="group-activity-update-label">{activityLabel}</span>
                </article>
              );
            }
            const isSettlement = transaction.type === 'SETTLEMENT';
            const total = Number(transaction.totalAmount) || 0;
            const ownSplit = Number(transaction.splits?.find((split) => split.userId === userId)?.amountOwed || 0);
            const isPayer = transaction.paidBy === userId;
            const payerName = transaction.paidByName || transaction.paidByUsername || 'A member';
            let shareLabel = 'not involved';
            let shareAmount = null;
            let shareClass = 'not-involved';

            if (isSettlement && transaction.paidTo === userId) {
              shareLabel = `${payerName} paid you`;
              shareAmount = total;
              shareClass = 'activity-share-positive';
            } else if (!isSettlement && isPayer) {
              shareLabel = 'you lent';
              shareAmount = Math.max(0, total - ownSplit);
              shareClass = 'activity-share-positive';
            } else if (!isSettlement && ownSplit > 0) {
              shareLabel = `${payerName} lent you`;
              shareAmount = ownSplit;
              shareClass = 'activity-share-negative';
            } else if (isSettlement && isPayer) {
              shareLabel = `you paid ${transaction.paidToName || 'a member'}`;
              shareAmount = total;
              shareClass = 'activity-share-negative';
            }

            const categoryIcon = isSettlement
              ? '💸'
              : expenseCategories.find((category) => category.name === transaction.category)?.icon || '🧾';
            const canOpen = !isSettlement && typeof onOpenExpense === 'function';

            return (
              <article
                className={`group-activity-row ${canOpen ? 'group-activity-clickable' : ''}`}
                key={`${transaction.type}-${transaction._id}`}
                role={canOpen ? 'button' : undefined}
                tabIndex={canOpen ? 0 : undefined}
                onClick={canOpen ? () => onOpenExpense(transaction) : undefined}
                onKeyDown={canOpen ? (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onOpenExpense(transaction);
                  }
                } : undefined}
              >
                <div className="group-activity-date">
                  <span>{date.toLocaleDateString(undefined, { month: 'short' }).toUpperCase()}</span>
                  <strong>{date.getDate()}</strong>
                </div>
                <span className={`group-activity-icon ${transaction.category === 'Transportation' ? 'transport' : ''} ${transaction.category === 'Food and drink' ? 'food' : ''}`}>
                  {categoryIcon}
                </span>
                <div className="group-activity-description">
                  <strong>{transaction.description}</strong>
                  {(transaction.note || transaction.comments?.length > 0) && <span className="group-activity-comment" aria-label="Has a note or comments">●</span>}
                  <small>
                    {transaction.groupName ? `${transaction.groupName} · ` : ''}
                    {transaction.category || 'Uncategorized'}
                    {transaction.subcategory ? ` · ${transaction.subcategory}` : ''}
                    {isSettlement ? ` · ${payerName} paid ${transaction.paidToName || 'a member'}` : ''}
                  </small>
                  {transaction.paymentProofUrl && (
                    <a
                      className="expense-proof-link"
                      href={transaction.paymentProofUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => event.stopPropagation()}
                    >View receipt</a>
                  )}
                </div>
                <div className="group-activity-amount">
                  <span>{isPayer ? 'you paid' : `${payerName} paid`}</span>
                  <strong>{transaction.currency} {total.toFixed(2)}</strong>
                </div>
                <div className={`group-activity-share ${shareClass}`}>
                  <span>{shareLabel}</span>
                  {shareAmount === null
                    ? <small>not involved</small>
                    : <strong>{transaction.currency} {shareAmount.toFixed(2)}</strong>}
                </div>
              </article>
            );
          })}
        </section>
      ))}
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
    <div className={`modal-backdrop ${className}`} onMouseDown={(event) => {
      event.stopPropagation();
      if (event.target === event.currentTarget) onClose();
    }}>
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
