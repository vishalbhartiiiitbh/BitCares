import { useEffect, useRef, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";

const API_URL = `${import.meta.env.VITE_API_URL}/api` || "/api";
const emptyForm = { username: "", email: "", fullnamae: "", password: "" };
const defaultEmailNotificationPreferences = {
  groupAdded: false,
  friendAdded: false,
  expenseAdded: false,
  expenseChanged: false,
  expenseComment: false,
  expenseDue: false,
  paymentReceived: false,
  monthlySummary: false,
  productUpdates: false,
};

// Keep multipart uploads browser-managed so their boundary is included in the request.
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
    // Hand out leftover cents in participant order so every item is fully allocated.
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
  // Use integer cents so default equal splits don't lose fractions to floating-point rounding.
  const totalCents = Math.round((Number(totalAmount) || 0) * 100);
  const share = Math.floor(totalCents / participants.length);
  let remainder = totalCents - share * participants.length;
  participants.forEach((id) => {
    defaults[id] = ((share + (remainder > 0 ? 1 : 0)) / 100).toFixed(2);
    if (remainder > 0) remainder -= 1;
  });
  return defaults;
}

function getExpenseMonthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function SpendingInsights({ transactions, members, userId, personalOnly = false, balanceSummary = null, balanceSummaryBusy = false, scopeLabel = 'GROUP SPENDING' }) {
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
  // Keep the latest month selected if the previous selection disappears after refreshed data.
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
  members.forEach((member) => memberById.set(
    member._id,
    personalOnly && member._id === userId ? 'You' : member.fullnamae || member.username,
  ));
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
  const getUserExpenseShare = (expense) => {
    const share = expense.splits?.find((split) => split.userId === userId)?.amountOwed;
    return Number.isFinite(Number(share)) ? Number(share) : 0;
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
  // Paid totals describe who covered the bill; share totals below describe who consumed it.
  const owesPieData = personalOnly
    ? (balanceSummary?.outgoingBalances || []).map((balance) => ({
      id: balance.id,
      name: balance.name,
      amount: Number(balance.youOwe),
    }))
    : paidData;
  const owesPieTotal = owesPieData.reduce((total, entry) => total + entry.amount, 0);
  const shareTotals = new Map();
  const dailyTotals = new Map();
  const dailyMemberTotals = new Map();
  selectedExpenses.forEach((expense) => {
    addExpenseShares(shareTotals, expense);
    const day = new Date(expense.createdAt).getDate();
    dailyTotals.set(day, (dailyTotals.get(day) || 0) + getUserExpenseShare(expense));
    const dayMemberTotals = dailyMemberTotals.get(day) || new Map();
    addExpenseShares(dayMemberTotals, expense);
    dailyMemberTotals.set(day, dayMemberTotals);
  });
  const pieData = payers
    .map((payer) => ({ ...payer, amount: shareTotals.get(payer.id) || 0 }))
    .filter((payer) => payer.amount > 0);
  const monthTotal = pieData.reduce((total, payer) => total + payer.amount, 0);
  const owedPieData = personalOnly
    ? (balanceSummary?.incomingBalances || []).map((balance) => ({
      id: balance.id,
      name: balance.name,
      amount: Number(balance.youAreOwed),
    }))
    : pieData;
  const owesColorById = new Map(owesPieData.map((entry, index) => [
    entry.id,
    personalOnly ? colors[index % colors.length] : colorById.get(entry.id),
  ]));
  const owedColorById = new Map(owedPieData.map((entry, index) => [
    entry.id,
    personalOnly ? colors[index % colors.length] : colorById.get(entry.id),
  ]));
  const owedPieTotal = owedPieData.reduce((total, entry) => total + entry.amount, 0);
  const pieCurrency = personalOnly ? balanceSummary?.currency || 'INR' : activeCurrency;
  const pieRadius = 62;
  const pieCircumference = 2 * Math.PI * pieRadius;
  let pieOffset = 0;
  let sharePieOffset = 0;
  const selectedMonthDate = activeMonth
    ? new Date(Number(activeMonth.slice(0, 4)), Number(activeMonth.slice(5, 7)) - 1, 1)
    : new Date();
  const daysInMonth = new Date(selectedMonthDate.getFullYear(), selectedMonthDate.getMonth() + 1, 0).getDate();
  const monthlyKeys = monthKeys.slice(-6);
  const monthlyTotals = new Map();
  const monthlyMemberTotals = new Map();
  expenses.filter((expense) => (expense.currency || 'INR') === activeCurrency).forEach((expense) => {
    const monthKey = getExpenseMonthKey(new Date(expense.createdAt));
    monthlyTotals.set(monthKey, (monthlyTotals.get(monthKey) || 0) + getUserExpenseShare(expense));
    const monthMemberTotals = monthlyMemberTotals.get(monthKey) || new Map();
    addExpenseShares(monthMemberTotals, expense);
    monthlyMemberTotals.set(monthKey, monthMemberTotals);
  });
  const monthlyPayers = payers.filter((payer) => monthlyKeys.some((key) => (monthlyMemberTotals.get(key)?.get(payer.id) || 0) > 0));
  const monthlyTotalFor = (key) => personalOnly
    ? monthlyTotals.get(key) || 0
    : [...(monthlyMemberTotals.get(key)?.values() || [])].reduce((sum, amount) => sum + amount, 0);
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
  const maxDailyAmount = Math.max(
    ...(personalOnly
      ? [...dailyTotals.values()]
      : [...dailyMemberTotals.values()].flatMap((totals) => [...totals.values()])),
    1,
  );
  const userName = personalOnly ? 'You' : memberById.get(userId) || 'You';
  const userColor = colorById.get(userId) || '#4eaa89';

  return (
    <section className="spending-insights">
      <div className="spending-insights-heading">
        <div><p className="eyebrow">{scopeLabel}</p><h3>Monthly spending insights</h3></div>
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
        <p className="empty-state">Add expenses to see monthly spending charts.</p>
      ) : (
        <>
          <div className="spending-insights-summary">
            <div className="spending-chart-card spending-pie-card">
              <div className="spending-chart-title">
                <div>
                  <h4>{personalOnly ? 'You owe' : 'Who paid this month'}</h4>
                  <p>{personalOnly ? 'Across all groups and friends' : monthOptions.find((month) => month.key === activeMonth)?.label}</p>
                </div>
                <strong className={personalOnly ? 'spending-amount-owed' : ''}>{pieCurrency} {formatAmount(personalOnly ? owesPieTotal : paidTotal)}</strong>
              </div>
              {owesPieData.length ? (
                <div className="spending-pie-layout">
                  <svg className="spending-pie" viewBox="0 0 160 160" role="img" aria-label={personalOnly ? 'Amount you owe by group and friend' : `Amount paid by each member for ${activeMonth}`}>
                    <circle cx="80" cy="80" r={pieRadius} fill="none" stroke="#edf0ec" strokeWidth="22" />
                    {/* Each segment starts where the previous one ended around the ring. */}
                    {owesPieData.map((payer) => {
                      const segment = (payer.amount / (personalOnly ? owesPieTotal : paidTotal)) * pieCircumference;
                      const circle = (
                        <circle
                          key={payer.id}
                          cx="80"
                          cy="80"
                          r={pieRadius}
                          fill="none"
                          stroke={owesColorById.get(payer.id)}
                          strokeWidth="22"
                          strokeDasharray={`${segment} ${pieCircumference - segment}`}
                          strokeDashoffset={-pieOffset}
                          transform="rotate(-90 80 80)"
                        >
                          <title>{personalOnly ? `You owe ${payer.name}` : `${payer.name} paid`}: {pieCurrency} {formatAmount(payer.amount)}</title>
                        </circle>
                      );
                      pieOffset += segment;
                      return circle;
                    })}
                    <text x="80" y="76" textAnchor="middle" className="spending-pie-total">{pieCurrency}</text>
                    <text x="80" y="96" textAnchor="middle" className={`spending-pie-amount ${personalOnly ? 'spending-amount-owed' : ''}`}>{formatAmount(personalOnly ? owesPieTotal : paidTotal)}</text>
                  </svg>
                  <ul className="spending-payer-legend">
                    {owesPieData.map((payer) => (
                      <li key={payer.id}>
                        <span style={{ '--payer-color': owesColorById.get(payer.id) }} />
                        <div><strong>{payer.name}</strong><small>{Math.round((payer.amount / (personalOnly ? owesPieTotal : paidTotal)) * 100)}%</small></div>
                        <b className={personalOnly ? 'spending-amount-owed' : ''}>{pieCurrency} {formatAmount(payer.amount)}</b>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : <p className="empty-state">{personalOnly
                ? balanceSummaryBusy ? 'Loading balances…' : balanceSummary ? 'You do not owe anyone right now.' : 'Your balances are not available.'
                : `No expenses for this month in ${activeCurrency}.`}</p>}
            </div>
            <div className="spending-chart-card spending-pie-card">
              <div className="spending-chart-title">
                <div>
                  <h4>{personalOnly ? 'You are owed' : 'Expense share by person'}</h4>
                  <p>{personalOnly ? 'Across all groups and friends' : monthOptions.find((month) => month.key === activeMonth)?.label}</p>
                </div>
                <strong>{pieCurrency} {formatAmount(personalOnly ? owedPieTotal : monthTotal)}</strong>
              </div>
              {owedPieData.length ? (
                <div className="spending-pie-layout">
                  <svg className="spending-pie" viewBox="0 0 160 160" role="img" aria-label={personalOnly ? 'Amount others owe you by group and friend' : `Expense share by person for ${activeMonth}`}>
                    <circle cx="80" cy="80" r={pieRadius} fill="none" stroke="#edf0ec" strokeWidth="22" />
                    {owedPieData.map((payer) => {
                      const segment = (payer.amount / (personalOnly ? owedPieTotal : monthTotal)) * pieCircumference;
                      const circle = (
                        <circle
                          key={payer.id}
                          cx="80"
                          cy="80"
                          r={pieRadius}
                          fill="none"
                          stroke={owedColorById.get(payer.id)}
                          strokeWidth="22"
                          strokeDasharray={`${segment} ${pieCircumference - segment}`}
                          strokeDashoffset={-sharePieOffset}
                          transform="rotate(-90 80 80)"
                        >
                          <title>{personalOnly ? `${payer.name} owes you` : `${payer.name}'s expense share`}: {pieCurrency} {formatAmount(payer.amount)}</title>
                        </circle>
                      );
                      sharePieOffset += segment;
                      return circle;
                    })}
                    <text x="80" y="76" textAnchor="middle" className="spending-pie-total">{pieCurrency}</text>
                    <text x="80" y="96" textAnchor="middle" className="spending-pie-amount">{formatAmount(personalOnly ? owedPieTotal : monthTotal)}</text>
                  </svg>
                  <ul className="spending-payer-legend">
                    {owedPieData.map((payer) => (
                      <li key={payer.id}>
                        <span style={{ '--payer-color': owedColorById.get(payer.id) }} />
                        <div><strong>{payer.name}</strong><small>{Math.round((payer.amount / (personalOnly ? owedPieTotal : monthTotal)) * 100)}%</small></div>
                        <b>{pieCurrency} {formatAmount(payer.amount)}</b>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : <p className="empty-state">{personalOnly
                ? balanceSummaryBusy ? 'Loading balances…' : balanceSummary ? 'Nobody owes you right now.' : 'Your balances are not available.'
                : `No expense shares for this month in ${activeCurrency}.`}</p>}
            </div>
            <div className="spending-chart-card spending-daily-card spending-chart-wide">
              <div className="spending-chart-title">
                <div>
                  <h4>{personalOnly ? 'Your daily spending' : 'Daily spending'}</h4>
                  <p>{personalOnly
                    ? `Your share across group and friend expenses · ${monthOptions.find((month) => month.key === activeMonth)?.label}`
                    : `Each day of ${monthOptions.find((month) => month.key === activeMonth)?.label}`}</p>
                </div>
              </div>
              <div className="spending-daily-scroll">
                <svg
                  className="spending-daily-chart"
                  viewBox={`0 0 ${Math.max(680, daysInMonth * 28)} 210`}
                  role="img"
                  aria-label={`${personalOnly ? 'Your daily expense share' : 'Daily group expense shares'} during ${activeMonth}`}
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
                    const amount = dailyTotals.get(day) || 0;
                    const dayMemberTotals = dailyMemberTotals.get(day) || new Map();
                    const barWidth = Math.max(3, Math.min(8, 17 / Math.max(pieData.length, 1)));
                    return (
                      <g
                        key={day}
                        className="spending-chart-selection"
                        onMouseEnter={() => setHoveredDay(day)}
                        onMouseLeave={() => setHoveredDay(null)}
                      >
                        {(visibleDay === day) && <rect className="spending-selection-band" x={x - 2} y="26" width={daySlot} height="142" />}
                        {personalOnly
                          ? amount > 0 && (() => {
                            const height = (amount / maxDailyAmount) * 132;
                            return <rect x={x + daySlot / 2 - 5} y={166 - height} width="10" height={height} rx="2" fill={userColor}><title>Day {day} · your share: {activeCurrency} {formatAmount(amount)}</title></rect>;
                          })()
                          : pieData.map((payer, payerIndex) => {
                            const value = dayMemberTotals.get(payer.id) || 0;
                            const height = (value / maxDailyAmount) * 132;
                            return value > 0 ? (
                              <rect key={payer.id} x={x + payerIndex * (barWidth + 1)} y={166 - height} width={barWidth} height={height} rx="2" fill={colorById.get(payer.id)}>
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
                          aria-label={personalOnly
                            ? `Day ${day}, your expense share ${activeCurrency} ${formatAmount(amount)}. Click to pin details.`
                            : `Day ${day}, total group shares ${activeCurrency} ${formatAmount([...dayMemberTotals.values()].reduce((sum, value) => sum + value, 0))}. Click to pin details.`}
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
                  <div><strong>{monthOptions.find((month) => month.key === activeMonth)?.label} {visibleDay}</strong><b>{activeCurrency} {formatAmount(personalOnly
                    ? dailyTotals.get(visibleDay) || 0
                    : [...(dailyMemberTotals.get(visibleDay)?.values() || [])].reduce((sum, value) => sum + value, 0))}</b></div>
                  {personalOnly
                    ? <p><span style={{ color: userColor }}>{userName} · your share</span><strong>{activeCurrency} {formatAmount(dailyTotals.get(visibleDay) || 0)}</strong></p>
                    : pieData.map((payer) => <p key={payer.id}><span style={{ color: colorById.get(payer.id) }}>{payer.name}</span><strong>{activeCurrency} {formatAmount(dailyMemberTotals.get(visibleDay)?.get(payer.id) || 0)}</strong></p>)}
                </div>
              )}
              <p className="spending-axis-caption">{personalOnly
                ? 'Day of month · your expense share across all groups and friends'
                : 'Day of month · each member’s actual expense share'}</p>
              {personalOnly
                ? <div className="spending-chart-legend"><span className="spending-average-label"><i style={{ background: userColor, height: 8, width: 8, borderRadius: 2 }} />{userName} · your share</span></div>
                : <SpendingLegend payers={pieData} colorById={colorById} />}
            </div>
          </div>
          <div className="spending-chart-card spending-monthly-card">
            <div className="spending-chart-title">
              <div>
                <h4>{personalOnly ? 'Your monthly expenditure' : 'Monthly expenditure'}</h4>
                <p>{personalOnly
                  ? `Your share across all groups and friends · last ${monthlyKeys.length} months`
                  : `Amount paid by each member · last ${monthlyKeys.length} months`}</p>
              </div>
              <strong>{activeCurrency}</strong>
            </div>
            {monthlyKeys.length ? (
              <>
                <div className="spending-monthly-scroll">
                  <div className="spending-monthly-chart-wrap">
                    <svg className="spending-monthly-chart" viewBox="0 0 740 260" role="img" aria-label={personalOnly ? 'Your monthly expense share across all groups and friends' : 'Monthly actual expense share by group member'}>
                    {[0, 1, 2, 3].map((tick) => {
                      const value = maximumMonthly * (3 - tick) / 3;
                      const y = chart.bottom - (value / maximumMonthly) * chartHeight;
                      return <g key={tick}><line x1={chart.left} x2={chart.right} y1={y} y2={y} /><text x={chart.left - 8} y={y + 4} textAnchor="end">{formatAmount(value)}</text></g>;
                    })}
                    {monthlyKeys.map((key, monthIndex) => {
                      const xCenter = chart.left + monthlySlot * monthIndex + monthlySlot / 2;
                      const total = monthlyTotalFor(key);
                      const totalsByMember = monthlyMemberTotals.get(key) || new Map();
                      const plottedPayers = monthlyPayers.filter((payer) => (totalsByMember.get(payer.id) || 0) > 0);
                      const groupWidth = plottedPayers.length * payerBarWidth;
                      return (
                        <g
                          key={key}
                          className="spending-chart-selection"
                          onMouseEnter={() => setHoveredMonth(key)}
                          onMouseLeave={() => setHoveredMonth('')}
                        >
                          {visibleMonth === key && <rect className="spending-selection-band" x={chart.left + monthlySlot * monthIndex} y={chart.top} width={monthlySlot} height={chart.bottom - chart.top} />}
                          {personalOnly
                            ? total > 0 && <rect x={xCenter - 12} y={chart.bottom - (total / maximumMonthly) * chartHeight} width="24" height={(total / maximumMonthly) * chartHeight} rx="3" fill={userColor}><title>{monthLabel(key)} · your expense share: {activeCurrency} {formatAmount(total)}</title></rect>
                            : plottedPayers.map((payer, payerIndex) => {
                              const amount = totalsByMember.get(payer.id) || 0;
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
                            aria-label={personalOnly
                              ? `${monthLabel(key)} your expense share ${activeCurrency} ${formatAmount(total)}. Click to pin details.`
                              : `${monthLabel(key)} total actual expense share ${activeCurrency} ${formatAmount(total)}. Click to pin details.`}
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
                        {personalOnly
                          ? <p><span style={{ color: userColor }}>{userName} · your share</span><strong>{activeCurrency} {formatAmount(monthlyTotalFor(visibleMonth))}</strong></p>
                          : monthlyPayers.map((payer) => <p key={payer.id}><span style={{ color: colorById.get(payer.id) }}>{payer.name}</span><strong>{activeCurrency} {formatAmount(monthlyMemberTotals.get(visibleMonth)?.get(payer.id) || 0)}</strong></p>)}
                      </div>
                    )}
                  </div>
                </div>
                <div className="spending-chart-legend">
                  {personalOnly
                    ? <span className="spending-average-label"><i style={{ background: userColor, height: 8, width: 8, borderRadius: 2 }} />{userName} · your share</span>
                    : <SpendingLegend payers={monthlyPayers} colorById={colorById} />}
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
  const [resetToken, setResetToken] = useState(() => new URLSearchParams(window.location.search).get("resetToken") || "");
  const [friendInviteCode, setFriendInviteCode] = useState(() => new URLSearchParams(window.location.search).get("friendCode") || "");
  const [referralCode, setReferralCode] = useState(() => new URLSearchParams(window.location.search).get("referralCode") || "");
  const [referrerUsername, setReferrerUsername] = useState(() => new URLSearchParams(window.location.search).get("referrerUsername") || "");
  const [mode, setMode] = useState(() => resetToken ? "reset" : "login");
  const [showAuth, setShowAuth] = useState(() => Boolean(resetToken));
  const [form, setForm] = useState(emptyForm);
  const [user, setUser] = useState(null);
  const [accessToken, setAccessToken] = useState("");
  const [message, setMessage] = useState("");
  const [messageIsSuccess, setMessageIsSuccess] = useState(false);
  const [busy, setBusy] = useState(false);
  const [registrationCode, setRegistrationCode] = useState("");
  const [registrationCodeSent, setRegistrationCodeSent] = useState(false);
  const [verifiedEmailToken, setVerifiedEmailToken] = useState("");
  const [registrationReferralMessage, setRegistrationReferralMessage] = useState("");

  useEffect(() => {
    const isPrivateView = Boolean(user || showAuth);
    document.title = user
      ? "SplitCare | Shared expenses"
      : showAuth
        ? `${mode === "reset" ? "Reset your password" : mode === "register" ? "Create an account" : "Sign in"} | SplitCare`
        : "SplitCare | Shared expenses, handled";
    document.querySelector('meta[name="robots"]')?.setAttribute(
      "content",
      isPrivateView ? "noindex, nofollow" : "index, follow, max-image-preview:large",
    );
  }, [mode, showAuth, user]);

  const markFriendInviteHandled = () => {
    setFriendInviteCode('');
    const url = new URL(window.location.href);
    url.searchParams.delete('friendCode');
    url.searchParams.delete('referralCode');
    url.searchParams.delete('referrerUsername');
    setReferralCode('');
    setReferrerUsername('');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  };

  const openAuth = (nextMode) => {
    setMode(nextMode);
    setMessage("");
    setShowAuth(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  useEffect(() => {
    if (mode === "reset") {
      const url = new URL(window.location.href);
      url.searchParams.delete("resetToken");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      return;
    }
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
    if (event.target.name === "email" && mode === "register") {
      setRegistrationCode("");
      setRegistrationCodeSent(false);
      setVerifiedEmailToken("");
    }
    setMessage("");
    setMessageIsSuccess(false);
  };

  const verifyRegistrationEmail = async () => {
    setBusy(true);
    setMessage("");
    setMessageIsSuccess(false);
    try {
      if (!registrationCodeSent) {
        const data = await apiRequest("/users/register/send-code", {
          method: "POST",
          body: JSON.stringify({ email: form.email }),
        });
        setRegistrationCodeSent(true);
        setMessage(data.message);
        setMessageIsSuccess(true);
        return;
      }
      const data = await apiRequest("/users/register/verify-code", {
        method: "POST",
        body: JSON.stringify({ email: form.email, code: registrationCode }),
      });
      setVerifiedEmailToken(data.verificationToken);
      setMessage("Email verified. You can create your account now.");
      setMessageIsSuccess(true);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    setMessageIsSuccess(false);
    try {
      if (mode === "forgot") {
        const data = await apiRequest("/users/forgot-password", {
          method: "POST",
          body: JSON.stringify({ email: form.email }),
        });
        setMessage(data.message);
        setMessageIsSuccess(true);
        return;
      }
      if (mode === "reset") {
        const data = await apiRequest("/users/reset-password", {
          method: "POST",
          body: JSON.stringify({ token: resetToken, password: form.password }),
        });
        setResetToken("");
        window.history.replaceState(null, "", window.location.pathname);
        setMode("login");
        setForm(emptyForm);
        setMessage(data.message);
        setMessageIsSuccess(true);
        return;
      }
      if (mode === "register" && !verifiedEmailToken) {
        setMessage(registrationCodeSent
          ? "Enter the code from your email and select Verify email code."
          : "Send an email verification code before creating your account.");
        return;
      }

      const body = mode === "register"
        ? {
          ...form,
          verificationToken: verifiedEmailToken,
          ...(referralCode ? { referralCode, referrerUsername } : {}),
        }
        : { email: form.email, password: form.password };
      const data = await apiRequest(`/users/${mode}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setUser(data.user);
      setAccessToken(data.accessToken);
      if (mode === "register" && data.referralMessage) {
        setRegistrationReferralMessage(data.referralMessage);
      }
      if (mode === "register" && (referralCode || referrerUsername)) markFriendInviteHandled();
      setForm(emptyForm);
      setRegistrationCode("");
      setRegistrationCodeSent(false);
      setVerifiedEmailToken("");
    } catch (error) {
      setMessage(error.message);
      if (mode === "register" && error.message.includes("Verify your email")) {
        setVerifiedEmailToken("");
        setRegistrationCodeSent(false);
        setRegistrationCode("");
      }
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

  const accountDeleted = () => {
    setUser(null);
    setAccessToken("");
    setForm(emptyForm);
    setMode("login");
    setMessage("Your account and associated data have been permanently deleted.");
    setMessageIsSuccess(true);
  };

  if (user)
    return (
      <Dashboard
        user={user}
        accessToken={accessToken}
        onLogout={signOut}
        onProfileUpdated={setUser}
        onAccountDeleted={accountDeleted}
        friendInviteCode={friendInviteCode}
        onFriendInviteHandled={markFriendInviteHandled}
        referralMessage={registrationReferralMessage}
        referralCode={referralCode}
      />
    );

  if (!showAuth) {
    return (
      <main className="public-landing">
        <header className="landing-nav">
          <Brand />
          <nav aria-label="Main navigation">
            <a href="#how-it-works">How it works</a>
            <a href="#features">Why SplitCare</a>
          </nav>
          <div className="landing-nav-actions">
            <button className="landing-login" type="button" onClick={() => openAuth("login")}>Log in</button>
            <button className="landing-signup" type="button" onClick={() => openAuth("register")}>Get started <span aria-hidden="true">↗</span></button>
          </div>
        </header>

        {(friendInviteCode || referralCode) && (
          <div className="landing-invite-banner" role="status">
            {referralCode
              ? `You’ve been invited by ${referrerUsername || "a SplitCare user"}. Sign up to connect and earn 10 points.`
              : "You’ve been invited to connect on SplitCare. Sign in or create an account to continue."}
          </div>
        )}

        <section className="landing-hero">
          <div className="landing-hero-copy">
            <p className="landing-eyebrow"><span /> Shared expenses, handled</p>
            <h1>Good times.<br /><span>Clear splits.</span></h1>
            <p className="landing-hero-lede">Split group expenses, keep tabs on balances, and settle up without the awkward back-and-forth.</p>
            <div className="landing-hero-actions">
              <button className="landing-signup landing-primary-cta" type="button" onClick={() => openAuth("register")}>
                Create your free account <span aria-hidden="true">↗</span>
              </button>
              <button className="landing-secondary-cta" type="button" onClick={() => openAuth("login")}>I already have an account</button>
            </div>
            <div className="landing-trust-note"><span aria-hidden="true">✓</span> Keep shared spending clear, simple, and in one place.</div>
          </div>

          <div className="landing-hero-art" aria-label="Example SplitCare group balance overview">
            <div className="landing-orbit landing-orbit-one" />
            <div className="landing-orbit landing-orbit-two" />
            <div className="landing-balance-card">
              <div className="landing-card-topline">
                <span className="landing-card-icon">÷</span>
                <span>WEEKEND IN LISBON <i>·</i> 4 MEMBERS</span>
                <span className="landing-menu-dots">•••</span>
              </div>
              <div className="landing-trip-heading">
                <div>
                  <span className="landing-card-caption">GROUP BALANCE</span>
                  <h2>Everyone, even.</h2>
                </div>
                <span className="landing-settled-badge"><i /> On track</span>
              </div>
              <div className="landing-balance-total">
                <span>Shared spending</span>
                <strong>$1,248.50</strong>
              </div>
              <div className="landing-balance-rule"><span /></div>
              <div className="landing-person-row">
                <span className="landing-person-avatar landing-avatar-lime">A</span>
                <span className="landing-person-name">Alex Morgan<small>Paid for dinner</small></span>
                <span className="landing-person-amount">+$86.40</span>
              </div>
              <div className="landing-person-row">
                <span className="landing-person-avatar landing-avatar-peach">J</span>
                <span className="landing-person-name">Jamie Lee<small>Settled up</small></span>
                <span className="landing-person-amount landing-paid">✓ Paid</span>
              </div>
              <div className="landing-person-row">
                <span className="landing-person-avatar landing-avatar-blue">S</span>
                <span className="landing-person-name">Sam Rivera<small>Added a taxi</small></span>
                <span className="landing-person-amount">−$24.10</span>
              </div>
              <div className="landing-card-footer"><span>Everything adds up.</span><span>JUST NOW <i>↗</i></span></div>
            </div>
            <div className="landing-float-note"><span>✳</span><div><strong>All settled.</strong><small>Friendships intact.</small></div></div>
            <div className="landing-art-stamp">LESS MATHS<br />MORE MOMENTS</div>
          </div>
          <div className="landing-hero-index"><span>01</span><i /> SPLIT SMARTER, LIVE LIGHTER</div>
        </section>

        <section className="landing-how" id="how-it-works">
          <div className="landing-section-heading">
            <p className="landing-eyebrow">A LITTLE LESS “WHO OWES WHAT?”</p>
            <h2>Shared plans.<br /><span>Sorted simply.</span></h2>
          </div>
          <div className="landing-how-steps">
            <article><span>01</span><h3>Bring your people</h3><p>Create a group for a trip, a home, or anything you share.</p></article>
            <article><span>02</span><h3>Add what you spend</h3><p>Log expenses and split them fairly between the right people.</p></article>
            <article><span>03</span><h3>Settle with clarity</h3><p>See who owes what and keep every payment easy to follow.</p></article>
          </div>
        </section>

        <section className="landing-features" id="features">
          <div>
            <p className="landing-eyebrow">MADE FOR REAL LIFE</p>
            <h2>Money stuff,<br />without the <span>mess.</span></h2>
          </div>
          <div className="landing-feature-grid">
            <article><span>↗</span><h3>Groups that make sense</h3><p>Keep trips, households, and shared plans organized together.</p></article>
            <article><span>◎</span><h3>Balances at a glance</h3><p>Know where everyone stands, without chasing receipts.</p></article>
            <article><span>↔</span><h3>Flexible fair splits</h3><p>Split evenly or record the exact amounts each person owes.</p></article>
            <article><span>✓</span><h3>Clearer settling up</h3><p>Track payments and keep a shared history everyone can see.</p></article>
          </div>
        </section>

        <section className="landing-bottom-cta">
          <div><p className="landing-eyebrow">THE NEXT ROUND’S ON YOU (OR NOT)</p><h2>Make shared spending<br />the easy part.</h2></div>
          <button className="landing-signup landing-primary-cta" type="button" onClick={() => openAuth("register")}>Get started for free <span aria-hidden="true">↗</span></button>
        </section>

        <footer className="landing-footer">
          <Brand />
          <span>Shared money, less friction.</span>
          <button type="button" onClick={() => openAuth("login")}>Log in to SplitCare <span aria-hidden="true">↗</span></button>
        </footer>
      </main>
    );
  }

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
          {mode !== "reset" && <button className="auth-back-home" type="button" onClick={() => setShowAuth(false)}>← Back to home</button>}
          {(friendInviteCode || referralCode) && <p className="friend-page-message" role="status">
            {referralCode
              ? `You were invited by ${referrerUsername || 'a SplitCare user'}. Create an account to receive 10 referral points and add them as a friend.`
              : 'Sign in or create an account to connect with the person who shared this friend link.'}
          </p>}
          {(mode === "login" || mode === "register") && <div className="mode-tabs" role="tablist">
            <button
              className={mode === "login" ? "selected" : ""}
              onClick={() => {
                setMode("login");
                setMessage("");
                setRegistrationCode("");
                setRegistrationCodeSent(false);
                setVerifiedEmailToken("");
              }}
            >
              Sign in
            </button>
            <button
              className={mode === "register" ? "selected" : ""}
              onClick={() => {
                setMode("register");
                setMessage("");
                setRegistrationCode("");
                setRegistrationCodeSent(false);
                setVerifiedEmailToken("");
              }}
            >
              Create account
            </button>
          </div>}
          <p className="eyebrow">
            {mode === "login" ? "Welcome back" : mode === "register" ? "Start a group" : mode === "forgot" ? "Account recovery" : "Choose a new password"}
          </p>
          <h2>
            {mode === "login" ? "Good to see you." : mode === "register" ? "Let’s split smarter." : mode === "forgot" ? "Forgot your password?" : "Reset your password."}
          </h2>
          <p className="form-intro">
            {mode === "login"
              ? "Pick up where your shared plans left off."
              : mode === "register"
                ? "Set up your account and bring your people together."
                : mode === "forgot"
                  ? "Enter your email and we’ll send a password reset link if an account is registered."
                  : "Choose a new password. This link can only be used once and expires after 10 minutes."}
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
            {mode !== "reset" && <label>
              Email
              <input
                name="email"
                type="email"
                value={form.email}
                onChange={updateField}
                placeholder="alex@example.com"
                required
              />
            </label>}
            {mode !== "forgot" && <label>
              {mode === "reset" ? "New password" : "Password"}
              <input
                name="password"
                type="password"
                value={form.password}
                onChange={updateField}
                placeholder="8 characters minimum"
                minLength="8"
                required
              />
            </label>}
            {mode === "register" && (
              <>
                {registrationCodeSent && !verifiedEmailToken && (
                  <label>
                    Email verification code
                    <input
                      name="registrationCode"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={registrationCode}
                      onChange={(event) => setRegistrationCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                      placeholder="6-digit code"
                      minLength="6"
                      maxLength="6"
                      required
                    />
                  </label>
                )}
                {!verifiedEmailToken && (
                  <button className="text-button" type="button" onClick={verifyRegistrationEmail} disabled={busy || (registrationCodeSent && registrationCode.length !== 6)}>
                    {busy ? "Please wait…" : registrationCodeSent ? "Verify email code" : "Send email verification code"}
                  </button>
                )}
                {registrationCodeSent && !verifiedEmailToken && (
                  <button
                    className="text-button"
                    type="button"
                    onClick={async () => {
                      setBusy(true);
                      setMessage("");
                      try {
                        const data = await apiRequest("/users/register/send-code", {
                          method: "POST",
                          body: JSON.stringify({ email: form.email }),
                        });
                        setRegistrationCode("");
                        setMessage(data.message);
                        setMessageIsSuccess(true);
                      } catch (error) {
                        setMessage(error.message);
                        setMessageIsSuccess(false);
                      } finally {
                        setBusy(false);
                      }
                    }}
                    disabled={busy}
                  >
                    Resend code
                  </button>
                )}
                {verifiedEmailToken && <p className="success-message">Email verified.</p>}
              </>
            )}
            {message && <p className={messageIsSuccess ? "success-message" : "error-message"}>{message}</p>}
            {mode === "login" && (
              <button className="text-button" type="button" onClick={() => { setMode("forgot"); setMessage(""); }}>
                Forgot password?
              </button>
            )}
            {(mode === "forgot" || mode === "reset") && (
              <button
                className="text-button"
                type="button"
                onClick={() => {
                  setMode("login");
                  setResetToken("");
                  setMessage("");
                }}
              >
                Back to sign in
              </button>
            )}
            {(mode !== "register" || verifiedEmailToken) && (
              <button className="submit-button" disabled={busy}>
                {busy
                  ? "Please wait…"
                  : mode === "login"
                    ? "Enter SplitCare →"
                    : mode === "register"
                      ? "Create my account →"
                      : mode === "forgot"
                        ? "Send reset link →"
                        : "Update password →"}
              </button>
            )}
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
      <span className="brand-mark">÷</span><span className="brand-name">splitcare</span>
    </div>
  );
}

function FriendQrScanner({ onScan, onError }) {
  const onScanRef = useRef(onScan);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onScanRef.current = onScan;
    onErrorRef.current = onError;
  }, [onScan, onError]);

  useEffect(() => {
    let scanner;
    let cancelled = false;
    let hasScanned = false;
    const startScanner = async () => {
      try {
        const { Html5QrcodeScanner } = await import("html5-qrcode");
        if (cancelled) return;
        scanner = new Html5QrcodeScanner(
          "friend-qr-reader",
          { fps: 10, qrbox: { width: 240, height: 240 } },
          false,
        );
        scanner.render((decodedText) => {
          if (cancelled || hasScanned) return;
          hasScanned = true;
          onScanRef.current(decodedText);
        });
      } catch (error) {
        if (cancelled) return;
        console.error("Could not start the friend QR scanner:", error);
        onErrorRef.current("Could not start the QR scanner. Check camera permission and try again.");
      }
    };
    void startScanner();
    return () => {
      cancelled = true;
      if (scanner) {
        void scanner.clear().catch((error) => {
          console.error("Could not stop the friend QR scanner:", error);
        });
      }
    };
  }, []);

  return <div id="friend-qr-reader" className="friend-qr-reader" />;
}

function ExpenseLedger({
  expenses,
  title,
  description,
  onAddExpense,
  onOpenExpense,
  groupExpenses = false,
  userId,
  friends = [],
  selectedFriendId = '',
  onFriendChange,
  friendExpensesError = '',
  friendExpensesBusy = false,
}) {
  const [search, setSearch] = useState('');
  const searchTerms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const visibleExpenses = expenses.filter((expense) => {
    if (!searchTerms.length) return true;
    const searchable = [
      expense.description,
      expense.currency,
      expense.totalAmount,
      Number(expense.totalAmount).toFixed(2),
    ].filter(Boolean).join(' ').toLocaleLowerCase();
    return searchTerms.every((term) => searchable.includes(term));
  });
  const totalByCurrency = new Map();
  expenses.forEach((expense) => {
    totalByCurrency.set(expense.currency, (totalByCurrency.get(expense.currency) || 0) + Number(expense.totalAmount));
  });
  return (
    <div className="personal-expenses-page">
      <div className="welcome-row">
        <div>
          <p className="eyebrow">{groupExpenses ? 'YOUR GROUPS' : selectedFriendId ? 'ONE-TO-ONE WITH FRIEND' : 'ONLY YOU CAN SEE THIS'}</p>
          <h1>{title}</h1>
          <p className="lede">{description}</p>
        </div>
        <button className="primary-action" type="button" onClick={onAddExpense}>
          {groupExpenses ? '＋ Add an expense' : selectedFriendId ? '＋ Add expense with friend' : '＋ Add personal expense'}
        </button>
      </div>
      {onFriendChange && (
        <label className="personal-friend-filter">
          Show personal expenses
          <select value={selectedFriendId} onChange={(event) => onFriendChange(event.target.value)}>
            <option value="">Only me</option>
            {friends.map((friend) => (
              <option key={friend._id} value={friend._id}>
                With {friend.fullnamae || friend.username}
              </option>
            ))}
          </select>
        </label>
      )}
      {friendExpensesError && <p className="error-message" role="alert">{friendExpensesError}</p>}
      <div className="personal-expenses-summary">
        <strong>{expenses.length} {expenses.length === 1 ? 'expense' : 'expenses'}</strong>
        <span>{[...totalByCurrency].map(([currency, total]) => `${currency} ${total.toFixed(2)}`).join(' · ') || 'No spending recorded'}</span>
      </div>
      <div className="expense-ledger-tools">
        <label className="group-activity-search">
          <span className="visually-hidden">Search {groupExpenses ? 'all' : 'personal'} expenses by description or amount</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search description or amount"
          />
        </label>
        {search.trim() && <span>{visibleExpenses.length} of {expenses.length} expenses</span>}
      </div>
      {friendExpensesBusy ? <p className="empty-state">Loading expenses with your friend…</p> : expenses.length ? (
        visibleExpenses.length ? (
          <GroupActivityList
            transactions={visibleExpenses}
            userId={userId}
            onOpenExpense={onOpenExpense}
            personalLedger={!groupExpenses && !selectedFriendId}
            showGroupName={groupExpenses}
          />
        ) : <p className="empty-state">No expenses match your search. Try a description or amount.</p>
      ) : (
        <div className="friends-empty-state">
          <span>▤</span>
          <h2>No {groupExpenses ? 'group' : 'personal'} expenses yet</h2>
          <p>{groupExpenses
            ? 'Expenses you and your group members add will appear here, organized by month.'
            : selectedFriendId
              ? 'Direct expenses you share with this friend will appear here. Group expenses are shown in All expenses.'
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

function FriendHistoryPage({ friend, history, userId, accessToken, busy, error, onBack, onAddExpense, onRefresh, onOpenExpense, openSettlementOnLoad = false }) {
  const [settlementOpen, setSettlementOpen] = useState(openSettlementOnLoad);
  const [settlementMode, setSettlementMode] = useState('one');
  const [payerId, setPayerId] = useState(userId);
  const [selectedKeys, setSelectedKeys] = useState([]);
  const [settlementAmount, setSettlementAmount] = useState('');
  const [settlementNote, setSettlementNote] = useState('');
  const [settlementBusy, setSettlementBusy] = useState(false);
  const [settlementError, setSettlementError] = useState('');
  const settlementPanelRef = useRef(null);
  const defaultCurrency = history?.defaultCurrency || 'INR';
  const balanceItems = (history?.groups || []).flatMap((group) => group.balances.map((balance) => ({
    ...balance,
    groupId: group.groupId,
    groupName: group.groupName,
    isDirect: group.isDirect,
    selectionKey: `${group.groupId}:${balance.currency}`,
  })));
  const selectedItems = balanceItems.filter((balance) => (
    settlementMode === 'all' || selectedKeys.includes(balance.selectionKey)
  ));
  const eligibleItems = selectedItems.filter((balance) => {
    const amount = Number(balance.convertedBalance);
    return payerId === userId ? amount < 0 : amount > 0;
  });
  const maxAmount = eligibleItems.reduce((sum, balance) => sum + Math.abs(Number(balance.convertedBalance)), 0);
  const friendOwes = balanceItems.filter((balance) => Number(balance.convertedBalance) > 0)
    .reduce((sum, balance) => sum + Number(balance.convertedBalance), 0);
  const userOwes = balanceItems.filter((balance) => Number(balance.convertedBalance) < 0)
    .reduce((sum, balance) => sum + Math.abs(Number(balance.convertedBalance)), 0);
  const personalTransactions = (history?.transactions || []).filter((transaction) => (
    (transaction.isDirect && ['EXPENSE', 'REIMBURSEMENT'].includes(transaction.type))
    || transaction.type === 'FRIEND_SETTLEMENT'
  ));
  const personalExpenseTotal = (history?.groups || [])
    .filter((group) => group.isDirect)
    .flatMap((group) => group.expenseTotals || [])
    .reduce((total, expenseTotal) => total + Number(expenseTotal.convertedAmount), 0);

  useEffect(() => {
    setSettlementAmount(maxAmount > 0 ? maxAmount.toFixed(2) : '');
  }, [maxAmount]);

  useEffect(() => {
    if (settlementOpen) settlementPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [settlementOpen]);

  const changeMode = (mode) => {
    setSettlementMode(mode);
    setSelectedKeys([]);
    setSettlementError('');
  };
  const toggleBalance = (key) => setSelectedKeys((current) => {
    if (current.includes(key)) return current.filter((item) => item !== key);
    if (settlementMode === 'one') return [key];
    return [...current, key];
  });
  const saveSettlement = async (event) => {
    event.preventDefault();
    setSettlementBusy(true);
    setSettlementError('');
    try {
      await apiRequest(`/friends/${friend._id}/settlements`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          payerId,
          amount: settlementAmount,
          currency: defaultCurrency,
          mode: settlementMode === 'all' ? 'all' : 'selected',
          selections: settlementMode === 'all' ? [] : selectedItems.map((item) => ({
            groupId: item.groupId,
            currency: item.currency,
          })),
          note: settlementNote.trim() || null,
        }),
      });
      setSettlementNote('');
      await onRefresh();
    } catch (requestError) {
      setSettlementError(requestError.message);
    } finally {
      setSettlementBusy(false);
    }
  };

  return (
    <div className="friend-history-page">
      <header className="friend-history-heading">
        <button
          type="button"
          className="friend-history-back"
          onClick={onBack}
          aria-label="Close friend history and return to dashboard"
        >×</button>
        <div className="friend-history-person">
          {friend.coverimage
            ? <img src={friend.coverimage} alt="" />
            : <span>{(friend.fullnamae || friend.username).slice(0, 1).toUpperCase()}</span>}
          <div><h1>{friend.fullnamae || friend.username}</h1><small>@{friend.username}</small></div>
        </div>
        <div className="friend-history-actions">
          <button type="button" className="quiet-button" onClick={onAddExpense}>＋ Add expense</button>
          <button type="button" className="primary-action" onClick={() => {
            setSettlementError('');
            setSettlementOpen(true);
          }}>Settle up</button>
        </div>
      </header>
      {error && <p className="error-message" role="alert">{error}</p>}
      <section className="friend-history-balance">
        <div><span>{friend.fullnamae || friend.username} owes you</span><strong>{defaultCurrency} {friendOwes.toFixed(2)}</strong></div>
        <div><span>You owe {friend.fullnamae || friend.username}</span><strong>{defaultCurrency} {userOwes.toFixed(2)}</strong></div>
        <small>Converted using daily reference exchange rates.</small>
      </section>
      <div className={`friend-history-layout ${settlementOpen ? 'settlement-open' : ''}`}>
        <section className="friend-history-groups">
          <div className="friend-history-section-heading">
            <div><p className="eyebrow">YOUR BALANCES</p><h2>By group</h2></div>
            <span>{history?.groups?.length || 0} ledgers</span>
          </div>
          {history?.groups?.length ? history.groups.map((group) => (
            <article className="friend-balance-group" key={group.groupId}>
              <div className="friend-balance-group-title">
                <div>
                  <strong>{group.groupName}</strong>
                  {group.isDirect && <small>One-to-one</small>}
                </div>
                <span>
                  <small>Total expenses</small>
                  <strong>{defaultCurrency} {(group.expenseTotals || [])
                    .reduce((total, item) => total + Number(item.convertedAmount), 0).toFixed(2)}</strong>
                </span>
              </div>
              {group.balances.length ? group.balances.map((balance) => {
                const key = `${group.groupId}:${balance.currency}`;
                const selected = selectedKeys.includes(key);
                return (
                  <label className="friend-balance-row" key={key}>
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={settlementMode === 'all' || (payerId === userId
                        ? Number(balance.convertedBalance) >= 0
                        : Number(balance.convertedBalance) <= 0)}
                      onChange={() => toggleBalance(key)}
                      aria-label={`Select ${group.groupName} balance in ${balance.currency}`}
                    />
                    <span className={Number(balance.convertedBalance) >= 0 ? 'balance-positive' : 'balance-negative'}>
                      {Number(balance.netBalance) >= 0 ? `${friend.fullnamae || friend.username} owes you` : `You owe ${friend.fullnamae || friend.username}`}
                    </span>
                    <strong>{balance.currency} {Math.abs(Number(balance.netBalance)).toFixed(2)}</strong>
                    <small>≈ {defaultCurrency} {Math.abs(Number(balance.convertedBalance)).toFixed(2)}</small>
                  </label>
                );
              }) : <p className="friend-ledger-settled">Settled up</p>}
            </article>
          )) : <p className="empty-state">You have no shared group or direct friend balances yet.</p>}
          <section className="friend-history-personal-spend">
            <div className="friend-history-section-heading">
              <div><p className="eyebrow">ONE-TO-ONE LEDGER</p><h2>Personal spend with {friend.fullnamae || friend.username}</h2></div>
              <span>{personalTransactions.length} records · {defaultCurrency} {personalExpenseTotal.toFixed(2)}</span>
            </div>
            {busy ? <p className="empty-state">Loading personal expenses…</p>
              : personalTransactions.length
                ? <GroupActivityList
                    transactions={personalTransactions}
                    userId={userId}
                    onOpenExpense={onOpenExpense}
                  />
                : <p className="empty-state">Personal expenses and payments between you and {friend.fullnamae || friend.username} will appear here.</p>}
          </section>
        </section>
        {settlementOpen && <section className="friend-history-settlement" ref={settlementPanelRef} id="friend-settlement-panel">
          <div className="friend-history-section-heading">
            <div><p className="eyebrow">PAYMENTS</p><h2>Settle balances</h2></div>
            <button type="button" className="friend-history-back" onClick={() => setSettlementOpen(false)}>Close</button>
          </div>
          <form onSubmit={saveSettlement}>
            <fieldset className="friend-settlement-modes">
              <legend>Choose what to settle</legend>
              <label><input type="radio" checked={settlementMode === 'one'} onChange={() => changeMode('one')} /> One group balance</label>
              <label><input type="radio" checked={settlementMode === 'multiple'} onChange={() => changeMode('multiple')} /> Multiple selected balances</label>
              <label><input type="radio" checked={settlementMode === 'all'} onChange={() => changeMode('all')} /> All balances in this direction</label>
            </fieldset>
            <label>Who paid?
              <select value={payerId} onChange={(event) => {
                setPayerId(event.target.value);
                setSelectedKeys([]);
              }}>
                <option value={userId}>You pay {friend.fullnamae || friend.username}</option>
                <option value={friend._id}>{friend.fullnamae || friend.username} pays you</option>
              </select>
            </label>
            {settlementMode !== 'all' && <p className="modal-help">Select {settlementMode === 'one' ? 'one' : 'one or more'} balances above. The payment is applied in the selected group order.</p>}
            <label>Amount ({defaultCurrency})
              <input
                type="number"
                min="0.01"
                max={maxAmount.toFixed(2)}
                step="0.01"
                value={settlementAmount}
                onChange={(event) => setSettlementAmount(event.target.value)}
                required
              />
            </label>
            <small>Up to {defaultCurrency} {maxAmount.toFixed(2)} available for this choice.</small>
            <label>Payment note (optional)
              <input value={settlementNote} onChange={(event) => setSettlementNote(event.target.value)} maxLength="500" placeholder="Cash, bank transfer…" />
            </label>
            {settlementError && <p className="error-message" role="alert">{settlementError}</p>}
            <button className="primary-action" disabled={settlementBusy || maxAmount <= 0 || (settlementMode !== 'all' && !selectedKeys.length)}>
              {settlementBusy ? 'Saving payment…' : 'Record payment'}
            </button>
          </form>
        </section>}
      </div>
    </div>
  );
}

function Dashboard({ user, accessToken, onLogout, onProfileUpdated, onAccountDeleted, friendInviteCode, onFriendInviteHandled, referralMessage, referralCode }) {
  const firstName = user.fullnamae?.split(" ")[0] || user.username;
  const [groups, setGroups] = useState([]);
  const [dashboardBalanceSummary, setDashboardBalanceSummary] = useState(null);
  const [dashboardBalancesBusy, setDashboardBalancesBusy] = useState(true);
  const [dashboardBalancesError, setDashboardBalancesError] = useState('');
  const dashboardBalanceRequestRef = useRef(0);
  const [personalGroup, setPersonalGroup] = useState(null);
  const [expenses, setExpenses] = useState([]);
  const [friendActivities, setFriendActivities] = useState([]);
  const [personalExpenses, setPersonalExpenses] = useState([]);
  const [personalFriendId, setPersonalFriendId] = useState('');
  const [personalFriendExpenses, setPersonalFriendExpenses] = useState([]);
  const [personalFriendExpensesBusy, setPersonalFriendExpensesBusy] = useState(false);
  const [personalFriendExpensesError, setPersonalFriendExpensesError] = useState('');
  const personalFriendRequestRef = useRef(0);
  const [activityNotifications, setActivityNotifications] = useState([]);
  const [friends, setFriends] = useState([]);
  const [selectedFriend, setSelectedFriend] = useState(null);
  const [friendHistory, setFriendHistory] = useState(null);
  const [friendHistoryBusy, setFriendHistoryBusy] = useState(false);
  const [friendHistoryError, setFriendHistoryError] = useState('');
  const [friendRequests, setFriendRequests] = useState([]);
  const [sentFriendRequests, setSentFriendRequests] = useState([]);
  const [friendSort, setFriendSort] = useState('alphabetical');
  const [showSettleUpChooser, setShowSettleUpChooser] = useState(false);
  const [friendSettlementAutoOpen, setFriendSettlementAutoOpen] = useState(false);
  const [settleGroupAutoOpenId, setSettleGroupAutoOpenId] = useState('');
  const dashboardPageStorageKey = `splitcare-dashboard-page:${user._id}`;
  const [activePage, setActivePage] = useState(() => {
    const savedPage = window.sessionStorage.getItem(dashboardPageStorageKey);
    return ['overview', 'recent', 'all-expenses', 'personal', 'friends'].includes(savedPage)
      ? savedPage
      : 'overview';
  });
  const [friendIdentifierType, setFriendIdentifierType] = useState('username');
  const [friendIdentifier, setFriendIdentifier] = useState('');
  const [friendBusy, setFriendBusy] = useState(false);
  const [friendError, setFriendError] = useState('');
  const [showFriendQr, setShowFriendQr] = useState(false);
  const [showFriendQrScanner, setShowFriendQrScanner] = useState(false);
  const [friendScannerKey, setFriendScannerKey] = useState(0);
  const [friendInvite, setFriendInvite] = useState(null);
  const [friendQrBusy, setFriendQrBusy] = useState(false);
  const [friendQrError, setFriendQrError] = useState('');
  const friendInviteHandledRef = useRef('');
  const [showReferralModal, setShowReferralModal] = useState(false);
  const [referralDetails, setReferralDetails] = useState(null);
  const [referralBusy, setReferralBusy] = useState(false);
  const [referralError, setReferralError] = useState('');
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
    currency: user.defaultCurrency || 'INR',
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
  const [friendExpenseTarget, setFriendExpenseTarget] = useState(null);
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
  const [showMobileNav, setShowMobileNav] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showEmailSettings, setShowEmailSettings] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const notificationControlRef = useRef(null);
  const profileControlRef = useRef(null);
  const [profileForm, setProfileForm] = useState({ username: user.username || '', email: user.email || '', fullnamae: user.fullnamae || '', phone: user.phone || '', defaultCurrency: user.defaultCurrency || 'INR', currentPassword: '', newPassword: '', coverimage: null });
  const [passwordUpdateEnabled, setPasswordUpdateEnabled] = useState(false);
  const [currentPasswordVerified, setCurrentPasswordVerified] = useState(false);
  const [usernameAvailability, setUsernameAvailability] = useState({ username: '', status: 'checking' });
  const [photoPreview, setPhotoPreview] = useState('');
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [emailChangeEnabled, setEmailChangeEnabled] = useState(false);
  const [emailChangeCodesSent, setEmailChangeCodesSent] = useState(false);
  const [oldEmailCode, setOldEmailCode] = useState('');
  const [newEmailCode, setNewEmailCode] = useState('');
  const [emailChangeBusy, setEmailChangeBusy] = useState(false);
  const [emailChangeError, setEmailChangeError] = useState('');
  const [deleteCodeSent, setDeleteCodeSent] = useState(false);
  const [deleteCode, setDeleteCode] = useState('');
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleteAccountBusy, setDeleteAccountBusy] = useState(false);
  const [deleteAccountError, setDeleteAccountError] = useState('');
  const [emailNotificationPreferences, setEmailNotificationPreferences] = useState(defaultEmailNotificationPreferences);
  const [emailSettingsBusy, setEmailSettingsBusy] = useState(false);
  const [emailSettingsError, setEmailSettingsError] = useState('');
  const [emailSettingsMessage, setEmailSettingsMessage] = useState('');
  const [formMessage, setFormMessage] = useState(referralMessage || "");
  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  useEffect(() => {
    window.sessionStorage.setItem(
      dashboardPageStorageKey,
      activePage === 'friend-detail' ? 'friends' : activePage,
    );
  }, [activePage, dashboardPageStorageKey]);

  useEffect(() => {
    if (!showNotifications) return undefined;
    const closeOnOutsideClick = (event) => {
      if (!notificationControlRef.current?.contains(event.target)) setShowNotifications(false);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [showNotifications]);

  useEffect(() => {
    if (!showProfileMenu) return undefined;
    const closeOnOutsideClick = (event) => {
      if (!profileControlRef.current?.contains(event.target)) setShowProfileMenu(false);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [showProfileMenu]);

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
      apiRequest("/friends/activity", { headers: authHeaders }),
    ])
      .then(([groupData, expenseData, personalExpenseData, friendActivityData]) => {
        const loadedGroups = groupData || [];
        setGroups(loadedGroups.filter((group) => !group.isPersonal));
        setPersonalGroup(loadedGroups.find((group) => group.isPersonal) || null);
        setExpenses(expenseData || []);
        setPersonalExpenses(personalExpenseData || []);
        setFriendActivities(friendActivityData || []);
      })
      .catch((error) => setFormMessage(error.message));
  }, [accessToken]);

  useEffect(() => {
    let active = true;
    // A newer refresh wins if dependencies change before an earlier balance request finishes.
    const requestId = ++dashboardBalanceRequestRef.current;
    setDashboardBalancesBusy(true);
    setDashboardBalancesError('');
    apiRequest('/groups/balances/summary', { headers: authHeaders })
      .then((summary) => {
        if (active && requestId === dashboardBalanceRequestRef.current) setDashboardBalanceSummary(summary);
      })
      .catch((error) => {
        if (active && requestId === dashboardBalanceRequestRef.current) setDashboardBalancesError(error.message);
      })
      .finally(() => {
        if (active && requestId === dashboardBalanceRequestRef.current) setDashboardBalancesBusy(false);
      });
    return () => { active = false; };
  }, [accessToken, groups, expenses, friendActivities, groupTransactions, user.defaultCurrency]);

  useEffect(() => {
    if (activePage !== 'recent') return;
    Promise.all([
      apiRequest('/expenses?history=true', { headers: authHeaders }),
      apiRequest('/friends/activity', { headers: authHeaders }),
      apiRequest('/users/notifications', { headers: authHeaders }),
      apiRequest('/friends/requests', { headers: authHeaders }),
      apiRequest('/users/notifications/read', { method: 'PATCH', headers: authHeaders }),
    ])
      .then(([activity, friendActivity, notifications, requests]) => {
        setExpenses(activity || []);
        setFriendActivities(friendActivity || []);
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
    const [friendData, requestData, sentRequestData, friendActivityData] = await Promise.all([
      apiRequest('/friends', { headers: authHeaders }),
      apiRequest('/friends/requests', { headers: authHeaders }),
      apiRequest('/friends/requests/sent', { headers: authHeaders }),
      apiRequest('/friends/activity', { headers: authHeaders }),
    ]);
    setFriends(friendData);
    setFriendRequests(requestData);
    setSentFriendRequests(sentRequestData);
    setFriendActivities(friendActivityData || []);
  };

  const refreshFriendActivity = async () => {
    const activity = await apiRequest('/friends/activity', { headers: authHeaders });
    setFriendActivities(activity || []);
    return activity || [];
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

  const loadFriendInvite = async () => {
    setFriendQrBusy(true);
    setFriendQrError('');
    setFriendInvite(null);
    try {
      const result = await apiRequest('/friends/invite-code', {
        headers: authHeaders,
      });
      setFriendInvite({
        code: result.code,
        url: `${window.location.origin}/?friendCode=${encodeURIComponent(result.code)}`,
      });
    } catch (error) {
      setFriendQrError(error.message);
    } finally {
      setFriendQrBusy(false);
    }
  };

  const loadReferralDetails = async () => {
    setReferralBusy(true);
    setReferralError('');
    try {
      const details = await apiRequest('/friends/referral', { headers: authHeaders });
      setReferralDetails({
        ...details,
        url: `${window.location.origin}/?referralCode=${encodeURIComponent(details.code)}&referrerUsername=${encodeURIComponent(details.username)}`,
      });
    } catch (error) {
      setReferralError(error.message);
    } finally {
      setReferralBusy(false);
    }
  };

  const openReferralModal = () => {
    setShowReferralModal(true);
    void loadReferralDetails();
  };

  const openFriendInvite = () => {
    setShowFriendQr(true);
    void loadFriendInvite();
  };

  const changeFriendInviteCode = async () => {
    if (!window.confirm('Change your friend code? Your old QR code and links will stop working.')) return;
    setFriendQrBusy(true);
    setFriendQrError('');
    try {
      const result = await apiRequest('/friends/invite-code/change', {
        method: 'POST',
        headers: authHeaders,
      });
      setFriendInvite({
        code: result.code,
        url: `${window.location.origin}/?friendCode=${encodeURIComponent(result.code)}`,
      });
    } catch (error) {
      setFriendQrError(error.message);
    } finally {
      setFriendQrBusy(false);
    }
  };

  const acceptFriendInvite = async (code, fromLink = false) => {
    setFriendQrBusy(true);
    setFriendQrError('');
    try {
      const friend = await apiRequest('/friends/invite-code/accept', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ code }),
      });
      await refreshFriendData();
      setShowFriendQrScanner(false);
      setActivePage('friends');
      setFormMessage(`You are now friends with ${friend.fullnamae || friend.username}.`);
    } catch (error) {
      if (fromLink) setFriendError(error.message);
      else setFriendQrError(error.message);
    } finally {
      setFriendQrBusy(false);
      if (fromLink) onFriendInviteHandled();
    }
  };

  const handleFriendQrScan = (value) => {
    let code = value.trim();
    try {
      code = new URL(value).searchParams.get('friendCode') || '';
    } catch {
      // A raw code is also accepted for scanners that return QR text directly.
    }
    if (!code) {
      setFriendQrError('That QR code is not a SplitCare friend invite.');
      return;
    }
    void acceptFriendInvite(code);
  };

  const copyFriendInvite = async () => {
    if (!friendInvite?.url) return;
    try {
      await navigator.clipboard.writeText(friendInvite.url);
      setFriendQrError('');
      setFormMessage('Friend link copied to clipboard.');
    } catch (error) {
      setFriendQrError('Could not copy the link. Check your browser clipboard permissions.');
      console.error('Could not copy the friend invite link:', error);
    }
  };

  const copyReferralLink = async () => {
    if (!referralDetails?.url) return;
    try {
      await navigator.clipboard.writeText(referralDetails.url);
      setReferralError('');
      setFormMessage('Referral link copied to clipboard.');
    } catch (error) {
      setReferralError('Could not copy the link. Check your browser clipboard permissions.');
      console.error('Could not copy the referral link:', error);
    }
  };

  const shareReferralLink = async () => {
    if (!referralDetails?.url) return;
    if (!navigator.share) {
      await copyReferralLink();
      return;
    }
    try {
      await navigator.share({
        title: 'Join me on SplitCare',
        text: 'Create a SplitCare account using my referral link. We both earn 10 points.',
        url: referralDetails.url,
      });
    } catch (error) {
      if (error.name !== 'AbortError') {
        setReferralError('Could not share the referral link.');
        console.error('Could not share the referral link:', error);
      }
    }
  };

  const shareFriendInvite = async () => {
    if (!friendInvite?.url) return;
    if (!navigator.share) {
      await copyFriendInvite();
      return;
    }
    try {
      await navigator.share({
        title: 'Connect with me on SplitCare',
        text: 'Use my SplitCare friend link to connect directly.',
        url: friendInvite.url,
      });
    } catch (error) {
      if (error.name !== 'AbortError') {
        setFriendQrError('Could not share the friend link.');
        console.error('Could not share the friend invite link:', error);
      }
    }
  };

  useEffect(() => {
    if (!friendInviteCode || friendInviteHandledRef.current === friendInviteCode) return;
    friendInviteHandledRef.current = friendInviteCode;
    void acceptFriendInvite(friendInviteCode, true);
  }, [friendInviteCode]);

  useEffect(() => {
    if (!referralMessage) return;
    setFormMessage(referralMessage);
  }, [referralMessage]);

  useEffect(() => {
    if (!referralCode) return;
    setFormMessage('Referral links award points only when a new account completes registration.');
    onFriendInviteHandled();
  }, [referralCode, onFriendInviteHandled]);

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

  const loadFriendHistory = async (friend) => {
    setFriendHistoryBusy(true);
    setFriendHistoryError('');
    try {
      const history = await apiRequest(`/friends/${friend._id}/history`, { headers: authHeaders });
      setFriendHistory(history);
      return history;
    } catch (error) {
      setFriendHistoryError(error.message);
      throw error;
    } finally {
      setFriendHistoryBusy(false);
    }
  };

  const loadPersonalFriendExpenses = async (friendId) => {
    // Ignore responses for a previously selected friend when requests finish out of order.
    const requestId = ++personalFriendRequestRef.current;
    if (!friendId) {
      setPersonalFriendExpenses([]);
      setPersonalFriendExpensesError('');
      setPersonalFriendExpensesBusy(false);
      return [];
    }
    setPersonalFriendExpenses([]);
    setPersonalFriendExpensesBusy(true);
    setPersonalFriendExpensesError('');
    try {
      const history = await apiRequest(`/friends/${friendId}/history`, { headers: authHeaders });
      const directExpenses = (history.transactions || []).filter((transaction) => (
        transaction.isDirect && ['EXPENSE', 'REIMBURSEMENT'].includes(transaction.type)
      ));
      if (requestId === personalFriendRequestRef.current) setPersonalFriendExpenses(directExpenses);
      return directExpenses;
    } catch (error) {
      if (requestId === personalFriendRequestRef.current) setPersonalFriendExpensesError(error.message);
      throw error;
    } finally {
      if (requestId === personalFriendRequestRef.current) setPersonalFriendExpensesBusy(false);
    }
  };

  const openFriendDetails = async (friend, openSettlementOnLoad = false) => {
    setSelectedFriend(friend);
    setFriendHistory(null);
    setFriendSettlementAutoOpen(openSettlementOnLoad);
    setActivePage('friend-detail');
    try {
      await loadFriendHistory(friend);
    } catch {
      // The error is displayed on the friend history page.
    }
  };

  const refreshFriendHistory = async () => {
    const refreshes = [refreshFriendActivity()];
    if (selectedFriend) refreshes.push(loadFriendHistory(selectedFriend));
    await Promise.all(refreshes);
  };

  const openFriendExpenseForm = (friend = selectedFriend) => {
    if (!friend) return;
    setFriendExpenseTarget(friend._id);
    setExpenseDraft({
      description: '',
      totalAmount: '',
      currency: user.defaultCurrency || 'INR',
      category: 'Uncategorized',
      subcategory: '',
      groupId: '',
      paidBy: user._id,
      participantIds: [user._id, friend._id],
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
    const targetFriendId = friendExpenseTarget;
    const targetFriend = friends.find((friend) => friend._id === targetFriendId);
    const participants = expenseDraft.participantIds;
    if (targetFriendId && (!targetFriend || !participants.includes(user._id) || !participants.includes(targetFriendId))) {
      setExpenseError('Select a friend and include both people in the one-to-one expense.');
      return;
    }
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
    // Itemized expenses take their total from line items rather than a separate total field.
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
      const expense = await apiRequest(isEditing
        ? targetFriendId
          ? `/friends/${targetFriendId}/expenses/${editingExpenseId}`
          : `/expenses/${editingExpenseId}`
        : targetFriendId ? `/friends/${targetFriendId}/expenses` : '/expenses', {
        method: isEditing ? "PATCH" : "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body,
      });
      if (!targetFriendId) setExpenses((current) => isEditing
        ? current.map((item) => item._id === expense._id ? { ...item, ...expense } : item)
        : [{
          ...expense,
          groupName: group?.name || 'Personal Expenses',
          isPersonal: !expenseDraft.groupId,
        }, ...current]);
      if (!targetFriendId && !expenseDraft.groupId && !isEditing) {
        setPersonalGroup((current) => current || {
          _id: expense.groupId,
          name: 'Personal Expenses',
          isPersonal: true,
        });
        setPersonalExpenses((current) => [expense, ...current]);
      }
      setShowExpenseForm(false);
      setEditingExpenseId('');
      setFriendExpenseTarget(null);
      setClearExpenseProof(false);
      setSelectedExpense(null);
      if (!targetFriendId && isEditing && !expenseDraft.groupId) {
        setPersonalExpenses(await apiRequest('/expenses/personal', { headers: authHeaders }));
      }
      if (isEditing) {
        setFormMessage(targetFriendId ? 'Friend expense updated.' : 'Expense updated. The group has been notified.');
        if (!targetFriendId) {
          apiRequest('/users/notifications', { headers: authHeaders })
            .then((data) => setActivityNotifications(data || []))
            .catch((error) => setFormMessage(error.message));
        }
      }
      if (targetFriendId && activePage === 'personal' && personalFriendId === targetFriendId) {
        await loadPersonalFriendExpenses(targetFriendId);
      } else if (targetFriendId && selectedFriend?._id === targetFriendId) {
        await loadFriendHistory(selectedFriend);
      } else {
        apiRequest('/expenses?history=true', { headers: authHeaders })
          .then((data) => setExpenses(data || []))
          .catch((error) => setFormMessage(`Expense saved, but recent activity could not be refreshed: ${error.message}`));
      }
      if (targetFriendId) {
        refreshFriendActivity()
          .catch((error) => setFormMessage(`Expense saved, but friend activity could not be refreshed: ${error.message}`));
      }
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
      currency: user.defaultCurrency || 'INR',
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
    setFriendExpenseTarget(null);
    setEditingExpenseId('');
    setClearExpenseProof(false);
    setShowExpenseCategories(false);
    setShowExpenseForm(true);
  };

  const editExpense = (expense) => {
    const group = groups.find((item) => item._id === expense.groupId);
    const matchingFriendHistoryGroup = friendHistory?.groups.find((item) => item.groupId === expense.groupId && item.isDirect);
    const isFriendExpense = expense.isDirect || Boolean(matchingFriendHistoryGroup);
    const participants = expense.participantIds || [user._id];
    setExpenseDraft({
      description: expense.description || '',
      totalAmount: expense.totalAmount || '',
      currency: expense.currency || 'INR',
      category: expense.category || 'Uncategorized',
      subcategory: expense.subcategory || '',
      groupId: group?._id || (isFriendExpense ? expense.groupId : ''),
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
    setFriendExpenseTarget(isFriendExpense
      ? expense.friendId || (matchingFriendHistoryGroup ? selectedFriend?._id : personalFriendId) || null
      : null);
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
      const isFriendExpense = expense.isDirect || friendHistory?.groups.some((group) => group.groupId === expense.groupId && group.isDirect);
      const expenseFriend = selectedFriend?._id === personalFriendId
        ? selectedFriend
        : friends.find((friend) => friend._id === personalFriendId);
      const historyFriendId = selectedFriend && friendHistory?.groups.some((group) => group.groupId === expense.groupId && group.isDirect)
        ? selectedFriend._id
        : null;
      const friendId = expense.friendId || historyFriendId || expenseFriend?._id;
      const endpoint = isFriendExpense && friendId
        ? `/friends/${friendId}/expenses/${expense._id}`
        : `/expenses/${expense._id}`;
      const result = await apiRequest(endpoint, {
        method: 'DELETE',
        headers: authHeaders,
      });
      if (isFriendExpense) await refreshFriendActivity();
      setSelectedExpense(null);
      if (!isFriendExpense) {
        setExpenses(await apiRequest('/expenses?history=true', { headers: authHeaders }));
      }
      if (expense.groupId && selectedGroup?._id === expense.groupId) {
        await openGroupDetails(selectedGroup);
      }
      if (isFriendExpense && friendId && personalFriendId === friendId) {
        await loadPersonalFriendExpenses(friendId);
      }
      if (selectedFriend && friendHistory?.groups.some((group) => group.groupId === expense.groupId && group.isDirect)) {
        await loadFriendHistory(selectedFriend);
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
    setFriendExpenseTarget(null);
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

  const changePersonalFriend = async (friendId) => {
    setPersonalFriendId(friendId);
    try {
      await loadPersonalFriendExpenses(friendId);
    } catch {
      // The request error is displayed alongside the personal expense filters.
    }
  };

  const changeExpenseFriend = (friendId) => {
    setFriendExpenseTarget(friendId || null);
    const participantIds = friendId ? [user._id, friendId] : [user._id];
    setExpenseDraft((current) => ({
      ...current,
      groupId: '',
      paidBy: participantIds.includes(current.paidBy) ? current.paidBy : user._id,
      participantIds,
      splitValues: {},
      items: current.items.map((item) => ({
        ...item,
        participantIds: item.participantIds.filter((id) => participantIds.includes(id)),
      })),
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
  const previewGroupSplitwiseImport = async (groupId, file) => {
    const body = new FormData();
    body.set('file', file);
    return apiRequest(`/groups/${groupId}/splitwise-import/preview`, {
      method: 'POST',
      headers: authHeaders,
      body,
    });
  };
  const importGroupSplitwiseHistory = async (groupId, file, memberMappings) => {
    const body = new FormData();
    body.set('file', file);
    body.set('memberMappings', JSON.stringify(memberMappings));
    const result = await apiRequest(`/groups/${groupId}/splitwise-import`, {
      method: 'POST',
      headers: authHeaders,
      body,
    });
    const [transactions, balances, settlements, allExpenses] = await Promise.all([
      apiRequest(`/expenses?groupId=${groupId}&history=true`, { headers: authHeaders }),
      apiRequest(`/groups/${groupId}/balances`, { headers: authHeaders }),
      apiRequest(`/groups/${groupId}/simplify-debts`, { headers: authHeaders }),
      apiRequest('/expenses?history=true', { headers: authHeaders }),
    ]);
    setGroupTransactions(transactions);
    setGroupBalances(balances);
    setGroupSettlements(settlements);
    setExpenses(allExpenses);
    return result;
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
  const loadEmailNotificationSettings = async () => {
    setEmailSettingsBusy(true);
    setEmailSettingsError('');
    setEmailSettingsMessage('');
    try {
      const result = await apiRequest('/users/profile/email-notifications', { headers: authHeaders });
      setEmailNotificationPreferences({ ...defaultEmailNotificationPreferences, ...result.preferences });
    } catch (error) {
      setEmailSettingsError(error.message);
    } finally {
      setEmailSettingsBusy(false);
    }
  };
  const saveEmailNotificationSettings = async () => {
    setEmailSettingsBusy(true);
    setEmailSettingsError('');
    setEmailSettingsMessage('');
    try {
      const result = await apiRequest('/users/profile/email-notifications', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ preferences: emailNotificationPreferences }),
      });
      setEmailNotificationPreferences({ ...defaultEmailNotificationPreferences, ...result.preferences });
      setEmailSettingsMessage('Email notification settings saved.');
    } catch (error) {
      setEmailSettingsError(error.message);
    } finally {
      setEmailSettingsBusy(false);
    }
  };
  const sendEmailChangeCodes = async () => {
    setEmailChangeBusy(true);
    setEmailChangeError('');
    try {
      const result = await apiRequest('/users/profile/email-change/send-codes', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ newEmail }),
      });
      setEmailChangeCodesSent(true);
      setOldEmailCode('');
      setNewEmailCode('');
      setFormMessage(result.message);
    } catch (error) {
      setEmailChangeError(error.message);
    } finally {
      setEmailChangeBusy(false);
    }
  };
  const verifyAndChangeEmail = async () => {
    setEmailChangeBusy(true);
    setEmailChangeError('');
    try {
      const result = await apiRequest('/users/profile/email-change/verify', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ newEmail, oldCode: oldEmailCode, newCode: newEmailCode }),
      });
      onProfileUpdated(result.user);
      setProfileForm((current) => ({ ...current, email: result.user.email }));
      setNewEmail('');
      setEmailChangeEnabled(false);
      setEmailChangeCodesSent(false);
      setOldEmailCode('');
      setNewEmailCode('');
      setFormMessage(result.message);
    } catch (error) {
      setEmailChangeError(error.message);
    } finally {
      setEmailChangeBusy(false);
    }
  };
  const sendAccountDeletionCode = async () => {
    setDeleteAccountBusy(true);
    setDeleteAccountError('');
    try {
      const result = await apiRequest('/users/profile/delete-account/send-code', {
        method: 'POST',
        headers: authHeaders,
      });
      setDeleteCodeSent(true);
      setFormMessage(result.message);
    } catch (error) {
      setDeleteAccountError(error.message);
    } finally {
      setDeleteAccountBusy(false);
    }
  };
  const resendAccountDeletionCode = async () => {
    await sendAccountDeletionCode();
    setDeleteCode('');
  };
  const deleteAccount = async () => {
    if (deleteConfirmation !== 'DELETE') {
      setDeleteAccountError('Type DELETE to confirm permanent account deletion.');
      return;
    }
    setDeleteAccountBusy(true);
    setDeleteAccountError('');
    try {
      await apiRequest('/users/profile/account', {
        method: 'DELETE',
        headers: authHeaders,
        body: JSON.stringify({ code: deleteCode }),
      });
      onAccountDeleted();
    } catch (error) {
      setDeleteAccountError(error.message);
    } finally {
      setDeleteAccountBusy(false);
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
    let historyWarning = '';
    const body = new FormData();
    ['username', 'fullnamae', 'phone', 'defaultCurrency'].forEach((key) => body.append(key, profileForm[key]));
    if (profileForm.coverimage) body.append('coverimage', profileForm.coverimage);
    if (passwordUpdateEnabled) {
      body.append('currentPassword', profileForm.currentPassword);
      body.append('newPassword', profileForm.newPassword);
    }
    try {
      const result = await apiRequest(`/users/profile/${user._id}`, { method: 'PUT', headers: authHeaders, body });
      onProfileUpdated(result.user);
      if (selectedFriend && result.user.defaultCurrency !== user.defaultCurrency) {
        try {
          await loadFriendHistory(selectedFriend);
        } catch (error) {
          historyWarning = `Profile updated, but friend balances could not be refreshed: ${error.message}`;
        }
      }
      setProfileForm({ username: result.user.username || '', email: result.user.email || '', fullnamae: result.user.fullnamae || '', phone: result.user.phone || '', defaultCurrency: result.user.defaultCurrency || 'INR', currentPassword: '', newPassword: '', coverimage: null });
      setPasswordUpdateEnabled(false);
      setCurrentPasswordVerified(false);
      setShowProfile(false);
      setFormMessage(historyWarning || result.cleanupWarning || 'Profile updated successfully.');
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
  const expenseTargetFriend = friends.find((friend) => friend._id === friendExpenseTarget);
  const expenseGroup = groups.find((group) => group._id === expenseDraft.groupId);
  const selectedExpenseFriendGroup = selectedExpense
    ? friendHistory?.groups.find((group) => group.groupId === selectedExpense.groupId && group.isDirect)
      || (selectedExpense.isDirect ? { groupId: selectedExpense.groupId, groupName: 'Direct friend expenses', isDirect: true } : null)
    : null;
  const selectedExpenseFriend = friends.find((friend) => friend._id === selectedExpense?.friendId)
    || (friendHistory?.groups.some((group) => group.groupId === selectedExpense?.groupId && group.isDirect)
      ? selectedFriend
      : friends.find((friend) => friend._id === personalFriendId));
  const expenseMembers = expenseTargetFriend
    ? [user, expenseTargetFriend]
    : expenseGroup?.members || [user];
  const selectedExpenseMembers = expenseMembers.filter((member) => expenseDraft.participantIds.includes(member._id));
  const itemizedTotal = expenseDraft.items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const expenseSplitDefaults = getDefaultSplitValues(expenseDraft.strategy, expenseDraft.participantIds, expenseDraft.totalAmount);
  const splitModeTotal = selectedExpenseMembers.reduce((sum, member) => sum + (
    Number(expenseDraft.splitValues[member._id] ?? expenseSplitDefaults[member._id]) || 0
  ), 0);
  const groupExpenses = expenses.filter((expense) => expense.groupId && !expense.isPersonal && !['ACTIVITY', 'SETTLEMENT'].includes(expense.type));
  const groupActivity = expenses.filter((entry) => entry.groupId && !entry.isPersonal);
  const allExpenses = [
    ...groupExpenses,
    ...friendActivities.filter((transaction) => (
      transaction.isDirect && ['EXPENSE', 'REIMBURSEMENT'].includes(transaction.type)
    )),
  ].sort((first, second) => new Date(second.createdAt) - new Date(first.createdAt));
  const recentActivity = [...groupActivity, ...friendActivities]
    .sort((first, second) => new Date(second.createdAt) - new Date(first.createdAt));
  const dashboardSpendingTransactions = [
    ...expenses.filter((transaction) => transaction.type === 'EXPENSE'),
    ...friendActivities.filter((transaction) => transaction.isDirect && transaction.type === 'EXPENSE'),
  ];
  const dashboardSpendingMembers = [
    user,
    ...friends,
    ...groups.flatMap((group) => group.members || []),
  ];
  const settleUpOptions = (dashboardBalanceSummary?.outgoingBalances || []).map((balance) => {
    if (balance.id.startsWith('direct:')) {
      const friendId = balance.id.split(':').at(-1);
      return { ...balance, type: 'friend', target: friends.find((friend) => friend._id === friendId) || null };
    }
    return { ...balance, type: 'group', target: groups.find((group) => group._id === balance.id) || null };
  });
  const openSettleUpOption = (option) => {
    setShowSettleUpChooser(false);
    if (!option.target) {
      setFormMessage(`Could not find ${option.type === 'friend' ? 'the friend' : 'the group'} for this balance. Refresh and try again.`);
      return;
    }
    if (option.type === 'friend') {
      void openFriendDetails(option.target, true);
      return;
    }
    setSettleGroupAutoOpenId(option.target._id);
    void openGroupDetails(option.target);
  };

  return (
    <main className="dashboard-page">
      <header className="dashboard-nav">
        <Brand />
        <button
          className="mobile-nav-toggle"
          type="button"
          aria-label={showMobileNav ? "Close navigation menu" : "Open navigation menu"}
          aria-expanded={showMobileNav}
          aria-controls="dashboard-navigation-links"
          onClick={() => {
            setShowMobileNav((current) => !current);
            setShowNotifications(false);
            setShowProfileMenu(false);
          }}
        >
          <span />
          <span />
          <span />
        </button>
        <nav
          className={`nav-links ${showMobileNav ? 'mobile-nav-open' : ''}`}
          id="dashboard-navigation-links"
          aria-label="Dashboard navigation"
        >
          <button aria-label="Dashboard" className={`dashboard-nav-link ${activePage === 'overview' ? 'active' : ''}`} type="button" onClick={() => { setActivePage('overview'); setShowMobileNav(false); }}><span className="mobile-nav-label">Dashboard</span></button>
          <button aria-label="Recent activity" className={activePage === 'recent' ? 'active' : ''} type="button" onClick={() => { setActivePage('recent'); setShowMobileNav(false); }}><span className="mobile-nav-label">Recent activity</span></button>
          <button aria-label="All expenses" className={activePage === 'all-expenses' ? 'active' : ''} type="button" onClick={() => { setActivePage('all-expenses'); setShowMobileNav(false); }}><span className="mobile-nav-label">All expenses</span></button>
          <button aria-label="Personal expenses" className={activePage === 'personal' ? 'active' : ''} type="button" onClick={() => { setActivePage('personal'); setShowMobileNav(false); }}><span className="mobile-nav-label">Personal expenses</span></button>
          <button aria-label="Friends" className={activePage === 'friends' || activePage === 'friend-detail' ? 'active' : ''} type="button" onClick={() => { setActivePage('friends'); setShowMobileNav(false); }}><span className="mobile-nav-label">Friends</span></button>
        </nav>
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
        <div className="profile-control" ref={profileControlRef}>
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
                  setProfileForm({ username: user.username || '', email: user.email || '', fullnamae: user.fullnamae || '', phone: user.phone || '', defaultCurrency: user.defaultCurrency || 'INR', currentPassword: '', newPassword: '', coverimage: null });
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
              <button
                onClick={() => {
                  setShowEmailSettings(true);
                  setShowProfileMenu(false);
                  void loadEmailNotificationSettings();
                }}
              >
                Email notification settings
              </button>
              <button
                onClick={() => {
                  openReferralModal();
                  setShowProfileMenu(false);
                }}
              >
                Refer a friend · earn points
              </button>
              <button
                onClick={() => {
                  setActivePage('friends');
                  setShowProfileMenu(false);
                }}
              >
                Friends
              </button>
              <button
                onClick={openFriendInvite}
              >
                My friend code
              </button>
              <button className="logout-menu-button" onClick={onLogout}>
                Log out
              </button>
            </div>
          )}
        </div>
      </header>
      <div className={`dashboard-shell ${activePage === 'friends' || activePage === 'friend-detail' ? 'friend-management-shell' : ''}`}>
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
                <button className="side-friend-link" type="button" onClick={() => void openFriendDetails(friend)}>
                  {friend.coverimage
                    ? <img src={friend.coverimage} alt="" />
                    : <span className="side-friend-avatar">{(friend.fullnamae || friend.username).slice(0, 1).toUpperCase()}</span>}
                  <span className="side-friend-name">{friend.fullnamae || friend.username}</span>
                </button>
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
          {activePage === 'friend-detail' && selectedFriend ? (
            <div
              className="friend-history-backdrop"
              onMouseDown={() => setActivePage('overview')}
            >
              <section
                className="friend-history-dialog"
                role="dialog"
                aria-modal="true"
                aria-label={`${selectedFriend.fullnamae || selectedFriend.username} friend history`}
                onMouseDown={(event) => event.stopPropagation()}
              >
                <FriendHistoryPage
                  friend={selectedFriend}
                  history={friendHistory}
                  userId={user._id}
                  accessToken={accessToken}
                  busy={friendHistoryBusy}
                  error={friendHistoryError}
                  onBack={() => setActivePage('overview')}
                  onAddExpense={() => openFriendExpenseForm()}
                  onRefresh={refreshFriendHistory}
                  onOpenExpense={setSelectedExpense}
                  openSettlementOnLoad={friendSettlementAutoOpen}
                />
              </section>
            </div>
          ) : activePage === 'friends' ? (
            <div className="friend-management-page">
              <div className="friend-management-heading">
                <div>
                  <p className="eyebrow">YOUR PEOPLE</p>
                  <h1>Friends</h1>
                  <p>Manage your friends, requests, and connections.</p>
                </div>
                <div className="friend-qr-actions">
                  <button className="primary-action" type="button" onClick={() => { setFriendError(''); setShowAddFriend(true); }}>+ Add a friend</button>
                  <button className="quiet-button" type="button" onClick={openFriendInvite}>Show my QR</button>
                  <button className="quiet-button" type="button" onClick={() => { setFriendQrError(''); setFriendScannerKey((key) => key + 1); setShowFriendQrScanner(true); }}>Scan QR</button>
                </div>
              </div>

              <section className="friend-referral-card" aria-labelledby="friend-referral-heading">
                <div>
                  <p className="eyebrow">INVITE & EARN</p>
                  <h2 id="friend-referral-heading">Refer a friend</h2>
                  <p>You and your friend each get 10 points when they join and verify their email.</p>
                </div>
                <button className="primary-action" type="button" onClick={openReferralModal}>
                  Get your referral link
                </button>
              </section>

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
                      <button type="button" className="friend-profile-main friend-profile-open" onClick={() => void openFriendDetails(friend)}>
                        {friend.coverimage
                          ? <img className="friend-profile-photo" src={friend.coverimage} alt={`${friend.fullnamae || friend.username}'s profile`} />
                          : <span className="friend-profile-photo friend-profile-photo-fallback">{(friend.fullnamae || friend.username).slice(0, 1).toUpperCase()}</span>}
                        <div className="friend-profile-identity">
                          <h2>{friend.fullnamae || friend.username}</h2>
                          <span>@{friend.username}</span>
                        </div>
                      </button>
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
                  <p>Add a friend by username or email, or connect directly by scanning each other’s QR code.</p>
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
              expenses={personalFriendId ? personalFriendExpenses : personalExpenses}
              title={personalFriendId
                ? `Personal expenses with ${friends.find((friend) => friend._id === personalFriendId)?.fullnamae || friends.find((friend) => friend._id === personalFriendId)?.username || 'friend'}`
                : 'Personal expenses'}
              description={personalFriendId
                ? 'Only one-to-one expenses between you and this friend. Group expenses stay in All expenses.'
                : 'Your private spending, organized month by month.'}
              onAddExpense={() => personalFriendId
                ? openFriendExpenseForm(friends.find((friend) => friend._id === personalFriendId))
                : openExpenseForm('')}
              onOpenExpense={setSelectedExpense}
              userId={user._id}
              friends={friends}
              selectedFriendId={personalFriendId}
              onFriendChange={changePersonalFriend}
              friendExpensesError={personalFriendExpensesError}
              friendExpensesBusy={personalFriendExpensesBusy}
            />
          ) : activePage === 'all-expenses' ? (
            <ExpenseLedger
              expenses={allExpenses}
              title="All expenses"
              description="Every expense from all the groups you belong to, organized by month."
              onAddExpense={() => openExpenseForm('')}
              onOpenExpense={setSelectedExpense}
              userId={user._id}
              groupExpenses
            />
          ) : activePage === 'recent' ? (
            <RecentActivityPage
              transactions={recentActivity}
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
              <button
                className="quiet-button settle-up-dashboard-button"
                type="button"
                onClick={() => setShowSettleUpChooser(true)}
              >
                Settle up
              </button>
            </div>
          </div>
          {formMessage && (
            <p className="error-message dashboard-message">{formMessage}</p>
          )}
          <div className="stat-grid dashboard-stat-grid">
            <Stat
              label="TRACKED EXPENSES"
              value={expenses.filter((expense) => !['ACTIVITY', 'SETTLEMENT'].includes(expense.type)).length.toString().padStart(2, "0")}
              note="from your connected account"
              highlight
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
              value={dashboardBalancesBusy
                ? 'Loading…'
                : dashboardBalanceSummary
                  ? `${dashboardBalanceSummary.currency} ${Number(dashboardBalanceSummary.totalBalance).toFixed(2)}`
                  : '—'}
              note="net across groups and friends"
              highlight
            />
            <Stat
              label="YOU OWE"
              value={dashboardBalancesBusy
                ? 'Loading…'
                : dashboardBalanceSummary
                  ? `${dashboardBalanceSummary.currency} ${Number(dashboardBalanceSummary.youOwe).toFixed(2)}`
                  : '—'}
              note="across your groups and friends"
            />
            <Stat
              label="YOU ARE OWED"
              value={dashboardBalancesBusy
                ? 'Loading…'
                : dashboardBalanceSummary
                  ? `${dashboardBalanceSummary.currency} ${Number(dashboardBalanceSummary.youAreOwed).toFixed(2)}`
                  : '—'}
              note="across your groups and friends"
            />
          </div>
          {dashboardBalancesError && <p className="error-message">{dashboardBalancesError}</p>}
          <div className="balance-columns">
            <Panel title="You owe" eyebrow="OUTGOING BALANCES">
              {dashboardBalancesBusy ? (
                <p className="empty-state">Loading your balances…</p>
              ) : dashboardBalanceSummary?.outgoingBalances.length ? (
                dashboardBalanceSummary.outgoingBalances.map((balance) => (
                    <BalanceRow
                      key={balance.id}
                      name={balance.name}
                      amount={`${dashboardBalanceSummary.currency} ${Number(balance.youOwe).toFixed(2)}`}
                      tone="coral"
                    />
                  ))
              ) : (
                <p className="empty-state">You don’t owe anyone yet.</p>
              )}
            </Panel>
            <Panel title="You are owed" eyebrow="INCOMING BALANCES">
              {dashboardBalancesBusy ? (
                <p className="empty-state">Loading your balances…</p>
              ) : dashboardBalanceSummary?.incomingBalances.length ? (
                dashboardBalanceSummary.incomingBalances.map((balance) => (
                    <BalanceRow
                      key={balance.id}
                      name={balance.name}
                      amount={`${dashboardBalanceSummary.currency} ${Number(balance.youAreOwed).toFixed(2)}`}
                      tone="mint"
                    />
                  ))
              ) : (
                <p className="empty-state">Nobody owes you yet.</p>
              )}
            </Panel>
          </div>
          <SpendingInsights
            transactions={dashboardSpendingTransactions}
            members={dashboardSpendingMembers}
            userId={user._id}
            personalOnly
            balanceSummary={dashboardBalanceSummary}
            balanceSummaryBusy={dashboardBalancesBusy}
            scopeLabel="ALL YOUR SPENDING"
          />
          </>
          )}
          {showSettleUpChooser && (
            <Modal title="Settle up" onClose={() => setShowSettleUpChooser(false)} className="settle-up-chooser-modal">
              <p className="modal-help">Choose someone you owe to open the payment form for their group or friend balance.</p>
              {dashboardBalancesBusy ? (
                <p className="empty-state">Loading your balances…</p>
              ) : settleUpOptions.length ? (
                <div className="settle-up-options">
                  {settleUpOptions.map((option) => (
                    <button
                      className="settle-up-option"
                      key={option.id}
                      type="button"
                      onClick={() => openSettleUpOption(option)}
                    >
                      <span>
                        <strong>{option.target
                          ? option.type === 'friend'
                            ? option.target.fullnamae || option.target.username
                            : option.target.name
                          : option.name}</strong>
                        <small>{option.type === 'friend' ? 'Friend balance' : 'Group balance'}</small>
                      </span>
                      <b>{dashboardBalanceSummary.currency} {Number(option.youOwe).toFixed(2)}</b>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="empty-state">You don’t have any outstanding balances to settle.</p>
              )}
            </Modal>
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
          {showFriendQr && (
            <Modal title="My friend code" onClose={() => setShowFriendQr(false)}>
              <div className="friend-qr-modal">
                <p className="modal-help">Share this QR code or link. Anyone who uses it can connect with you directly without a friend request.</p>
                {friendQrBusy && <p className="modal-help">Loading your friend code…</p>}
                {friendInvite && (
                  <>
                    <div className="friend-qr-code">
                      <QRCodeCanvas value={friendInvite.url} size={240} level="M" />
                    </div>
                    <a className="friend-invite-link" href={friendInvite.url}>{friendInvite.url}</a>
                    <div className="friend-invite-actions">
                      <button className="quiet-button" type="button" onClick={shareFriendInvite}>Share link</button>
                      <button className="quiet-button" type="button" onClick={copyFriendInvite}>Copy link</button>
                    </div>
                    <p className="friend-qr-expiry">Your code stays the same until you change it. Changing the code disables this QR and any links you have already shared.</p>
                  </>
                )}
                {friendQrError && <p className="error-message" role="alert">{friendQrError}</p>}
                <button className="quiet-button friend-code-change" type="button" onClick={changeFriendInviteCode} disabled={friendQrBusy}>
                  Change my code
                </button>
              </div>
            </Modal>
          )}
          {showReferralModal && (
            <Modal title="Refer a friend" onClose={() => setShowReferralModal(false)}>
              <div className="friend-qr-modal">
                <p className="modal-help">Invite a friend to create a SplitCare account. You both earn 10 points after they finish signup and verify their email.</p>
                {referralBusy && <p className="modal-help">Loading your referral link…</p>}
                {referralDetails && (
                  <>
                    <p className="referral-points-balance">
                      <strong>{referralDetails.pointsEarned}</strong>
                      <span>points earned</span>
                    </p>
                    <a className="friend-invite-link" href={referralDetails.url}>{referralDetails.url}</a>
                    <div className="friend-invite-actions">
                      <button className="quiet-button" type="button" onClick={shareReferralLink}>Share referral link</button>
                      <button className="quiet-button" type="button" onClick={copyReferralLink}>Copy link</button>
                    </div>
                    <p className="friend-qr-expiry">Points are tracked for future membership rewards. Membership redemption is not available yet.</p>
                  </>
                )}
                {referralError && <p className="error-message" role="alert">{referralError}</p>}
              </div>
            </Modal>
          )}
          {showFriendQrScanner && (
            <Modal title="Scan a friend QR code" onClose={() => {
              if (!friendQrBusy) {
                setShowFriendQrScanner(false);
                setFriendQrError('');
              }
            }}>
              <div className="friend-qr-modal">
                <p className="modal-help">Allow camera access and scan another user’s active SplitCare QR code to connect directly.</p>
                <FriendQrScanner key={friendScannerKey} onScan={handleFriendQrScan} onError={setFriendQrError} />
                {friendQrBusy && <p className="modal-help">Connecting…</p>}
                {friendQrError && <p className="error-message" role="alert">{friendQrError}</p>}
                {friendQrError && !friendQrBusy && (
                  <button className="quiet-button" type="button" onClick={() => setFriendScannerKey((key) => key + 1)}>
                    Scan again
                  </button>
                )}
              </div>
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

                {expenseTargetFriend && editingExpenseId ? (
                  <label>Expense with
                    <input value={expenseTargetFriend.fullnamae || expenseTargetFriend.username} readOnly />
                  </label>
                ) : (
                  <label>Group
                    <select value={expenseDraft.groupId} onChange={(event) => changeExpenseGroup(event.target.value)} disabled={Boolean(editingExpenseId)}>
                      <option value="">Personal expense</option>
                      {groups.map((group) => <option key={group._id} value={group._id}>{group.name}</option>)}
                    </select>
                  </label>
                )}
                {!expenseDraft.groupId && !editingExpenseId && (
                  <label>Split personal expense with
                    <select value={friendExpenseTarget || ''} onChange={(event) => changeExpenseFriend(event.target.value)}>
                      <option value="">Only me</option>
                      {friends.map((friend) => (
                        <option key={friend._id} value={friend._id}>{friend.fullnamae || friend.username}</option>
                      ))}
                    </select>
                  </label>
                )}

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
                          disabled={Boolean(expenseTargetFriend)}
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
            <Modal title="Your profile" onClose={() => setShowProfile(false)} closeOnBackdrop={false}>
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
                <label>Username<input name="username" value={profileForm.username} onChange={updateProfileField} maxLength="40" disabled={Number(user.usernameChangeCount || 0) >= 2} required /></label>
                <p className="username-change-limit" role="status">
                  {Number(user.usernameChangeCount || 0) >= 2
                    ? 'You have used both lifetime username changes.'
                    : `You can change your username ${2 - Number(user.usernameChangeCount || 0)} more ${2 - Number(user.usernameChangeCount || 0) === 1 ? 'time' : 'times'}.`}
                </p>
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
                <label>Current email<input type="email" value={profileForm.email} readOnly /></label>
                <button
                  className="password-update-toggle"
                  type="button"
                  aria-expanded={emailChangeEnabled}
                  aria-controls="profile-email-change"
                  onClick={() => {
                    setEmailChangeEnabled((enabled) => !enabled);
                    setEmailChangeCodesSent(false);
                    setOldEmailCode('');
                    setNewEmailCode('');
                    setEmailChangeError('');
                  }}
                >
                  {emailChangeEnabled ? 'Cancel email update' : 'Update email'}
                </button>
                {emailChangeEnabled && (
                  <section className="profile-email-change" id="profile-email-change" aria-labelledby="email-change-heading">
                    <h3 id="email-change-heading">Change email address</h3>
                    <p>Verification codes will be sent to your current email and the new email. The new address must not already belong to another account.</p>
                    <label>New email<input type="email" value={newEmail} onChange={(event) => {
                      setNewEmail(event.target.value);
                      setEmailChangeCodesSent(false);
                      setOldEmailCode('');
                      setNewEmailCode('');
                      setEmailChangeError('');
                    }} placeholder="new-address@example.com" required={emailChangeCodesSent} /></label>
                    {!emailChangeCodesSent ? (
                      <button className="verify-password-button" type="button" onClick={sendEmailChangeCodes} disabled={emailChangeBusy || !newEmail.trim()}>
                        {emailChangeBusy ? 'Sending codes…' : 'Send verification codes'}
                      </button>
                    ) : (
                      <>
                        <label>Code sent to current email<input type="text" inputMode="numeric" autoComplete="one-time-code" value={oldEmailCode} onChange={(event) => setOldEmailCode(event.target.value.replace(/\D/g, '').slice(0, 6))} maxLength="6" placeholder="6-digit code" /></label>
                        <label>Code sent to new email<input type="text" inputMode="numeric" autoComplete="one-time-code" value={newEmailCode} onChange={(event) => setNewEmailCode(event.target.value.replace(/\D/g, '').slice(0, 6))} maxLength="6" placeholder="6-digit code" /></label>
                        <button className="verify-password-button" type="button" onClick={sendEmailChangeCodes} disabled={emailChangeBusy}>
                          Resend both codes
                        </button>
                        <button className="submit-button" type="button" onClick={verifyAndChangeEmail} disabled={emailChangeBusy || oldEmailCode.length !== 6 || newEmailCode.length !== 6}>
                          {emailChangeBusy ? 'Verifying…' : 'Verify both and change email'}
                        </button>
                      </>
                    )}
                    {emailChangeError && <p className="error-message" role="alert">{emailChangeError}</p>}
                  </section>
                )}
                <label>Full name<input name="fullnamae" value={profileForm.fullnamae} onChange={updateProfileField} required /></label>
                <label>Phone<input name="phone" value={profileForm.phone} onChange={updateProfileField} placeholder="Optional" /></label>
                <label>Default currency
                  <select name="defaultCurrency" value={profileForm.defaultCurrency} onChange={updateProfileField}>
                    <option value="INR">INR ₹</option><option value="USD">USD $</option><option value="EUR">EUR €</option>
                    <option value="GBP">GBP £</option><option value="CAD">CAD $</option><option value="AUD">AUD $</option>
                  </select>
                  <small>Friend balances are converted using the latest daily exchange rates.</small>
                </label>
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
              <button className="submit-button profile-logout" type="button" onClick={onLogout}>Log out</button>
              <section className="profile-danger-zone" aria-labelledby="delete-account-heading">
                <h3 id="delete-account-heading">Delete account permanently</h3>
                <p>This permanently deletes your account and associated data, including groups you created and shared expenses you participated in. This cannot be undone.</p>
                {!deleteCodeSent ? (
                  <button className="danger-button" type="button" onClick={sendAccountDeletionCode} disabled={deleteAccountBusy}>
                    {deleteAccountBusy ? 'Sending code…' : 'Email me a confirmation code'}
                  </button>
                ) : (
                  <>
                    <p className="modal-help">Enter the code sent to {user.email}, then type DELETE to confirm.</p>
                    <button className="text-button" type="button" onClick={resendAccountDeletionCode} disabled={deleteAccountBusy}>
                      Resend confirmation code
                    </button>
                    <label>
                      Email confirmation code
                      <input
                        type="text"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        value={deleteCode}
                        onChange={(event) => setDeleteCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                        placeholder="6-digit code"
                        maxLength="6"
                      />
                    </label>
                    <label>
                      Type DELETE to confirm
                      <input
                        type="text"
                        value={deleteConfirmation}
                        onChange={(event) => setDeleteConfirmation(event.target.value)}
                        autoComplete="off"
                      />
                    </label>
                    {deleteAccountError && <p className="error-message" role="alert">{deleteAccountError}</p>}
                    <button className="danger-button" type="button" onClick={deleteAccount} disabled={deleteAccountBusy || deleteCode.length !== 6 || deleteConfirmation !== 'DELETE'}>
                      {deleteAccountBusy ? 'Deleting account…' : 'Delete my account permanently'}
                    </button>
                  </>
                )}
                {!deleteCodeSent && deleteAccountError && <p className="error-message" role="alert">{deleteAccountError}</p>}
              </section>
            </Modal>
          )}
          {showEmailSettings && (
            <Modal title="Email notification settings" onClose={() => setShowEmailSettings(false)}>
              <div className="email-notification-settings">
                <p>Choose which SplitCare activity updates you want delivered to {user.email}.</p>
                {emailSettingsBusy && <p className="modal-help">Loading email settings…</p>}
                <fieldset disabled={emailSettingsBusy}>
                  <legend>Groups and friends</legend>
                  <label><input type="checkbox" checked={emailNotificationPreferences.groupAdded} onChange={(event) => setEmailNotificationPreferences((current) => ({ ...current, groupAdded: event.target.checked }))} /> When someone adds me to a group</label>
                  <label><input type="checkbox" checked={emailNotificationPreferences.friendAdded} onChange={(event) => setEmailNotificationPreferences((current) => ({ ...current, friendAdded: event.target.checked }))} /> When someone sends me a friend request</label>
                </fieldset>
                <fieldset disabled={emailSettingsBusy}>
                  <legend>Expenses</legend>
                  <label><input type="checkbox" checked={emailNotificationPreferences.expenseAdded} onChange={(event) => setEmailNotificationPreferences((current) => ({ ...current, expenseAdded: event.target.checked }))} /> When an expense is added</label>
                  <label><input type="checkbox" checked={emailNotificationPreferences.expenseChanged} onChange={(event) => setEmailNotificationPreferences((current) => ({ ...current, expenseChanged: event.target.checked }))} /> When an expense is edited or deleted</label>
                  <label><input type="checkbox" checked={emailNotificationPreferences.expenseComment} onChange={(event) => setEmailNotificationPreferences((current) => ({ ...current, expenseComment: event.target.checked }))} /> When someone comments on an expense</label>
                  <label><input type="checkbox" checked={emailNotificationPreferences.expenseDue} onChange={(event) => setEmailNotificationPreferences((current) => ({ ...current, expenseDue: event.target.checked }))} /> When someone sends me a payment request</label>
                  <label><input type="checkbox" checked={emailNotificationPreferences.paymentReceived} onChange={(event) => setEmailNotificationPreferences((current) => ({ ...current, paymentReceived: event.target.checked }))} /> When someone pays me</label>
                </fieldset>
                <fieldset disabled={emailSettingsBusy}>
                  <legend>News and updates</legend>
                  <label><input type="checkbox" checked={emailNotificationPreferences.monthlySummary} onChange={(event) => setEmailNotificationPreferences((current) => ({ ...current, monthlySummary: event.target.checked }))} /> Monthly summary of my activity</label>
                  <label><input type="checkbox" checked={emailNotificationPreferences.productUpdates} onChange={(event) => setEmailNotificationPreferences((current) => ({ ...current, productUpdates: event.target.checked }))} /> Major SplitCare news and updates</label>
                  <p>Product announcements are not currently published by the app.</p>
                </fieldset>
                {emailSettingsError && <p className="error-message" role="alert">{emailSettingsError}</p>}
                {emailSettingsMessage && <p className="success-message" role="status">{emailSettingsMessage}</p>}
                <button className="submit-button" type="button" onClick={saveEmailNotificationSettings} disabled={emailSettingsBusy}>
                  {emailSettingsBusy ? 'Saving…' : 'Save email settings'}
                </button>
              </div>
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
              openSettlementOnLoad={settleGroupAutoOpenId === selectedGroup._id}
              settingsBusy={groupSettingsBusy}
              settingsError={groupSettingsError}
              addMemberBusy={addMemberBusy}
              addMemberError={addMemberError}
              friends={friends}
              friendRequests={friendRequests}
              sentFriendRequests={sentFriendRequests}
              user={user}
              onClose={() => {
                setSelectedGroup(null);
                setSettleGroupAutoOpenId('');
              }}
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
              onPreviewSplitwise={(file) => previewGroupSplitwiseImport(selectedGroup._id, file)}
              onImportSplitwise={(file, mappings) => importGroupSplitwiseHistory(selectedGroup._id, file, mappings)}
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
              group={groups.find((item) => item._id === selectedExpense.groupId)
                || (selectedExpenseFriendGroup ? { _id: selectedExpenseFriendGroup.groupId, name: selectedExpenseFriendGroup.groupName } : personalGroup)}
              members={groups.find((item) => item._id === selectedExpense.groupId)?.members
                || (selectedExpenseFriendGroup && selectedExpenseFriend ? [user, selectedExpenseFriend] : [user])}
              userId={user._id}
              accessToken={accessToken}
              onClose={() => setSelectedExpense(null)}
              onEdit={() => editExpense(selectedExpense)}
              onDelete={() => removeExpense(selectedExpense)}
              onCommentAdded={async () => {
                setExpenses(await apiRequest('/expenses?history=true', { headers: authHeaders }));
                if (selectedGroup?._id === selectedExpense.groupId) await openGroupDetails(selectedGroup);
                if (selectedFriend && friendHistory?.groups.some((group) => group.groupId === selectedExpense.groupId && group.isDirect)) {
                  await loadFriendHistory(selectedFriend);
                }
                if (personalFriendId && selectedExpense.isDirect) await loadPersonalFriendExpenses(personalFriendId);
                if (selectedExpense.isDirect) await refreshFriendActivity();
              }}
            />
          )}
        </section>
        {activePage === 'overview' && <aside className="dashboard-right-rail">
          <p className="eyebrow">EARLY MEMBER OFFER</p>
          <div className="plus-mark">✦</div>
          <h2>Get 1–2 years of membership.</h2>
          <p>
            The first 1,000 early registrants can get 1–2 years of SplitCare
            membership when paid plans launch. Refer friends to earn points
            toward claiming a membership.
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
  openSettlementOnLoad = false,
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
  onPreviewSplitwise,
  onImportSplitwise,
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
  const autoSettlementOpenedRef = useRef(false);
  const [paymentRequestOpen, setPaymentRequestOpen] = useState(false);
  const [paymentRequestDraft, setPaymentRequestDraft] = useState({ memberId: '', amount: '', currency: 'INR', note: '' });
  const [paymentRequestError, setPaymentRequestError] = useState('');
  const [paymentRequestBusy, setPaymentRequestBusy] = useState(false);
  const [splitwiseFile, setSplitwiseFile] = useState(null);
  const [splitwisePreview, setSplitwisePreview] = useState(null);
  const [splitwiseMemberMappings, setSplitwiseMemberMappings] = useState({});
  const [splitwiseBusy, setSplitwiseBusy] = useState(false);
  const [splitwiseError, setSplitwiseError] = useState('');
  const [splitwiseMessage, setSplitwiseMessage] = useState('');
  const splitwiseFileInputRef = useRef(null);
  const isOwner = group.createdBy === user._id;
  const previewSplitwiseFile = async (file) => {
    setSplitwiseFile(file);
    setSplitwisePreview(null);
    setSplitwiseMemberMappings({});
    setSplitwiseError('');
    setSplitwiseMessage('');
    if (!file) return;
    setSplitwiseBusy(true);
    try {
      const preview = await onPreviewSplitwise(file);
      const mappings = {};
      preview.memberNames.forEach((splitwiseName) => {
        const normalizedName = splitwiseName.trim().toLocaleLowerCase();
        const matchingMember = group.members?.find((member) => (
          [member.fullnamae, member.username].some((name) => name?.trim().toLocaleLowerCase() === normalizedName)
        ));
        if (matchingMember) mappings[splitwiseName] = matchingMember._id;
      });
      setSplitwisePreview(preview);
      setSplitwiseMemberMappings(mappings);
    } catch (error) {
      setSplitwiseError(error.message);
    } finally {
      setSplitwiseBusy(false);
    }
  };
  const submitSplitwiseImport = async () => {
    if (!splitwiseFile || !splitwisePreview) return;
    if (splitwisePreview.memberNames.some((name) => !splitwiseMemberMappings[name])) {
      setSplitwiseError('Choose a SplitCare group member for every Splitwise member before importing.');
      return;
    }
    if (new Set(Object.values(splitwiseMemberMappings)).size !== splitwisePreview.memberNames.length) {
      setSplitwiseError('Map each Splitwise member to a different SplitCare group member.');
      return;
    }
    const confirmed = window.confirm(
      `Import ${splitwisePreview.transactionCount} historical transactions into ${group.name}? This changes group balances. The same CSV cannot be imported twice.`,
    );
    if (!confirmed) return;
    setSplitwiseBusy(true);
    setSplitwiseError('');
    setSplitwiseMessage('');
    try {
      const result = await onImportSplitwise(splitwiseFile, splitwiseMemberMappings);
      setSplitwiseMessage(
        `Imported ${result.sourceTransactions} Splitwise transactions (${result.expenseCount} expense records and ${result.paymentCount} payments).`,
      );
      setSplitwiseFile(null);
      setSplitwisePreview(null);
      setSplitwiseMemberMappings({});
      if (splitwiseFileInputRef.current) splitwiseFileInputRef.current.value = '';
    } catch (error) {
      setSplitwiseError(error.message);
    } finally {
      setSplitwiseBusy(false);
    }
  };
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
  const exportSplitwiseCsv = () => {
    const ledgerEntries = transactions
      .filter((transaction) => ['EXPENSE', 'REIMBURSEMENT', 'SETTLEMENT', 'FRIEND_SETTLEMENT'].includes(transaction.type))
      .sort((first, second) => new Date(first.createdAt) - new Date(second.createdAt));
    const membersById = new Map((group.members || []).map((member) => [member._id, member]));
    ledgerEntries.forEach((transaction) => {
      [[transaction.paidBy, transaction.paidByName, transaction.paidByUsername],
        [transaction.paidTo, transaction.paidToName, transaction.paidToUsername],
        ...(transaction.splits || []).map((split) => [split.userId, split.fullnamae, split.username])]
        .forEach(([userId, fullnamae, username]) => {
          if (!userId || membersById.has(userId)) return;
          membersById.set(userId, {
            _id: userId,
            username: username || userId.slice(0, 8),
            fullnamae: fullnamae || `Former member ${userId.slice(0, 6)}`,
          });
        });
    });
    const members = [...membersById.values()];
    const countsByName = new Map();
    members.forEach((member) => {
      const name = member.fullnamae || member.username;
      countsByName.set(name, (countsByName.get(name) || 0) + 1);
    });
    const memberColumns = members.map((member) => {
      const name = member.fullnamae || member.username;
      return countsByName.get(name) > 1 ? `${name} (@${member.username})` : name;
    });
    const csvCell = (value, isText = false) => {
      let text = String(value ?? '');
      if (isText && /^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
      return `"${text.replaceAll('"', '""')}"`;
    };
    const cents = (value) => Math.round((Number(value) || 0) * 100);
    const formatCents = (value) => {
      const amount = (Math.abs(value) / 100).toFixed(2).replace(/\.?0+$/, '');
      return `${value < 0 ? '-' : ''}${amount}`;
    };
    const rows = [
      ['Date', 'Description', 'Category', 'Cost', 'Currency', ...memberColumns],
    ];
    const totalsByCurrency = new Map();

    ledgerEntries.forEach((transaction) => {
      const memberBalances = new Map(members.map((member) => [member._id, 0]));
      const totalCents = cents(transaction.totalAmount);
      if (['SETTLEMENT', 'FRIEND_SETTLEMENT'].includes(transaction.type)) {
        memberBalances.set(transaction.paidBy, (memberBalances.get(transaction.paidBy) || 0) + totalCents);
        memberBalances.set(transaction.paidTo, (memberBalances.get(transaction.paidTo) || 0) - totalCents);
      } else {
        memberBalances.set(transaction.paidBy, (memberBalances.get(transaction.paidBy) || 0) + totalCents);
        transaction.splits?.forEach((split) => {
          memberBalances.set(split.userId, (memberBalances.get(split.userId) || 0) - cents(split.amountOwed));
        });
      }
      const currency = transaction.currency || 'INR';
      const totals = totalsByCurrency.get(currency) || new Map(members.map((member) => [member._id, 0]));
      memberBalances.forEach((amount, userId) => totals.set(userId, (totals.get(userId) || 0) + amount));
      totalsByCurrency.set(currency, totals);
      rows.push([
        new Date(transaction.createdAt).toISOString().slice(0, 10),
        transaction.description,
        ['SETTLEMENT', 'FRIEND_SETTLEMENT'].includes(transaction.type) ? 'Payment' : transaction.category || 'General',
        formatCents(totalCents),
        currency,
        ...members.map((member) => formatCents(memberBalances.get(member._id) || 0)),
      ]);
    });

    // Splitwise's final summary row has no currency-aware representation for mixed-currency groups.
    if (totalsByCurrency.size === 1) {
      const [[currency, totals]] = totalsByCurrency;
      rows.push([
        new Date().toISOString().slice(0, 10),
        'Total balance',
        '',
        '',
        currency,
        ...members.map((member) => formatCents(totals.get(member._id) || 0)),
      ]);
    }

    const csv = rows.map((row, rowIndex) => row.map((value, index) => (
      csvCell(value, (rowIndex === 0 && index >= 5) || (rowIndex > 0 && (index === 1 || index === 2)))
    )).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${group.name.replace(/[^a-z0-9-_]+/gi, '-')}-splitwise.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
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
  useEffect(() => {
    if (!openSettlementOnLoad || transactionsBusy || balancesBusy || settlementsBusy || autoSettlementOpenedRef.current) return;
    autoSettlementOpenedRef.current = true;
    setActiveTab('balances');
    onSettle();
    openSettlementForm();
  }, [openSettlementOnLoad, transactionsBusy, balancesBusy, settlementsBusy]);
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
                <SpendingInsights transactions={transactions} members={group.members || []} userId={user._id} />
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
                <section className="splitwise-import-panel">
                  <h4>Import Splitwise history</h4>
                  <p className="modal-help">
                    Upload a Splitwise CSV export, then match every CSV member to a member of this group.
                    Historical expense dates and payments are kept. Add any missing people to the group first.
                    Re-importing the same file is blocked to prevent duplicate history.
                  </p>
                  <label>
                    Splitwise CSV file
                    <input
                      ref={splitwiseFileInputRef}
                      type="file"
                      accept=".csv,text/csv"
                      disabled={splitwiseBusy}
                      onChange={(event) => void previewSplitwiseFile(event.target.files?.[0] || null)}
                    />
                  </label>
                  {splitwiseBusy && <p className="modal-help">Reading or importing CSV…</p>}
                  {splitwisePreview && (
                    <div className="splitwise-import-preview">
                      <p>
                        Found {splitwisePreview.transactionCount} transactions:
                        {' '}{splitwisePreview.expenseCount} expenses and {splitwisePreview.paymentCount} payments.
                        {splitwisePreview.summaryRows > 0 && ` Skipping ${splitwisePreview.summaryRows} total-balance summary row.`}
                      </p>
                      {splitwisePreview.multiPayerExpenses > 0 && (
                        <p className="modal-help">
                          {splitwisePreview.multiPayerExpenses} expense(s) have multiple payers. Splitwise does not include their original individual shares, so exact pairwise balances cannot be recovered for those expenses. SplitCare estimates those shares while preserving the transaction totals and each member's net balance.
                        </p>
                      )}
                      {splitwisePreview.memberNames.map((splitwiseName) => (
                        <label className="splitwise-member-mapping" key={splitwiseName}>
                          <span>{splitwiseName}</span>
                          <select
                            value={splitwiseMemberMappings[splitwiseName] || ''}
                            onChange={(event) => setSplitwiseMemberMappings((current) => ({
                              ...current,
                              [splitwiseName]: event.target.value,
                            }))}
                          >
                            <option value="">Choose a group member</option>
                            {(group.members || []).map((member) => (
                              <option
                                key={member._id}
                                value={member._id}
                                disabled={Object.entries(splitwiseMemberMappings).some(
                                  ([mappedName, userId]) => mappedName !== splitwiseName && userId === member._id,
                                )}
                              >
                                {member.fullnamae || member.username} (@{member.username}) · {member._id}
                              </option>
                            ))}
                          </select>
                          {splitwiseMemberMappings[splitwiseName] && (
                            <small>Mapped SplitCare user ID: {splitwiseMemberMappings[splitwiseName]}</small>
                          )}
                        </label>
                      ))}
                      <button
                        className="group-setting-button"
                        type="button"
                        onClick={() => void submitSplitwiseImport()}
                        disabled={splitwiseBusy
                          || splitwisePreview.memberNames.some((name) => !splitwiseMemberMappings[name])
                          || new Set(Object.values(splitwiseMemberMappings)).size !== splitwisePreview.memberNames.length}
                      >
                        Import history into group
                      </button>
                    </div>
                  )}
                  {splitwiseError && <p className="error-message" role="alert">{splitwiseError}</p>}
                  {splitwiseMessage && <p className="success-message" role="status">{splitwiseMessage}</p>}
                </section>
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
                <button className="group-setting-button" type="button" onClick={exportSplitwiseCsv}>Export data as CSV</button>
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
  personalLedger = false,
}) {
  // Grouping once here lets the activity feed render a heading for each calendar month.
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
            const isSettlement = ['SETTLEMENT', 'FRIEND_SETTLEMENT'].includes(transaction.type);
            const total = Number(transaction.totalAmount) || 0;
            const ownSplit = Number(transaction.splits?.find((split) => split.userId === userId)?.amountOwed || 0);
            const isPayer = transaction.paidBy === userId;
            const payerName = transaction.paidByName || transaction.paidByUsername || 'A member';
            let shareLabel = 'not involved';
            let shareAmount = null;
            let shareClass = 'not-involved';

            if (personalLedger) {
              shareLabel = 'you spent';
              shareAmount = total;
              shareClass = 'activity-share-negative';
            } else if (isSettlement && transaction.paidTo === userId) {
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
                  <strong>{transaction.description || `${payerName} paid ${transaction.paidToName || 'a friend'}`}</strong>
                  {(transaction.note || transaction.comments?.length > 0) && <span className="group-activity-comment" aria-label="Has a note or comments">●</span>}
                  <small>
                    {transaction.groupName && !personalLedger ? `${transaction.groupName} · ` : ''}
                    {transaction.category || 'Uncategorized'}
                    {transaction.subcategory ? ` · ${transaction.subcategory}` : ''}
                    {isSettlement ? ` · ${payerName} paid ${transaction.paidToName || 'a member'}` : ''}
                    {transaction.type === 'FRIEND_SETTLEMENT' && transaction.allocations?.length
                      ? ` · Applied to ${transaction.allocations.map((allocation) => `${allocation.groupName} (${allocation.currency} ${Number(allocation.amount).toFixed(2)})`).join(', ')}`
                      : ''}
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
        <small>current balance</small>
      </div>
      <strong className={tone === 'coral' ? 'balance-amount-owed' : ''}>{amount}</strong>
    </div>
  );
}
function Modal({ title, onClose, children, className = '', closeOnBackdrop = true }) {
  return (
    <div className={`modal-backdrop ${className}`} onMouseDown={(event) => {
      event.stopPropagation();
      if (closeOnBackdrop && event.target === event.currentTarget) onClose();
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
