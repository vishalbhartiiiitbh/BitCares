import { sendContactReportEmail } from '../services/emailService.js';

const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const requireText = (value, label, maxLength) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw Object.assign(new Error(`${label} is required`), { statusCode: 400 });
  }
  const text = value.trim();
  if (text.length > maxLength) {
    throw Object.assign(new Error(`${label} must be ${maxLength} characters or fewer`), { statusCode: 400 });
  }
  return text;
};

const optionalText = (value, label, maxLength) => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') {
    throw Object.assign(new Error(`${label} must be text`), { statusCode: 400 });
  }
  const text = value.trim();
  if (text.length > maxLength) {
    throw Object.assign(new Error(`${label} must be ${maxLength} characters or fewer`), { statusCode: 400 });
  }
  return text;
};

const isSupportedAttachment = (file) => {
  const bytes = file.buffer;
  switch (file.mimetype) {
    case 'application/pdf':
      return bytes.subarray(0, 5).toString('ascii') === '%PDF-';
    case 'image/jpeg':
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/png':
      return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/gif':
      return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
    case 'image/webp':
      return bytes.subarray(0, 4).toString('ascii') === 'RIFF'
        && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    default:
      return false;
  }
};

const safeFilename = (filename) => filename
  .split(/[\\/]/)
  .pop()
  .replace(/[\u0000-\u001f\u007f"]/g, '')
  .slice(0, 180) || 'report-attachment';

export const submitContactReport = async (req, res) => {
  const firstName = requireText(req.body.firstName, 'First name', 80);
  const lastName = optionalText(req.body.lastName, 'Last name', 80);
  const email = requireText(req.body.email, 'Email', 254).toLowerCase();
  const purpose = requireText(req.body.purpose, 'Purpose', 120).replace(/[\u0000-\u001f\u007f]/g, ' ');
  const message = requireText(req.body.message, 'Message', 5000);
  const phone = optionalText(req.body.phone, 'Phone', 30);

  if (!validEmail.test(email)) {
    throw Object.assign(new Error('Enter a valid email address'), { statusCode: 400 });
  }

  const files = req.files || [];
  if (files.some((file) => !isSupportedAttachment(file))) {
    throw Object.assign(new Error('Attachments must be valid PDF, JPEG, PNG, GIF, or WebP files'), { statusCode: 400 });
  }
  if (files.reduce((size, file) => size + file.size, 0) > 10 * 1024 * 1024) {
    throw Object.assign(new Error('Attachments must total 10 MB or less'), { statusCode: 400 });
  }

  const recipient = process.env.CONTACT_EMAIL_TO?.trim();
  if (!recipient) {
    throw Object.assign(new Error('Contact email delivery is not configured. Set CONTACT_EMAIL_TO on the backend.'), { statusCode: 503 });
  }

  const fullName = [firstName, lastName].filter(Boolean).join(' ');
  const text = [
    'A user submitted a contact report through Splitpayerly.',
    '',
    `Name: ${fullName}`,
    `Account email: ${req.user.email}`,
    `Reply email: ${email}`,
    `Phone: ${phone || 'Not provided'}`,
    `Purpose: ${purpose}`,
    '',
    'Message:',
    message,
  ].join('\n');
  const attachments = files.map((file) => ({
    filename: safeFilename(file.originalname),
    content: file.buffer,
    contentType: file.mimetype,
  }));

  await sendContactReportEmail({
    recipient,
    replyTo: email,
    subject: `Splitpayerly contact report: ${purpose}`,
    text,
    attachments,
  });

  res.status(200).json({ data: { message: 'Your report has been sent. Thank you for letting us know.' } });
};