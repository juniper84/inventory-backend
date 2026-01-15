export const NOTIFICATION_EVENT_KEYS = [
  'lowStock',
  'pendingApprovals',
  'offlineNearingLimit',
  'creditOverdue',
  'graceWarnings',
  'expiry',
  'noteReminder',
  'saleDrafted',
  'saleCompleted',
  'saleVoided',
  'saleRefunded',
  'transferCreated',
  'transferInTransit',
  'transferReceived',
  'transferCancelled',
  'stockAdjusted',
  'stockCountRecorded',
  'purchaseCreated',
  'purchaseOrderCreated',
  'purchaseOrderApproved',
  'receivingRecorded',
  'supplierReturnRecorded',
  'expenseRecorded',
  'approvalApproved',
  'approvalRejected',
  'accessRequest',
  'subscriptionRequestApproved',
  'subscriptionRequestRejected',
  'securityRefreshTokenReuse',
  'securityUnusualLogin',
] as const;

export type NotificationEventKey = (typeof NOTIFICATION_EVENT_KEYS)[number];
export type NotificationChannel = 'email' | 'sms' | 'whatsapp';

export type NotificationGroupKey =
  | 'security'
  | 'approvals'
  | 'inventory'
  | 'sales'
  | 'purchases'
  | 'transfers'
  | 'system';

export const NOTIFICATION_GROUPS: Record<
  NotificationGroupKey,
  NotificationEventKey[]
> = {
  security: ['securityRefreshTokenReuse', 'securityUnusualLogin', 'accessRequest'],
  approvals: [
    'pendingApprovals',
    'approvalApproved',
    'approvalRejected',
    'subscriptionRequestApproved',
    'subscriptionRequestRejected',
  ],
  inventory: [
    'lowStock',
    'expiry',
    'stockAdjusted',
    'stockCountRecorded',
    'receivingRecorded',
    'supplierReturnRecorded',
  ],
  sales: ['saleDrafted', 'saleCompleted', 'saleVoided', 'saleRefunded', 'creditOverdue'],
  purchases: ['purchaseCreated', 'purchaseOrderCreated', 'purchaseOrderApproved', 'expenseRecorded'],
  transfers: [
    'transferCreated',
    'transferInTransit',
    'transferReceived',
    'transferCancelled',
  ],
  system: ['offlineNearingLimit', 'graceWarnings', 'noteReminder'],
};

export const resolveNotificationGroup = (
  eventKey: NotificationEventKey,
): NotificationGroupKey => {
  for (const [group, events] of Object.entries(NOTIFICATION_GROUPS)) {
    if (events.includes(eventKey)) {
      return group as NotificationGroupKey;
    }
  }
  return 'system';
};

export type NotificationRecipientConfig = {
  roleIds: string[];
  userIds: string[];
  includeOwners: boolean;
  includeManagers: boolean;
  branchScoped: boolean;
};

export type NotificationEventSettings = {
  enabled: boolean;
};

export type NotificationRecipientGroups = {
  global: NotificationRecipientConfig;
  email?: NotificationRecipientConfig | null;
  whatsapp?: NotificationRecipientConfig | null;
  sms?: NotificationRecipientConfig | null;
};

export type NotificationGroupSettings = {
  channels: Record<NotificationChannel, boolean>;
};

export type NotificationSettings = {
  channels: Record<NotificationChannel, boolean>;
  recipients: NotificationRecipientGroups;
  groups: Record<NotificationGroupKey, NotificationGroupSettings>;
  events: Record<NotificationEventKey, NotificationEventSettings>;
};

type LegacyNotificationDefaults = Record<string, unknown>;

const DEFAULT_RECIPIENTS: NotificationRecipientConfig = {
  roleIds: [],
  userIds: [],
  includeOwners: true,
  includeManagers: false,
  branchScoped: true,
};

const DEFAULT_EVENT_SETTINGS: NotificationEventSettings = {
  enabled: true,
};

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  channels: {
    email: true,
    sms: false,
    whatsapp: false,
  },
  recipients: {
    global: DEFAULT_RECIPIENTS,
    email: null,
    whatsapp: null,
    sms: null,
  },
  groups: (Object.keys(NOTIFICATION_GROUPS) as NotificationGroupKey[]).reduce(
    (acc, key) => {
      acc[key] = {
        channels: {
          email: true,
          sms: false,
          whatsapp: false,
        },
      };
      return acc;
    },
    {} as Record<NotificationGroupKey, NotificationGroupSettings>,
  ),
  events: NOTIFICATION_EVENT_KEYS.reduce<
    Record<NotificationEventKey, NotificationEventSettings>
  >(
    (acc, key) => {
      acc[key] = {
        enabled: DEFAULT_EVENT_SETTINGS.enabled,
      };
      return acc;
    },
    {} as Record<NotificationEventKey, NotificationEventSettings>,
  ),
};

