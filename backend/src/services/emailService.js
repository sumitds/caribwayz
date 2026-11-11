const nodemailer = require('nodemailer');
const { escapeHtml } = require('../utils/displayName');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/** How many invitation emails are handed to the mail server at once. */
const INVITE_CONCURRENCY = 2;

/**
 * Sends one invitation email per address, each addressed to that person
 * alone: a shared To: line handed every invitee everyone else's address.
 * At most INVITE_CONCURRENCY go out at a time, so one invite cannot open a
 * burst of connections to the mail server.
 *
 * Every address is tried even when one fails. Returns how many were sent, or
 * throws when any failed: the error says how many, carries the first
 * failure's code and message (.code, .detail), and has .sent with the number
 * that went out.
 */
const sendGroupInvite = async ({ toEmails, groupName, joinCode, inviterName }) => {
  // Checked before anything is sent: a CR/LF could start a new mail header.
  for (const address of toEmails) {
    if (typeof address !== 'string' || /[\r\n,;]/.test(address) || !address.includes('@')) {
      throw new Error('sendGroupInvite: every recipient must be a single valid address');
    }
  }
  const joinLink = `${process.env.APP_DEEP_LINK || 'caribwayz://join'}?code=${encodeURIComponent(joinCode)}`;
  // Group and inviter names are typed by users; escaped so neither can inject
  // markup or links into a mail that goes to other people's inboxes.
  const safeInviter = escapeHtml(inviterName);
  const safeGroup = escapeHtml(groupName);
  const safeCode = escapeHtml(joinCode);
  // Header-safe: a CR/LF in a group name must not start a new mail header.
  const subjectLine = `${inviterName} invited you to join "${groupName}" on CaribWayz`.replace(/[\r\n]+/g, ' ');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;border-radius:12px;background:#f9f9f9;">
      <h2 style="color:#10c329;">You're invited to join a CaribWayz group!</h2>
      <p><strong>${safeInviter}</strong> has invited you to join the group <strong>"${safeGroup}"</strong> on CaribWayz.</p>
      <p style="font-size:14px;color:#555;">Use the join code below inside the CaribWayz app, or tap the button to join directly.</p>
      <div style="text-align:center;margin:24px 0;">
        <span style="font-size:28px;font-weight:bold;letter-spacing:6px;color:#1a1a1a;background:#e8f5e9;padding:12px 24px;border-radius:8px;">${safeCode}</span>
      </div>
      <div style="text-align:center;margin:16px 0;">
        <a href="${escapeHtml(joinLink)}" style="background:#10c329;color:#fff;padding:12px 32px;border-radius:24px;text-decoration:none;font-weight:bold;font-size:16px;">Join Group</a>
      </div>
      <p style="font-size:12px;color:#999;text-align:center;margin-top:24px;">CaribWayz — Navigate Together</p>
    </div>
  `;

  const mailTo = (address) => ({
    from: `"CaribWayz" <${process.env.SMTP_USER}>`,
    to: address,
    subject: subjectLine,
    html,
    text: `${inviterName} invited you to join "${groupName}" on CaribWayz.\n\nYour join code: ${joinCode}\n\nOpen CaribWayz and enter this code to join the group.`,
    headers: {
      'X-Priority': '3',
      'X-Mailer': 'CaribWayz Mailer',
      'List-Unsubscribe': `<mailto:${process.env.SMTP_USER}?subject=unsubscribe>`,
    },
  });

  // Settled results in address order, filled by INVITE_CONCURRENCY workers.
  const results = new Array(toEmails.length);
  let next = 0;
  const worker = async () => {
    while (next < toEmails.length) {
      const index = next;
      next += 1;
      try {
        await transporter.sendMail(mailTo(toEmails[index]));
        results[index] = { status: 'fulfilled' };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(INVITE_CONCURRENCY, toEmails.length) }, worker));

  const failures = results.filter((r) => r.status === 'rejected').map((r) => r.reason || {});
  const sent = results.length - failures.length;
  if (failures.length > 0) {
    const first = failures[0];
    const err = new Error(
      `${failures.length} of ${results.length} invitations could not be sent: ${first.message || String(first)}`
    );
    err.code = first.code;
    err.detail = first.message || String(first);
    err.sent = sent;
    throw err;
  }
  return sent;
};

/**
 * True when outgoing mail has credentials. Without them every send fails, so
 * callers that depend on mail (password reset) say so up front instead of
 * accepting a request they cannot fulfil.
 */
const isEmailConfigured = () =>
  Boolean(process.env.SMTP_USER && process.env.SMTP_USER.trim() &&
    process.env.SMTP_PASS && process.env.SMTP_PASS.trim());

/**
 * Emails a password reset code. [code] is the only copy the person ever gets:
 * the API stores a hash of it and never returns it in a response.
 */
const sendPasswordResetCode = async ({ toEmail, code, expiresInMinutes }) => {
  // One recipient, and nothing that could start a new mail header.
  if (typeof toEmail !== 'string' || /[\r\n,;]/.test(toEmail) || !toEmail.includes('@')) {
    throw new Error('sendPasswordResetCode: a single valid recipient address is required');
  }
  if (typeof code !== 'string' || !/^[0-9]{6}$/.test(code)) {
    throw new Error('sendPasswordResetCode: code must be six digits');
  }
  if (!Number.isInteger(expiresInMinutes) || expiresInMinutes <= 0) {
    throw new Error('sendPasswordResetCode: expiresInMinutes must be a positive whole number');
  }
  const minutes = expiresInMinutes;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;border-radius:12px;background:#f9f9f9;">
      <h2 style="color:#10c329;">Reset your CaribWayz password</h2>
      <p>Enter this code in the CaribWayz app to choose a new password.</p>
      <div style="text-align:center;margin:24px 0;">
        <span style="font-size:28px;font-weight:bold;letter-spacing:6px;color:#1a1a1a;background:#e8f5e9;padding:12px 24px;border-radius:8px;">${escapeHtml(code)}</span>
      </div>
      <p style="font-size:14px;color:#555;">The code expires in ${minutes} minutes and works once. If you did not ask to reset your password, ignore this email; your password has not changed.</p>
      <p style="font-size:12px;color:#999;text-align:center;margin-top:24px;">CaribWayz — Navigate Together</p>
    </div>
  `;

  await transporter.sendMail({
    from: `"CaribWayz" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: 'Your CaribWayz password reset code',
    html,
    text: `Your CaribWayz password reset code is ${code}.\n\nIt expires in ${minutes} minutes and works once. If you did not ask to reset your password, ignore this email; your password has not changed.`,
    headers: {
      'X-Mailer': 'CaribWayz Mailer',
    },
  });
};

/** What a two-step code email says, by what the code is for. */
const TWO_FACTOR_COPY = {
  sign_in: {
    subject: 'Your CaribWayz sign-in code',
    heading: 'Your CaribWayz sign-in code',
    lead: 'Enter this code in the CaribWayz app to finish signing in.',
    ignore: 'If you did not just try to sign in, someone may know your password. Change it in the app.',
  },
  enable: {
    subject: 'Confirm two-step sign-in for CaribWayz',
    heading: 'Turn on two-step sign-in',
    lead: 'Enter this code in the CaribWayz app to turn on two-step sign-in.',
    ignore: 'If you did not ask for this, ignore this email; nothing has changed.',
  },
};

/**
 * Emails a two-step sign-in code. As with the reset code, [code] is the only
 * copy: the API stores a hash and never returns it in a response.
 */
const sendTwoFactorCode = async ({ toEmail, code, expiresInMinutes, purpose }) => {
  if (typeof toEmail !== 'string' || /[\r\n,;]/.test(toEmail) || !toEmail.includes('@')) {
    throw new Error('sendTwoFactorCode: a single valid recipient address is required');
  }
  if (typeof code !== 'string' || !/^[0-9]{6}$/.test(code)) {
    throw new Error('sendTwoFactorCode: code must be six digits');
  }
  if (!Number.isInteger(expiresInMinutes) || expiresInMinutes <= 0) {
    throw new Error('sendTwoFactorCode: expiresInMinutes must be a positive whole number');
  }
  const copy = TWO_FACTOR_COPY[purpose];
  if (!copy) {
    throw new Error('sendTwoFactorCode: purpose must be sign_in or enable');
  }
  const minutes = expiresInMinutes;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;border-radius:12px;background:#f9f9f9;">
      <h2 style="color:#10c329;">${copy.heading}</h2>
      <p>${copy.lead}</p>
      <div style="text-align:center;margin:24px 0;">
        <span style="font-size:28px;font-weight:bold;letter-spacing:6px;color:#1a1a1a;background:#e8f5e9;padding:12px 24px;border-radius:8px;">${escapeHtml(code)}</span>
      </div>
      <p style="font-size:14px;color:#555;">The code expires in ${minutes} minutes and works once. ${copy.ignore}</p>
      <p style="font-size:12px;color:#999;text-align:center;margin-top:24px;">CaribWayz — Navigate Together</p>
    </div>
  `;

  await transporter.sendMail({
    from: `"CaribWayz" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: copy.subject,
    html,
    text: `${copy.lead}\n\nYour code is ${code}.\n\nIt expires in ${minutes} minutes and works once. ${copy.ignore}`,
    headers: {
      'X-Mailer': 'CaribWayz Mailer',
    },
  });
};

/**
 * Tells the CaribWayz team a business applied on the /membership page, so
 * they can send the invoice. Everything in [application] was typed by the
 * public, so it is escaped in the HTML and kept off the subject's header line
 * breaks. [tier] is the tier the server chose (publicTier shape), or null
 * when none fitted.
 */
const sendMembershipApplicationNotice = async ({ toEmail, application, tier }) => {
  if (typeof toEmail !== 'string' || /[\r\n,;]/.test(toEmail) || !toEmail.includes('@')) {
    throw new Error('sendMembershipApplicationNotice: a single valid recipient address is required');
  }
  if (!application || typeof application.business_name !== 'string') {
    throw new Error('sendMembershipApplicationNotice: the application is required');
  }

  const fee = !tier
    ? 'No tier fits this employee count; set the fee by hand.'
    : tier.annual_fee === null
      ? `${tier.name}: fee to be confirmed`
      : `${tier.name}: ${tier.currency} ${tier.annual_fee.toFixed(2)} a year${tier.is_provisional ? ' (provisional)' : ''}`;

  const rows = [
    ['Registered name', application.business_name],
    ['Trading name', application.trading_name],
    ['Category', application.category],
    ['Description', application.description],
    ['Address', application.address],
    ['Business phone', application.phone],
    ['Business email', application.business_email],
    ['Website or social', application.website],
    ['Contact', application.contact_name],
    ['Position', application.contact_position],
    ['Contact phone', application.contact_phone],
    ['Contact email', application.email],
    ['Employees', application.employee_count],
    ['Tier', fee],
    ['Message', application.message],
    ['Application id', application.id],
  ].filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:24px;border-radius:12px;background:#f9f9f9;">
      <h2 style="color:#10c329;">New member business application</h2>
      <table style="font-size:14px;border-collapse:collapse;">
        ${rows.map(([label, value]) => `<tr><td style="padding:4px 12px 4px 0;color:#555;vertical-align:top;">${label}</td><td style="padding:4px 0;">${escapeHtml(String(value))}</td></tr>`).join('')}
      </table>
      <p style="font-size:14px;color:#555;">Open Membership Applications in the CaribWayz admin panel to invoice and activate it.</p>
      <p style="font-size:12px;color:#999;text-align:center;margin-top:24px;">CaribWayz — Navigate Together</p>
    </div>
  `;

  await transporter.sendMail({
    from: `"CaribWayz" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: `Membership application: ${application.business_name}`.replace(/[\r\n]+/g, ' '),
    html,
    text: `New member business application\n\n${rows.map(([label, value]) => `${label}: ${value}`).join('\n')}\n\nOpen Membership Applications in the CaribWayz admin panel to invoice and activate it.`,
    headers: {
      'X-Mailer': 'CaribWayz Mailer',
    },
  });
};

module.exports = {
  sendGroupInvite, isEmailConfigured, sendPasswordResetCode, sendTwoFactorCode, sendMembershipApplicationNotice,
};
