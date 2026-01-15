import fs from 'fs';
import path from 'path';

type BrandedEmailContent = {
  subject: string;
  title: string;
  body: string;
  ctaLabel?: string;
  ctaUrl?: string;
  preheader?: string;
  brandName?: string;
  logoUrl?: string;
  supportLine?: string;
  securityLine?: string;
  footerLine?: string;
};

const LOGO_PATH = path.join(__dirname, 'assets', 'logo-email.png');
const FALLBACK_LOGO_PATHS = [
  path.join(process.cwd(), 'src', 'mailer', 'assets', 'logo-email.png'),
  path.join(process.cwd(), 'backend', 'src', 'mailer', 'assets', 'logo-email.png'),
  path.join(process.cwd(), 'src', 'mailer', 'assets', 'logo.png'),
  path.join(process.cwd(), 'backend', 'src', 'mailer', 'assets', 'logo.png'),
];
let cachedLogo: string | null = null;

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const renderBody = (body: string) =>
  body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p style="margin:0 0 12px;line-height:1.6;">${escapeHtml(line)}</p>`)
    .join('');

const getLogoDataUri = () => {
  if (cachedLogo !== null) {
    return cachedLogo;
  }
  const paths = [LOGO_PATH, ...FALLBACK_LOGO_PATHS];
  for (const logoPath of paths) {
    try {
      const buffer = fs.readFileSync(logoPath);
      const base64 = buffer.toString('base64');
      cachedLogo = `data:image/png;base64,${base64}`;
      return cachedLogo;
    } catch {
      // try next path
    }
  }
  cachedLogo = '';
  return cachedLogo;
};

const resolveLogoUrl = (content: BrandedEmailContent) => {
  if (content.logoUrl) {
    return content.logoUrl;
  }
  if (process.env.EMAIL_LOGO_URL) {
    return process.env.EMAIL_LOGO_URL;
  }
  const baseUrl = process.env.APP_BASE_URL || process.env.FRONTEND_BASE_URL;
  if (!baseUrl) {
    return '';
  }
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}/logo-email.png`;
};

export const buildBrandedEmail = (content: BrandedEmailContent) => {
  const logoUrl = resolveLogoUrl(content);
  const logo = logoUrl || getLogoDataUri();
  const brandName = content.brandName ?? 'New Vision Inventory';
  const bodyHtml = renderBody(content.body);
  const supportLine = content.supportLine
    ? `<p style="margin:0 0 10px;line-height:1.5;color:#c7b37a;">${escapeHtml(
        content.supportLine,
      )}</p>`
    : '';
  const securityLine = content.securityLine
    ? `<p style="margin:0;line-height:1.5;color:#a4905c;">${escapeHtml(
        content.securityLine,
      )}</p>`
    : '';
  const footerLine = content.footerLine
    ? `<p style="margin:18px 0 0;color:#7a6b44;font-size:12px;">${escapeHtml(
        content.footerLine,
      )}</p>`
    : '';
  const cta =
    content.ctaLabel && content.ctaUrl
      ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:20px 0 24px;">
          <tr>
            <td align="center" bgcolor="#D4AF37" style="border-radius:6px;">
              <a href="${escapeHtml(content.ctaUrl)}" style="display:inline-block;padding:12px 18px;color:#0B0B0B;font-weight:700;font-size:14px;text-decoration:none;">
                ${escapeHtml(content.ctaLabel)}
              </a>
            </td>
          </tr>
        </table>`
      : '';

  const preheader = content.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(
        content.preheader,
      )}</div>`
    : '';

  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(content.subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#0B0B0B;color:#E6D9B0;font-family:Arial,sans-serif;">
    ${preheader}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0B0B0B;padding:28px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="640" cellspacing="0" cellpadding="0" style="width:640px;max-width:92%;background:#121212;border:1px solid #2B220F;border-radius:12px;overflow:hidden;">
            <tr>
              <td align="center" style="padding:28px 24px 16px;background:radial-gradient(circle at top,#1E1B10 0%,#121212 70%);">
                ${
                  logo
                    ? `<img src="${logo}" alt="${escapeHtml(
                        brandName,
                      )}" width="120" height="120" style="display:block;border-radius:12px;" />`
                    : `<div style="font-size:20px;font-weight:700;color:#D4AF37;">${escapeHtml(
                        brandName,
                      )}</div>`
                }
                <p style="margin:12px 0 0;color:#D4AF37;letter-spacing:0.2em;text-transform:uppercase;font-size:11px;">
                  ${escapeHtml(brandName)}
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 32px;">
                <h1 style="margin:0 0 16px;font-size:24px;color:#F0E0B0;">${escapeHtml(
                  content.title,
                )}</h1>
                ${bodyHtml}
                ${cta}
                ${supportLine}
                ${securityLine}
                ${footerLine}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const textParts = [
    content.title,
    '',
    content.body,
    content.ctaLabel && content.ctaUrl
      ? `${content.ctaLabel}: ${content.ctaUrl}`
      : '',
    content.supportLine ?? '',
    content.securityLine ?? '',
    content.footerLine ?? '',
  ]
    .filter((value) => value !== '')
    .join('\n');

  return {
    subject: content.subject,
    text: textParts,
    html,
  };
};