const LEGACY_EVENT_KEY_MAP: Record<string, NotificationEventKey> = {
  eventLowStock: 'lowStock',
  eventPendingApprovals: 'pendingApprovals',
  eventOfflineNearingLimit: 'offlineNearingLimit',
  eventCreditOverdue: 'creditOverdue',
  eventGraceWarnings: 'graceWarnings',
  eventExpiry: 'expiry',
  eventNoteReminder: 'noteReminder',
};

const toBoolean = (value: unknown, fallback: boolean) =>
  typeof value === 'boolean' ? value : fallback;

const normalizeRecipients = (
  raw: Record<string, unknown> | null | undefined,
  fallback: NotificationRecipientConfig,
): NotificationRecipientConfig => {
  const source = raw ?? {};
  return {
    roleIds: Array.isArray(source.roleIds)
      ? source.roleIds.filter((id) => typeof id === 'string')
      : [...fallback.roleIds],
    userIds: Array.isArray(source.userIds)
      ? source.userIds.filter((id) => typeof id === 'string')
      : [...fallback.userIds],
    includeOwners: toBoolean(source.includeOwners, fallback.includeOwners),
    includeManagers: toBoolean(
      source.includeManagers,
      fallback.includeManagers,
    ),
    branchScoped: toBoolean(source.branchScoped, fallback.branchScoped),
  };
};

const normalizeEventSettings = (
  raw: Record<string, unknown> | null | undefined,
  defaults: NotificationEventSettings,
): NotificationEventSettings => {
  const source = raw ?? {};
  return {
    enabled: toBoolean(source.enabled, defaults.enabled),
  };
};

const mergeRecipients = (
  base: NotificationRecipientConfig,
  next: NotificationRecipientConfig,
): NotificationRecipientConfig => ({
  roleIds: Array.from(new Set([...base.roleIds, ...next.roleIds])),
  userIds: Array.from(new Set([...base.userIds, ...next.userIds])),
  includeOwners: base.includeOwners || next.includeOwners,
  includeManagers: base.includeManagers || next.includeManagers,
  branchScoped: base.branchScoped || next.branchScoped,
});

