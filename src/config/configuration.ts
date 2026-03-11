export default () => {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error(
      'JWT_SECRET environment variable must be set. Refusing to start with an insecure default.',
    );
  }
  return {
  port: parseInt(process.env.PORT || '3000', 10),
  jwt: {
    secret: jwtSecret,
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
  mail: {
    provider: process.env.MAIL_PROVIDER || 'ses',
    from: process.env.POSTMARK_FROM || process.env.SMTP_FROM,
  },
  postmark: {
    serverToken: process.env.POSTMARK_SERVER_TOKEN,
    from: process.env.POSTMARK_FROM || process.env.SMTP_FROM,
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
  supportChat: {
    enabled: process.env.SUPPORT_CHAT_ENABLED === 'true',
    manualIndexPath:
      process.env.SUPPORT_CHAT_MANUAL_INDEX_PATH ||
      'frontend/docs/manual/manual.freeze.m09.index.jsonl',
    manualSourceDir:
      process.env.SUPPORT_CHAT_MANUAL_SOURCE_DIR || 'frontend/docs/manual',
    vectorEnabled: process.env.SUPPORT_CHAT_VECTOR_ENABLED === 'true',
    vectorTopK: process.env.SUPPORT_CHAT_VECTOR_TOP_K
      ? parseInt(process.env.SUPPORT_CHAT_VECTOR_TOP_K, 10)
      : 20,
    vectorMinScore: process.env.SUPPORT_CHAT_VECTOR_MIN_SCORE
      ? parseFloat(process.env.SUPPORT_CHAT_VECTOR_MIN_SCORE)
      : 0.05,
    embeddingModel:
      process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
    escalationContact:
      process.env.SUPPORT_CHAT_ESCALATION_CONTACT ||
      process.env.SUPPORT_EMAIL ||
      'support@newvisioninventory.com',
    llmModel: process.env.SUPPORT_CHAT_LLM_MODEL || process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini',
  },
  };
};
