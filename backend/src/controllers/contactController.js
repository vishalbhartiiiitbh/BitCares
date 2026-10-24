import { query, withTransaction } from '../db/index.js';

/** Require non-empty text and enforce the field's maximum length. */
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

/** Normalize an optional text field while rejecting values that exceed its limit. */
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

/** Check file size and inspect its magic bytes instead of trusting the supplied MIME type. */
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

/** Remove path and control characters before using an uploaded filename in headers. */
const safeFilename = (filename) => filename
  .split(/[\\/]/)
  .pop()
  .replace(/[\u0000-\u001f\u007f"]/g, '')
  .slice(0, 180) || 'report-attachment';

/** Guard report and attachment lookups against malformed database identifiers. */
const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
/** Derive the user-facing ticket number from the report's UUID. */
const makeTicketId = (id) => `ENQ-${id.replaceAll('-', '').slice(0, 12).toUpperCase()}`;

/** Save a signed-in user's enquiry, verified attachments, and initial history entry. */
export const submitContactReport = async (req, res) => {
  const purpose = requireText(req.body.purpose, 'Purpose', 120).replace(/[\u0000-\u001f\u007f]/g, ' ');
  const message = requireText(req.body.message, 'Message', 5000);
  const phone = optionalText(req.body.phone, 'Phone', 30);

  const files = req.files || [];
  if (files.some((file) => !isSupportedAttachment(file))) {
    throw Object.assign(new Error('Attachments must be valid PDF, JPEG, PNG, GIF, or WebP files'), { statusCode: 400 });
  }
  if (files.reduce((size, file) => size + file.size, 0) > 10 * 1024 * 1024) {
    throw Object.assign(new Error('Attachments must total 10 MB or less'), { statusCode: 400 });
  }

  const reportId = await withTransaction(async (client) => {
    const reportResult = await client.query(
      `INSERT INTO contact_reports (user_id, full_name, email, phone, purpose, message)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [req.user._id, req.user.fullnamae, req.user.email, phone, purpose, message],
    );
    const id = reportResult.rows[0].id;
    await client.query(
      `INSERT INTO contact_report_updates (report_id, status, note, updater_name)
       VALUES ($1, 'open', 'Enquiry submitted', 'System')`,
      [id],
    );
    for (const file of files) {
      await client.query(
        `INSERT INTO contact_report_attachments
          (report_id, filename, content_type, file_size, content)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, safeFilename(file.originalname), file.mimetype, file.size, file.buffer],
      );
    }
    return id;
  });

  res.status(201).json({
    data: {
      id: reportId,
      ticketId: makeTicketId(reportId),
      message: 'Your enquiry has been submitted and saved. Thank you for contacting us.',
    },
  });
};

const contactReportSelect = `
  SELECT r.id AS "_id",
         'ENQ-' || UPPER(SUBSTRING(REPLACE(r.id::text, '-', '') FROM 1 FOR 12)) AS "ticketId",
         r.full_name AS "fullName", r.email, r.phone, r.purpose,
         r.message, r.status, r.admin_notes AS "adminNotes",
         r.created_at AS "createdAt", r.updated_at AS "updatedAt",
         COALESCE(
           json_agg(json_build_object(
             'id', a.id, 'filename', a.filename, 'contentType', a.content_type,
             'size', a.file_size
           )) FILTER (WHERE a.id IS NOT NULL),
           '[]'::json
         ) AS attachments,
         COALESCE(
           (
             SELECT json_agg(json_build_object(
               'id', u.id, 'status', u.status, 'note', u.note,
               'updatedBy', u.updater_name, 'createdAt', u.created_at
             ) ORDER BY u.created_at ASC)
               FROM contact_report_updates u
              WHERE u.report_id = r.id
           ),
           '[]'::json
         ) AS "statusHistory"
    FROM contact_reports r
    LEFT JOIN contact_report_attachments a ON a.report_id = r.id
`;

/** Return all enquiries with their chronological status and note history for admins. */
export const listContactReports = async (_req, res) => {
  const result = await query(
    `${contactReportSelect}
      GROUP BY r.id
      ORDER BY r.created_at DESC
      LIMIT 200`,
  );
  res.json({ data: result.rows });
};