export const normalizeNotificationSettings = (
  raw?: LegacyNotificationDefaults | null,
): NotificationSettings => {
  if (!raw || typeof raw !== 'object') {
    return DEFAULT_NOTIFICATION_SETTINGS;
  }

  const input = raw as Record<string, unknown>;
  const hasEvents = typeof input.events === 'object' && input.events !== null;
  const hasRecipients =
    typeof input.recipients === 'object' && input.recipients !== null;
  const hasGroups = typeof input.groups === 'object' && input.groups !== null;
  const channelsSource = (hasEvents ? input.channels : input) as
    | Record<string, unknown>
    | null
    | undefined;

  const channels = {
    email: toBoolean(
      channelsSource?.email,
      DEFAULT_NOTIFICATION_SETTINGS.channels.email,
    ),
    sms: toBoolean(
      channelsSource?.sms,
      DEFAULT_NOTIFICATION_SETTINGS.channels.sms,
    ),
    whatsapp: toBoolean(
      channelsSource?.whatsapp,
      DEFAULT_NOTIFICATION_SETTINGS.channels.whatsapp,
    ),
  };

  const eventsSource = hasEvents
    ? (input.events as Record<string, unknown>)
    : null;

  const events = NOTIFICATION_EVENT_KEYS.reduce<
    Record<NotificationEventKey, NotificationEventSettings>
  >(
    (acc, key) => {
      let eventInput: Record<string, unknown> | null = null;
      if (eventsSource && typeof eventsSource[key] === 'object') {
        eventInput = eventsSource[key] as Record<string, unknown>;
      }
      const defaults = DEFAULT_NOTIFICATION_SETTINGS.events[key];
      let normalized = normalizeEventSettings(eventInput, defaults);

      if (!eventsSource) {
        const legacyKey = Object.keys(LEGACY_EVENT_KEY_MAP).find(
          (legacy) => LEGACY_EVENT_KEY_MAP[legacy] === key,
        );
        if (legacyKey) {
          normalized = {
            ...normalized,
            enabled: toBoolean(input[legacyKey], defaults.enabled),
          };
        }
      }

      acc[key] = normalized;
      return acc;
    },
    {} as Record<NotificationEventKey, NotificationEventSettings>,
  );
  if (hasRecipients || hasGroups) {
    const recipientsSource = input.recipients as
      | Record<string, unknown>
      | null
      | undefined;
    const globalRecipients = normalizeRecipients(
      (recipientsSource?.global as Record<string, unknown>) ?? null,
      DEFAULT_RECIPIENTS,
    );
    const emailRecipients = recipientsSource?.email
      ? normalizeRecipients(
          recipientsSource.email as Record<string, unknown>,
          DEFAULT_RECIPIENTS,
        )
      : null;
    const whatsappRecipients = recipientsSource?.whatsapp
      ? normalizeRecipients(
          recipientsSource.whatsapp as Record<string, unknown>,
          DEFAULT_RECIPIENTS,
        )
      : null;
    const smsRecipients = recipientsSource?.sms
      ? normalizeRecipients(
          recipientsSource.sms as Record<string, unknown>,
          DEFAULT_RECIPIENTS,
        )
      : null;
    const groupsSource = hasGroups
      ? (input.groups as Record<string, unknown>)
      : {};
    const groups = (Object.keys(NOTIFICATION_GROUPS) as NotificationGroupKey[]).reduce(
      (acc, key) => {
        const groupInput =
          groupsSource && typeof groupsSource[key] === 'object'
            ? (groupsSource[key] as Record<string, unknown>)
            : null;
        const groupChannels = groupInput?.channels as
          | Record<string, unknown>
          | null
          | undefined;
        acc[key] = {
          channels: {
            email: toBoolean(groupChannels?.email, channels.email),
            sms: toBoolean(groupChannels?.sms, channels.sms),
            whatsapp: toBoolean(groupChannels?.whatsapp, channels.whatsapp),
          },
        };
        return acc;
      },
      {} as Record<NotificationGroupKey, NotificationGroupSettings>,
    );
    return {
      channels,
      recipients: {
        global: globalRecipients,
        email: emailRecipients,
        whatsapp: whatsappRecipients,
        sms: smsRecipients,
      },
      groups,
      events,
    };
  }

  let mergedRecipients = DEFAULT_RECIPIENTS;
  const legacyEventsSource = eventsSource ?? {};
  for (const key of Object.keys(legacyEventsSource)) {
    if (typeof legacyEventsSource[key] !== 'object') {
      continue;
    }
    const recipients = normalizeRecipients(
      (legacyEventsSource[key] as Record<string, unknown>)
        ?.recipients as Record<string, unknown>,
      DEFAULT_RECIPIENTS,
    );
    mergedRecipients = mergeRecipients(mergedRecipients, recipients);
  }

  const groups = (Object.keys(NOTIFICATION_GROUPS) as NotificationGroupKey[]).reduce(
    (acc, groupKey) => {
      const groupEvents = NOTIFICATION_GROUPS[groupKey];
      const channelAggregate = {
        email: false,
        sms: false,
        whatsapp: false,
      };
      for (const eventKey of groupEvents) {
        const eventInput =
          eventsSource && typeof eventsSource[eventKey] === 'object'
            ? (eventsSource[eventKey] as Record<string, unknown>)
            : null;
        const channelsInput = eventInput?.channels as
          | Record<string, unknown>
          | null
          | undefined;
        channelAggregate.email ||= toBoolean(channelsInput?.email, channels.email);
        channelAggregate.sms ||= toBoolean(channelsInput?.sms, channels.sms);
        channelAggregate.whatsapp ||= toBoolean(
          channelsInput?.whatsapp,
          channels.whatsapp,
        );
      }
      acc[groupKey] = { channels: channelAggregate };
      return acc;
    },
    {} as Record<NotificationGroupKey, NotificationGroupSettings>,
  );

  return {
    channels,
    recipients: {
      global: mergedRecipients,
      email: null,
      whatsapp: null,
      sms: null,
    },
    groups,
    events,
  };
};
