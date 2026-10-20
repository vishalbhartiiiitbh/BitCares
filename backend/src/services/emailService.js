import nodemailer from 'nodemailer';

const createTransporter = () => {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw Object.assign(new Error('Email delivery is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS.'), { statusCode: 503 });
  }

 return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 465),
    secure: SMTP_SECURE === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    // --- ADDED TIMEOUTS & DEBUGGING ---
    connectionTimeout: 10000, // Fails after 10 seconds instead of hanging forever
    greetingTimeout: 10000,
    socketTimeout: 10000,
    logger: true,             // Prints successful/failed email attempts to Render logs
    debug: true               // Prints full SMTP traffic to Render logs for troubleshooting
  });
};

export const sendPasswordResetEmail = async (email, resetUrl) => {
  const transporter = createTransporter();
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    to: email,
    subject: 'Reset your SplitCare password',
    text: `Use this link to reset your SplitCare password. It expires in 10 minutes and can only be used once:\n\n${resetUrl}\n\nIf you did not request a password reset, you can ignore this email.`,
    html: `<p>Use the link below to reset your SplitCare password. It expires in 10 minutes and can only be used once.</p><p><a href="${resetUrl}">Reset your password</a></p><p>If you did not request a password reset, you can ignore this email.</p>`,
  });
};

export const sendWelcomeEmail = async (email, fullName) => {
  const transporter = createTransporter();
  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');
  const name = fullName || 'there';
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    to: email,
    subject: 'Welcome to SplitCare',
    text: `Hi ${name},\n\nWelcome to SplitCare! Your account is ready. You can now organize shared expenses, track balances, and settle up with friends.\n\nGet started: ${frontendUrl}\n\nThe SplitCare team`,
    html: `<p>Hi ${name},</p><p>Welcome to SplitCare! Your account is ready. You can now organize shared expenses, track balances, and settle up with friends.</p><p><a href="${frontendUrl}">Get started with SplitCare</a></p><p>The SplitCare team</p>`,
  });
};

export const sendNotificationEmail = async (email, subject, text) => {
  const transporter = createTransporter();
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    to: email,
    subject,
    text,
  });
};

export const sendEmailVerificationCode = async (email, code, purpose) => {
  const transporter = createTransporter();
  const isDeletion = purpose === 'delete_account';
  const isEmailChange = purpose.startsWith('email_change');
  const subject = isDeletion
    ? 'Confirm your SplitCare account deletion'
    : isEmailChange
      ? 'Verify your SplitCare email change'
      : 'Verify your SplitCare email';
  const action = isDeletion
    ? 'confirm your account deletion'
    : isEmailChange
      ? 'verify your email change'
      : 'verify your email address';
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    to: email,
    subject,
    text: `Use this code to ${action}: ${code}\n\nThis code expires in 10 minutes and can only be used once.`,
    html: `<p>Use this code to ${action}:</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px">${code}</p><p>This code expires in 10 minutes and can only be used once.</p>`,
  });
};