/** Return only the signed-in user's enquiries and their update histories. */
export const listMyContactReports = async (req, res) => {
  const result = await query(
    `${contactReportSelect}
      WHERE r.user_id = $1
      GROUP BY r.id
      ORDER BY r.created_at DESC
      LIMIT 200`,
    [req.user._id],
  );
  res.json({ data: result.rows });
};

/** Reopen an owned closed enquiry and append the user's comment to its history. */
export const reopenMyContactReport = async (req, res) => {
  if (!isUuid(req.params.reportId)) {
    throw Object.assign(new Error('Enquiry not found'), { statusCode: 404 });
  }
  const { comment } = req.body || {};
  if (typeof comment !== 'string' || !comment.trim() || comment.length > 5000) {
    throw Object.assign(new Error('Add a comment of 5000 characters or fewer before reopening'), { statusCode: 400 });
  }
  const result = await withTransaction(async (client) => {
    const report = await client.query(
      'SELECT id, status FROM contact_reports WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [req.params.reportId, req.user._id],
    );
    if (!report.rowCount) throw Object.assign(new Error('Enquiry not found'), { statusCode: 404 });
    if (report.rows[0].status !== 'closed') {
      throw Object.assign(new Error('Only closed enquiries can be reopened'), { statusCode: 409 });
    }
    const history = await client.query(
      `INSERT INTO contact_report_updates (report_id, status, note, updated_by, updater_name)
       VALUES ($1, 'open', $2, $3, $4)
       RETURNING id, status, note, updater_name AS "updatedBy", created_at AS "createdAt"`,
      [req.params.reportId, comment.trim(), req.user._id, req.user.fullnamae || req.user.username],
    );
    await client.query(
      `UPDATE contact_reports SET status = 'open', updated_at = NOW() WHERE id = $1`,
      [req.params.reportId],
    );
    return history.rows[0];
  });
  res.json({ data: result });
};

/** Append an admin status-and-note update while preserving the enquiry's history. */
export const updateContactReport = async (req, res) => {
  const { status, note } = req.body || {};
  if (!isUuid(req.params.reportId)) {
    throw Object.assign(new Error('Enquiry not found'), { statusCode: 404 });
  }
  if (!['open', 'in_progress', 'closed'].includes(status)) {
    throw Object.assign(new Error('Choose a valid enquiry status'), { statusCode: 400 });
  }
  if (typeof note !== 'string' || !note.trim() || note.length > 5000) {
    throw Object.assign(new Error('Enter an update note of 5000 characters or fewer'), { statusCode: 400 });
  }
  const result = await withTransaction(async (client) => {
    const report = await client.query(
      'SELECT id FROM contact_reports WHERE id = $1 FOR UPDATE',
      [req.params.reportId],
    );
    if (!report.rowCount) throw Object.assign(new Error('Enquiry not found'), { statusCode: 404 });
    const history = await client.query(
      `INSERT INTO contact_report_updates (report_id, status, note, updated_by, updater_name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, status, note, updater_name AS "updatedBy", created_at AS "createdAt"`,
      [req.params.reportId, status, note.trim(), req.user._id, req.user.fullnamae || req.user.username],
    );
    await client.query(
      'UPDATE contact_reports SET status = $1, updated_at = NOW() WHERE id = $2',
      [status, req.params.reportId],
    );
    return history.rows[0];
  });
  res.json({ data: result });
};

/** Stream an attachment only when it belongs to the requested enquiry. */
export const downloadContactReportAttachment = async (req, res) => {
  if (!isUuid(req.params.reportId) || !isUuid(req.params.attachmentId)) {
    throw Object.assign(new Error('Attachment not found'), { statusCode: 404 });
  }
  const result = await query(
    `SELECT filename, content_type AS "contentType", content
       FROM contact_report_attachments
      WHERE report_id = $1 AND id = $2`,
    [req.params.reportId, req.params.attachmentId],
  );
  if (!result.rowCount) throw Object.assign(new Error('Attachment not found'), { statusCode: 404 });
  const attachment = result.rows[0];
  res.set({
    'Content-Type': attachment.contentType,
    'Content-Length': attachment.content.length,
    'Content-Disposition': `attachment; filename="${safeFilename(attachment.filename)}"`,
    'X-Content-Type-Options': 'nosniff',
  });
  res.send(attachment.content);
};