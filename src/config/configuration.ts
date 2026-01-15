export default () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  jwt: {
    secret: process.env.JWT_SECRET || 'change-me',
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    refreshDays: process.env.JWT_REFRESH_DAYS || '30',
  },
  smtp: {
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT
      ? parseInt(process.env.SMTP_PORT, 10)
      : undefined,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM,
    secure: process.env.SMTP_SECURE === 'true',
  },
  ses: {
    region: process.env.SES_REGION || process.env.AWS_REGION,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    from: process.env.SMTP_FROM,
  },
  infobip: {
    baseUrl: process.env.INFOBIP_BASE_URL,
    apiKey: process.env.INFOBIP_API_KEY,
    smsFrom: process.env.INFOBIP_SMS_FROM,
    whatsappFrom: process.env.INFOBIP_WHATSAPP_FROM,
  },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    whatsappFrom: process.env.TWILIO_WHATSAPP_FROM,
  },
  platform: {
    adminEmail: process.env.PLATFORM_ADMIN_EMAIL,
    adminPassword: process.env.PLATFORM_ADMIN_PASSWORD,
  },
  appBaseUrl:
    process.env.APP_BASE_URL ||
    process.env.FRONTEND_BASE_URL ||
    'http://localhost:3000',
  subscription: {
    trialDays: process.env.TRIAL_DAYS || '14',
    enterpriseTrialDays: process.env.TRIAL_DAYS_ENTERPRISE || '7',
    graceReminderWindowDays: process.env.GRACE_REMINDER_WINDOW_DAYS || '7',
    graceReminderIntervalHours:
      process.env.GRACE_REMINDER_INTERVAL_HOURS || '24',
  },
  throttling: {
    ttlSeconds: process.env.THROTTLE_TTL_SECONDS || '60',
    limit: process.env.THROTTLE_LIMIT || '120',
  },
  storage: {
    region: process.env.AWS_REGION,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    bucket: process.env.S3_BUCKET,
    prefix: process.env.S3_PREFIX || '',
    presignTtlSeconds: process.env.S3_PRESIGN_TTL_SECONDS || '300',
    publicBaseUrl: process.env.S3_PUBLIC_BASE_URL,
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  },
  exports: {
    workerEnabled: process.env.EXPORT_WORKER_ENABLED !== 'false',
    workerIntervalMs: process.env.EXPORT_WORKER_INTERVAL_MS || '15000',
    workerMaxAttempts: process.env.EXPORT_WORKER_MAX_ATTEMPTS || '3',
  },
});
