import nodemailer from 'nodemailer';

const createTransporter = () => {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw Object.assign(new Error('Email delivery is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS.'), { statusCode: 503 });
  }

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: SMTP_SECURE === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
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
