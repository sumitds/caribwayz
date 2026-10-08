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

const sendGroupInvite = async ({ toEmails, groupName, joinCode, inviterName }) => {
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

  await transporter.sendMail({
    from: `"CaribWayz" <${process.env.SMTP_USER}>`,
    to: toEmails.join(', '),
    subject: subjectLine,
    html,
    text: `${inviterName} invited you to join "${groupName}" on CaribWayz.\n\nYour join code: ${joinCode}\n\nOpen CaribWayz and enter this code to join the group.`,
    headers: {
      'X-Priority': '3',
      'X-Mailer': 'CaribWayz Mailer',
      'List-Unsubscribe': `<mailto:${process.env.SMTP_USER}?subject=unsubscribe>`,
    },
  });
};

module.exports = { sendGroupInvite };
