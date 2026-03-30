import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { PermissionsList } from '../rbac/permissions';

type ManualLocale = 'en' | 'sw';
type ChatIntent = 'explain_page' | 'troubleshoot_error' | 'how_to' | 'what_next';

type ContextPayload = {
  route: string;
  locale: ManualLocale;
  module: string;
  user: {
    permission_codes: string[];
  };
  scope: {
    branch_scope: string[];
    active_branch_id: string | null;
  };
  readiness_signals: Record<string, unknown>;
  latest_error: {
    error_code: string | null;
    error_message: string | null;
    error_route: string | null;
  };
};

type RetrievalResult = {
  id: string;
  route: string;
  section: 'purpose' | 'prerequisites' | 'workflow' | 'errors' | 'links' | 'warnings' | 'elements';
  error_codes: string[];
  text: string;
};

type RetrievalPayload = {
  deterministic_playbook?: {
    error_code: string;
    title: string;
  } | null;
  results: RetrievalResult[];
};

type ManualEntry = {
  id: string;
  route: string;
  locale: ManualLocale;
  title: string;
  // v1 fields — optional, may be absent in v2 entries
  purpose?: string;
  workflow?: { step: string; expected_result?: string; if_blocked?: string }[];
  prerequisites?: { check: string; where_to_do_it?: string }[];
  common_errors?: { error_code: string; likely_cause: string; fix_steps: string[] }[];
  related_pages?: { route: string; reason: string; order: string }[];
  permissions_required?: string[];
  // v2 fields
  overview?: string;
  before_you_start?: { text: string; link?: string }[];
  common_tasks?: { task: string; steps: string[] }[];
  warnings?: string[];
  elements?: { name: string; type: string; description: string; notes?: string }[];
};

type ManualDataset = {
  entries: ManualEntry[];
};

type ReasoningMode = 'playbook' | 'dependency' | 'fallback';
type ReasoningCheckStatus = 'passed' | 'failed' | 'not_applicable';

type ReasoningCheck = {
  id:
    | 'playbook_match'
    | 'scope_alignment'
    | 'sequence_order'
    | 'permission_gate'
    | 'prerequisite_state'
    | 'error_family_match';
  status: ReasoningCheckStatus;
  detail: string;
};

type ReasoningBlocker = {
  type:
    | 'playbook_match'
    | 'scope_mismatch'
    | 'sequence_violation'
    | 'permission_likely_missing'
    | 'prerequisite_missing'
    | 'error_family_match'
    | 'insufficient_evidence';
  message: string;
  actions: string[];
};

type ScoredReasoningBlocker = ReasoningBlocker & {
  score: number;
};

export type DependencyChainLink = {
  page_route: string;
  blocker_message: string;
  actions: string[];
};

export type SupportChatReasoning = {
  mode: ReasoningMode;
  checks: ReasoningCheck[];
  primary_blocker: ReasoningBlocker | null;
  secondary_blockers: ReasoningBlocker[];
  dependency_chain: DependencyChainLink[] | null;
};

@Injectable()
export class SupportChatReasonerService {
  constructor(private readonly config: ConfigService) {}
  private readonly knownPermissionCodes = new Set<string>(
    Object.values(PermissionsList),
  );

  private manualCache = new Map<
    ManualLocale,
    {
      byRoute: Map<string, ManualEntry>;
      byId: Map<string, ManualEntry>;
    }
  >();

  // Data-driven lookup: route pattern suffix → readiness check + messages.
  // Any before-dependency declared in a manual entry's related_pages that
  // matches one of these patterns is automatically evaluated — no hardcoding
  // required per-page. Add a new entry here to cover any future dependency.
  private readonly SEQUENCE_READINESS_MAP: Record<
    string,
    {
      isBlocked: (readiness: Record<string, unknown>) => boolean;
      detailEn: string;
      detailSw: string;
      messageEn: string;
      messageSw: string;
      actionsEn: string[];
      actionsSw: string[];
    }
  > = {
    '/catalog/categories': {
      isBlocked: (r) => this.asNumber(r.categories_count) === 0,
      detailEn: 'Sequence violation: category setup prerequisite is incomplete.',
      detailSw: 'Sequence imevunjika: hatua ya categories haijakamilika.',
      messageEn: 'This task requires Categories setup to be completed first.',
      messageSw: 'Hii hatua inahitaji ukamilishe setup ya Categories kwanza.',
      actionsEn: [
        'Open Catalog - Categories and create at least one active category.',
        'Return to this page and retry the action.',
      ],
      actionsSw: [
        'Fungua Catalog - Categories na unda angalau category moja ACTIVE.',
        'Rudi kwenye ukurasa huu na ujaribu tena.',
      ],
    },
    '/catalog/products': {
      isBlocked: (r) => this.asNumber(r.products_count) === 0,
      detailEn: 'Sequence violation: product setup prerequisite is incomplete.',
      detailSw: 'Sequence imevunjika: setup ya bidhaa haijakamilika.',
      messageEn: 'This task requires Products setup before proceeding.',
      messageSw: 'Hii hatua inahitaji setup ya Bidhaa kabla ya kuendelea.',
      actionsEn: [
        'Create at least one product on Catalog - Products.',
        'Return and continue this workflow after product setup.',
      ],
      actionsSw: [
        'Unda angalau bidhaa moja kwenye Catalog - Products.',
        'Rudi hapa baada ya kukamilisha setup ya bidhaa.',
      ],
    },
    '/catalog/variants': {
      isBlocked: (r) => this.asNumber(r.variants_count) === 0,
      detailEn: 'Sequence violation: variant setup prerequisite is incomplete.',
      detailSw: 'Sequence imevunjika: setup ya vibadala haijakamilika.',
      messageEn: 'This task requires at least one active variant first.',
      messageSw: 'Hii hatua inahitaji angalau kibadala kimoja cha ACTIVE kwanza.',
      actionsEn: [
        'Set up variants on Catalog - Variants.',
        'Return to this page after variants are active.',
      ],
      actionsSw: [
        'Sanidi vibadala kwenye Catalog - Variants.',
        'Rudi hapa baada ya vibadala kuwa ACTIVE.',
      ],
    },
    '/suppliers': {
      isBlocked: (r) => this.asBoolean(r.has_suppliers) === false,
      detailEn: 'Sequence violation: supplier setup prerequisite is incomplete.',
      detailSw: 'Sequence imevunjika: setup ya supplier haijakamilika.',
      messageEn: 'This workflow requires supplier setup first.',
      messageSw: 'Mtiririko huu unahitaji setup ya supplier kwanza.',
      actionsEn: [
        'Create a supplier on the Suppliers page.',
        'Retry this procurement step afterward.',
      ],
      actionsSw: [
        'Unda supplier kwenye Suppliers page.',
        'Rudia hatua hii ya procurement baada ya hapo.',
      ],
    },
    '/shifts': {
      isBlocked: (r) => this.asBoolean(r.has_open_shift_in_active_branch) === false,
      detailEn: 'Sequence violation: shift setup prerequisite is incomplete.',
      detailSw: 'Sequence imevunjika: setup ya shift haijakamilika.',
      messageEn: 'POS flow requires an open shift before this action.',
      messageSw: 'Mtiririko wa POS unahitaji shift OPEN kabla ya hatua hii.',
      actionsEn: ['Open a shift on the Shifts page.', 'Retry the POS action.'],
      actionsSw: ['Fungua shift kwenye Shifts page.', 'Rudia hatua ya POS.'],
    },
    '/branches': {
      isBlocked: (r) => this.asBoolean(r.has_active_branch) === false,
      detailEn: 'Sequence violation: no active branch is selected.',
      detailSw: 'Sequence imevunjika: hakuna tawi lililochaguliwa.',
      messageEn: 'An active branch must be selected before this action.',
      messageSw: 'Lazima uchague tawi kabla ya hatua hii.',
      actionsEn: [
        'Go to Settings - Branches and ensure at least one branch is active.',
        'Select the branch using the branch switcher.',
      ],
      actionsSw: [
        'Nenda Settings - Branches na uhakikishe tawi angalau moja liko ACTIVE.',
        'Chagua tawi ukitumia branch switcher.',
      ],
    },
    '/price-lists': {
      isBlocked: (r) => this.asBoolean(r.has_price_lists) === false,
      detailEn: 'Sequence violation: no price list is configured.',
      detailSw: 'Sequence imevunjika: hakuna orodha ya bei iliyosanidiwa.',
      messageEn: 'This workflow requires at least one price list to be configured first.',
      messageSw: 'Mtiririko huu unahitaji angalau orodha moja ya bei kusanidiwa kwanza.',
      actionsEn: [
        'Create a price list on the Price Lists page.',
        'Assign the price list to this workflow and retry.',
      ],
      actionsSw: [
        'Unda orodha ya bei kwenye Price Lists page.',
        'Weka orodha ya bei kwa mtiririko huu kisha ujaribu tena.',
      ],
    },
  };

  analyze(input: {
    locale: ManualLocale;
    intent: ChatIntent;
    question: string;
    context: ContextPayload;
    retrieval: RetrievalPayload;
  }): SupportChatReasoning {
    const locale = input.locale;
    const route = this.normalizeRoute(input.context.route);
    const currentEntry = this.getEntryByRoute(locale, route);
    const checks: ReasoningCheck[] = [];
    const blockers: ScoredReasoningBlocker[] = [];

    if (input.intent === 'explain_page') {
      checks.push({
        id: 'playbook_match',
        status: 'not_applicable',
        detail:
          locale === 'sw'
            ? 'Intent ni maelezo ya ukurasa; playbook ya kosa haitumiki.'
            : 'Intent is page explanation; error playbook matching is not applied.',
      });
      checks.push({
        id: 'scope_alignment',
        status: 'not_applicable',
        detail:
          locale === 'sw'
            ? 'Hakuna kosa la kutatua; ukaguzi wa scope umerukwa.'
            : 'No troubleshooting error context; scope alignment check skipped.',
      });
      checks.push({
        id: 'sequence_order',
        status: 'not_applicable',
        detail:
          locale === 'sw'
            ? 'Intent ni maelezo ya ukurasa; sequence blocker haitumiki.'
            : 'Page explanation intent does not trigger sequence blockers.',
      });
      checks.push({
        id: 'permission_gate',
        status: 'not_applicable',
        detail:
          locale === 'sw'
            ? 'Intent ni maelezo ya ukurasa; permission blocker haitumiki.'
            : 'Page explanation intent does not trigger permission blockers.',
      });
      checks.push({
        id: 'prerequisite_state',
        status: 'not_applicable',
        detail:
          locale === 'sw'
            ? 'Intent ni maelezo ya ukurasa; prerequisite blocker haitumiki.'
            : 'Page explanation intent does not trigger prerequisite blockers.',
      });
      checks.push({
        id: 'error_family_match',
        status: 'not_applicable',
        detail:
          locale === 'sw'
            ? 'Hakuna kosa la kutatua kwa intent hii.'
            : 'No troubleshooting error-family matching for this intent.',
      });
      return {
        mode: currentEntry ? 'dependency' : 'fallback',
        checks,
        primary_blocker: null,
        secondary_blockers: [],
        dependency_chain: null,
      };
    }

    const scopeCheck = this.evaluateScopeAlignment({
      locale,
      contextRoute: route,
      errorRoute: input.context.latest_error.error_route,
      scope: input.context.scope,
    });
    checks.push(scopeCheck.check);
    if (scopeCheck.blocker) {
      blockers.push(this.withScore(scopeCheck.blocker));
    }

    if (!currentEntry) {
      checks.push({
        id: 'sequence_order',
        status: 'not_applicable',
        detail:
          locale === 'sw'
            ? 'Hakuna taarifa ya route kwenye corpus ya manual.'
            : 'Route is not mapped in the frozen manual corpus.',
      });
      checks.push({
        id: 'permission_gate',
        status: 'not_applicable',
        detail:
          locale === 'sw'
            ? 'Ruhusa za route hii hazijapatikana kwenye corpus.'
            : 'Permission map unavailable for this route.',
      });
      checks.push({
        id: 'prerequisite_state',
        status: 'not_applicable',
        detail:
          locale === 'sw'
            ? 'Masharti ya route hii hayajulikani.'
            : 'Prerequisite state cannot be resolved for this route.',
      });
      checks.push({
        id: 'error_family_match',
        status: 'not_applicable',
        detail:
          locale === 'sw'
            ? 'Hakuna familia ya error iliyopatikana kwa route hii.'
            : 'No route-specific error family is available.',
      });
      return {
        mode: blockers.length ? 'dependency' : 'fallback',
        checks,
        primary_blocker: blockers[0] ? this.stripScore(blockers[0]) : null,
        secondary_blockers: blockers.slice(1).map((item) => this.stripScore(item)),
        dependency_chain: null,
      };
    }

    const sequenceCheck = this.evaluateSequence({
      locale,
      entry: currentEntry,
      readiness: input.context.readiness_signals,
    });
    checks.push(sequenceCheck.check);
    if (sequenceCheck.blocker) {
      blockers.push(this.withScore(sequenceCheck.blocker));
    }
    const dependencyChain =
      sequenceCheck.blockingRoute
        ? this.traverseDependencyChain(
            locale,
            sequenceCheck.blockingRoute,
            input.context.readiness_signals,
            1,
          )
        : null;

    const permissionCheck = this.evaluatePermissions({
      locale,
      entry: currentEntry,
      grantedPermissions: input.context.user.permission_codes ?? [],
    });
    checks.push(permissionCheck.check);
    if (permissionCheck.blocker) {
      blockers.push(this.withScore(permissionCheck.blocker));
    }

    const prerequisiteCheck = this.evaluatePrerequisites({
      locale,
      entry: currentEntry,
      readiness: input.context.readiness_signals,
    });
    checks.push(prerequisiteCheck.check);
    if (prerequisiteCheck.blocker) {
      blockers.push(this.withScore(prerequisiteCheck.blocker));
    }

    const errorFamilyCheck = this.evaluateErrorFamily({
      locale,
      entry: currentEntry,
      errorCode: input.context.latest_error.error_code,
      errorMessage: input.context.latest_error.error_message,
      intent: input.intent,
      retrievalResults: input.retrieval.results,
    });
    checks.push(errorFamilyCheck.check);
    if (errorFamilyCheck.blocker) {
      blockers.push(this.withScore(errorFamilyCheck.blocker));
    }

    const deduped = this.rankAndDedupeBlockers(blockers);
    const playbook = input.retrieval.deterministic_playbook ?? null;
    const preferPlaybook =
      Boolean(playbook) &&
      (!deduped.length || deduped[0].type === 'insufficient_evidence');
    checks.push({
      id: 'playbook_match',
      status: playbook ? (preferPlaybook ? 'passed' : 'not_applicable') : 'not_applicable',
      detail: playbook
        ? preferPlaybook
          ? locale === 'sw'
            ? 'Playbook ya uhakika imetumika kama fallback baada ya ushahidi wa manual kuwa mdogo.'
            : 'Deterministic playbook used as fallback after weak manual evidence.'
          : locale === 'sw'
            ? 'Playbook ipo lakini mwongozo wa manual umetumika kwanza.'
            : 'Deterministic playbook was available, but manual-first reasoning was preferred.'
        : locale === 'sw'
          ? 'Hakuna playbook ya uhakika kwa kosa hili.'
          : 'No deterministic playbook matched this error context.',
    });
    if (preferPlaybook && playbook) {
      return {
        mode: 'playbook',
        checks,
        primary_blocker: {
          type: 'playbook_match',
          message:
            locale === 'sw'
              ? `Tatizo linaendana na playbook: ${playbook.title}.`
              : `Issue matches playbook: ${playbook.title}.`,
          actions: [],
        },
        secondary_blockers: deduped.slice(0, 2).map((item) => this.stripScore(item)),
        dependency_chain: dependencyChain?.length ? dependencyChain : null,
      };
    }
    return {
      mode: currentEntry ? 'dependency' : deduped.length ? 'dependency' : 'fallback',
      checks,
      primary_blocker: deduped[0] ? this.stripScore(deduped[0]) : null,
      secondary_blockers: deduped.slice(1, 3).map((item) => this.stripScore(item)),
      dependency_chain: dependencyChain?.length ? dependencyChain : null,
    };
  }

  private evaluateScopeAlignment(input: {
    locale: ManualLocale;
    contextRoute: string;
    errorRoute: string | null;
    scope: ContextPayload['scope'];
  }) {
    const branchScopeSize = Array.isArray(input.scope.branch_scope)
      ? input.scope.branch_scope.length
      : 0;
    if (branchScopeSize > 1 && !input.scope.active_branch_id) {
      return {
        check: {
          id: 'scope_alignment' as const,
          status: 'failed' as ReasoningCheckStatus,
          detail:
            input.locale === 'sw'
              ? 'Tawi la kazi halijachaguliwa wakati una branch zaidi ya moja.'
              : 'Active branch is not selected while multiple branches are in scope.',
        },
        blocker: {
          type: 'scope_mismatch' as const,
          message:
            input.locale === 'sw'
              ? 'Chagua tawi sahihi kwanza ili muktadha wa kazi uendane na hatua unayotaka kufanya.'
              : 'Select the correct branch first so operation context matches this action.',
          actions:
            input.locale === 'sw'
              ? [
                  'Tumia branch switcher kuchagua tawi sahihi.',
                  'Rudia hatua baada ya kuchagua tawi.',
                ]
              : [
                  'Use the branch switcher to select the correct branch.',
                  'Retry the action after selecting the branch.',
                ],
        },
      };
    }

    if (!input.errorRoute) {
      return {
        check: {
          id: 'scope_alignment' as const,
          status: 'not_applicable' as ReasoningCheckStatus,
          detail:
            input.locale === 'sw'
              ? 'Hakuna error route ya kulinganisha muktadha.'
              : 'No error route is attached for scope comparison.',
        },
        blocker: null,
      };
    }
    const normalizedErrorRoute = this.normalizeRoute(input.errorRoute);
    if (normalizedErrorRoute === input.contextRoute) {
      return {
        check: {
          id: 'scope_alignment' as const,
          status: 'passed' as ReasoningCheckStatus,
          detail:
            input.locale === 'sw'
              ? 'Error route inaendana na route ya sasa.'
              : 'Error route matches the current page route.',
        },
        blocker: null,
      };
    }
    return {
      check: {
        id: 'scope_alignment' as const,
        status: 'failed' as ReasoningCheckStatus,
        detail:
          input.locale === 'sw'
            ? 'Error route haitoshi na route ya sasa.'
            : 'Attached error route does not match the current page route.',
      },
      blocker: {
        type: 'scope_mismatch' as const,
        message:
          input.locale === 'sw'
            ? 'Kosa linaonekana kutoka route tofauti na ukurasa wa sasa.'
            : 'The error appears to come from a different page than the current route.',
        actions:
          input.locale === 'sw'
            ? [
                'Rudi kwenye ukurasa ambao kosa lilitokea kwanza.',
                'Jaribu tena hatua hiyo na tuma muktadha mpya wa kosa.',
              ]
            : [
                'Go back to the page where the error actually occurred.',
                'Retry that action and attach fresh error context.',
              ],
      },
    };
  }

  private evaluateSequence(input: {
    locale: ManualLocale;
    entry: ManualEntry;
    readiness: Record<string, unknown>;
  }): {
    check: ReasoningCheck;
    blocker: ReasoningBlocker | null;
    blockingRoute: string | null;
  } {
    const beforePages = (input.entry.related_pages ?? []).filter(
      (item) => item.order?.toLowerCase() === 'before',
    );
    if (!beforePages.length) {
      return {
        check: {
          id: 'sequence_order' as const,
          status: 'not_applicable' as ReasoningCheckStatus,
          detail:
            input.locale === 'sw'
              ? 'Hakuna utegemezi wa sequence uliobainishwa.'
              : 'No upstream sequence dependency is declared for this page.',
        },
        blocker: null,
        blockingRoute: null,
      };
    }

    for (const beforePage of beforePages) {
      const matched = this.findSequenceMapEntry(beforePage.route);
      if (!matched) {
        continue;
      }
      const [, rule] = matched;
      if (rule.isBlocked(input.readiness)) {
        return {
          check: {
            id: 'sequence_order' as const,
            status: 'failed' as ReasoningCheckStatus,
            detail: input.locale === 'sw' ? rule.detailSw : rule.detailEn,
          },
          blocker: {
            type: 'sequence_violation' as const,
            message: input.locale === 'sw' ? rule.messageSw : rule.messageEn,
            actions: input.locale === 'sw' ? rule.actionsSw : rule.actionsEn,
          },
          blockingRoute: beforePage.route,
        };
      }
    }

    return {
      check: {
        id: 'sequence_order' as const,
        status: 'passed' as ReasoningCheckStatus,
        detail:
          input.locale === 'sw'
            ? 'Hakuna dalili ya sequence violation kwa sasa.'
            : 'No active sequence violation was detected from readiness signals.',
      },
      blocker: null,
      blockingRoute: null,
    };
  }

  private findSequenceMapEntry(
    route: string,
  ): [string, (typeof this.SEQUENCE_READINESS_MAP)[string]] | null {
    for (const [pattern, rule] of Object.entries(this.SEQUENCE_READINESS_MAP)) {
      if (route.includes(pattern)) {
        return [pattern, rule];
      }
    }
    return null;
  }

  private traverseDependencyChain(
    locale: ManualLocale,
    blockingRoute: string,
    readiness: Record<string, unknown>,
    depth: number,
  ): DependencyChainLink[] {
    if (depth >= 3) {
      return [];
    }
    const normalizedRoute = this.normalizeRoute(blockingRoute);
    const entry = this.getEntryByRoute(locale, normalizedRoute);
    if (!entry) {
      return [];
    }
    const beforePages = (entry.related_pages ?? []).filter(
      (item) => item.order?.toLowerCase() === 'before',
    );
    for (const beforePage of beforePages) {
      const matched = this.findSequenceMapEntry(beforePage.route);
      if (!matched) {
        continue;
      }
      const [, rule] = matched;
      if (rule.isBlocked(readiness)) {
        const link: DependencyChainLink = {
          page_route: beforePage.route,
          blocker_message: locale === 'sw' ? rule.messageSw : rule.messageEn,
          actions: locale === 'sw' ? rule.actionsSw : rule.actionsEn,
        };
        return [
          link,
          ...this.traverseDependencyChain(locale, beforePage.route, readiness, depth + 1),
        ];
      }
    }
    return [];
  }

  private evaluatePermissions(input: {
    locale: ManualLocale;
    entry: ManualEntry;
    grantedPermissions: string[];
  }) {
    const required = new Set<string>();
    for (const permission of input.entry.permissions_required ?? []) {
      if (!permission?.trim()) {
        continue;
      }
      const parsedCodes = this.extractPermissionCodes(permission);
      if (parsedCodes.length) {
        for (const code of parsedCodes) {
          required.add(code);
        }
        continue;
      }
      const normalized = permission.trim().toLowerCase();
      if (this.knownPermissionCodes.has(normalized)) {
        required.add(normalized);
      }
    }
    const prereqChecks = [
      ...(input.entry.prerequisites ?? []).map((item) => item.check),
      ...(input.entry.before_you_start ?? []).map((item) => item.text),
    ];
    for (const check of prereqChecks) {
      const parsedCodes = this.extractPermissionCodes(check);
      for (const code of parsedCodes) {
        required.add(code);
      }
    }

    if (!required.size) {
      return {
        check: {
          id: 'permission_gate' as const,
          status: 'not_applicable' as ReasoningCheckStatus,
          detail:
            input.locale === 'sw'
              ? 'Hakuna permission code iliyobainishwa kwa route hii.'
              : 'No explicit permission codes are declared for this route.',
        },
        blocker: null,
      };
    }

    const granted = new Set((input.grantedPermissions ?? []).map((item) => item.toLowerCase()));
    const missing = [...required].filter((permission) => !granted.has(permission));
    if (!missing.length) {
      return {
        check: {
          id: 'permission_gate' as const,
          status: 'passed' as ReasoningCheckStatus,
          detail:
            input.locale === 'sw'
              ? 'Seti ya ruhusa inaendana na route ya sasa.'
              : 'Permission set appears aligned for this route.',
        },
        blocker: null,
      };
    }
    return {
      check: {
        id: 'permission_gate' as const,
        status: 'failed' as ReasoningCheckStatus,
        detail:
          input.locale === 'sw'
            ? 'Baadhi ya ruhusa zinazohitajika zinaonekana kukosekana.'
            : 'Some required permission gates are likely missing.',
      },
      blocker: {
        type: 'permission_likely_missing' as const,
        message:
          input.locale === 'sw'
            ? 'Jukumu lako linaonekana kukosa ruhusa za kufanya hatua hii.'
            : 'Your role likely lacks one or more permissions required for this action.',
        actions:
          input.locale === 'sw'
            ? [
                'Kagua role yako kwenye Settings - Roles.',
                'Omba admin aongeze ruhusa zinazohitajika kwa hatua hii.',
              ]
            : [
                'Review your role on Settings - Roles.',
                'Ask an administrator to grant the permissions required for this action.',
              ],
      },
    };
  }

  private extractPermissionCodes(text: string) {
    if (!text?.trim()) {
      return [] as string[];
    }
    const matches = text.match(/\b[a-z]+(?:\.[a-z-]+)+\b/gi) ?? [];
    const normalized = matches
      .map((item) => item.toLowerCase())
      .filter((item) => this.knownPermissionCodes.has(item));
    return [...new Set(normalized)];
  }

  private evaluatePrerequisites(input: {
    locale: ManualLocale;
    entry: ManualEntry;
    readiness: Record<string, unknown>;
  }) {
    const checks = [
      ...(input.entry.prerequisites ?? []).map((item) => item.check),
      ...(input.entry.before_you_start ?? []).map((item) => item.text),
    ].map((text) => text.toLowerCase());
    const categoriesCount = this.asNumber(input.readiness.categories_count);
    const hasOpenShift = this.asBoolean(input.readiness.has_open_shift_in_active_branch);
    const hasSuppliers = this.asBoolean(input.readiness.has_suppliers);

    const categoryRequired =
      checks.some(
        (check) =>
          check.includes('category') || check.includes('kategoria') || check.includes('jamii'),
      ) || input.entry.route.includes('/catalog/products');
    if (categoryRequired && categoriesCount === 0) {
      return {
        check: {
          id: 'prerequisite_state' as const,
          status: 'failed' as ReasoningCheckStatus,
          detail:
            input.locale === 'sw'
              ? 'Masharti ya category hayajatimizwa.'
              : 'Category prerequisite is not satisfied.',
        },
        blocker: {
          type: 'prerequisite_missing' as const,
          message:
            input.locale === 'sw'
              ? 'Huwezi kuendelea bila category ya msingi.'
              : 'You cannot proceed until a required category foundation exists.',
          actions:
            input.locale === 'sw'
              ? [
                  'Unda category angalau moja kwenye Catalog - Categories.',
                  'Rudi hapa baada ya category kuwa ACTIVE.',
                ]
              : [
                  'Create at least one category in Catalog - Categories.',
                  'Return here after the category is active.',
                ],
        },
      };
    }

    const shiftRequired =
      checks.some((check) => check.includes('shift')) || input.entry.route.includes('/pos');
    if (shiftRequired && hasOpenShift === false) {
      return {
        check: {
          id: 'prerequisite_state' as const,
          status: 'failed' as ReasoningCheckStatus,
          detail:
            input.locale === 'sw'
              ? 'Hakuna shift iliyo OPEN kwa tawi hili.'
              : 'No open shift is available for the active branch.',
        },
        blocker: {
          type: 'prerequisite_missing' as const,
          message:
            input.locale === 'sw'
              ? 'POS inahitaji shift iliyo wazi kabla ya mauzo.'
              : 'POS workflows require an open shift before sales actions.',
          actions:
            input.locale === 'sw'
              ? ['Fungua shift kwenye Shifts page.', 'Rudi POS na ujaribu tena.']
              : ['Open a shift on the Shifts page.', 'Return to POS and retry.'],
        },
      };
    }

    const supplierRequired =
      checks.some((check) => check.includes('supplier')) ||
      input.entry.route.includes('/purchase-orders') ||
      input.entry.route.includes('/purchases') ||
      input.entry.route.includes('/receiving');
    if (supplierRequired && hasSuppliers === false) {
      return {
        check: {
          id: 'prerequisite_state' as const,
          status: 'failed' as ReasoningCheckStatus,
          detail:
            input.locale === 'sw'
              ? 'Supplier prerequisite haijatimizwa.'
              : 'Supplier prerequisite is not satisfied.',
        },
        blocker: {
          type: 'prerequisite_missing' as const,
          message:
            input.locale === 'sw'
              ? 'Mtiririko huu unahitaji supplier mmoja au zaidi wa ACTIVE.'
              : 'This flow requires at least one active supplier record.',
          actions:
            input.locale === 'sw'
              ? ['Unda supplier kwanza kwenye Suppliers page.', 'Rudia hatua uliyojaribu.']
              : ['Create a supplier first on the Suppliers page.', 'Retry your action.'],
        },
      };
    }

    return {
      check: {
        id: 'prerequisite_state' as const,
        status: 'passed' as ReasoningCheckStatus,
        detail:
          input.locale === 'sw'
            ? 'Hakuna prerequisite blocker iliyogunduliwa sasa.'
            : 'No prerequisite blocker was detected from available readiness signals.',
      },
      blocker: null,
    };
  }

  private evaluateErrorFamily(input: {
    locale: ManualLocale;
    entry: ManualEntry;
    errorCode: string | null;
    errorMessage: string | null;
    intent: ChatIntent;
    retrievalResults: RetrievalResult[];
  }) {
    if (input.intent !== 'troubleshoot_error') {
      return {
        check: {
          id: 'error_family_match' as const,
          status: 'not_applicable' as ReasoningCheckStatus,
          detail:
            input.locale === 'sw'
              ? 'Intent si ya troubleshooting.'
              : 'Intent is not troubleshooting.',
        },
        blocker: null,
      };
    }

    const normalizedCode =
      this.normalizeErrorCode(
        input.errorCode ?? this.extractErrorCodeFromMessage(input.errorMessage) ?? null,
      ) ?? null;
    if (!normalizedCode) {
      return {
        check: {
          id: 'error_family_match' as const,
          status: 'not_applicable' as ReasoningCheckStatus,
          detail:
            input.locale === 'sw'
              ? 'Hakuna error code iliyobainishwa.'
              : 'No structured error code is available for family matching.',
        },
        blocker: null,
      };
    }

    const matched = (input.entry.common_errors ?? []).find((item) =>
      this.errorCodeMatches(normalizedCode, item.error_code),
    );
    if (!matched) {
      const semanticMatch = this.findSemanticErrorMatch({
        locale: input.locale,
        entry: input.entry,
        errorCode: normalizedCode,
        errorMessage: input.errorMessage,
        retrievalResults: input.retrievalResults,
      });
      if (semanticMatch) {
        return {
          check: {
            id: 'error_family_match' as const,
            status: 'passed' as ReasoningCheckStatus,
            detail:
              input.locale === 'sw'
                ? 'Hakuna code match ya moja kwa moja; familia ya kosa imekadiriwa kwa ushahidi wa maana kutoka manual.'
                : 'No exact code match; error family inferred from manual semantic evidence.',
          },
          blocker: {
            type: 'error_family_match' as const,
            message: semanticMatch.likelyCause,
            actions: semanticMatch.actions,
          },
        };
      }
      return {
        check: {
          id: 'error_family_match' as const,
          status: 'failed' as ReasoningCheckStatus,
          detail:
            input.locale === 'sw'
              ? 'Error code haijalingana na familia ya makosa ya ukurasa huu.'
              : 'Error code does not map to this page error family.',
        },
        blocker: {
          type: 'insufficient_evidence' as const,
          message:
            input.locale === 'sw'
              ? 'Kosa hili halina mapping ya moja kwa moja kwenye errors za ukurasa huu.'
              : 'This error is not directly mapped to the known error family for this page.',
          actions:
            input.locale === 'sw'
              ? [
                  'Thibitisha route ya kosa na urudie hatua kwenye ukurasa sahihi.',
                  'Ikiendelea, tuma error code, route na muda kwa support.',
                ]
              : [
                  'Confirm the exact page where the error occurred and retry there.',
                  'If it persists, escalate with error code, route, and timestamp.',
                ],
        },
      };
    }

    return {
      check: {
        id: 'error_family_match' as const,
        status: 'passed' as ReasoningCheckStatus,
        detail:
          input.locale === 'sw'
            ? 'Error code inalingana na familia ya kosa iliyorekodiwa.'
            : 'Error code matches a documented page error family.',
      },
      blocker: {
        type: 'error_family_match' as const,
        message: matched.likely_cause,
        actions: matched.fix_steps.slice(0, 4),
      },
    };
  }

  private withScore(blocker: ReasoningBlocker): ScoredReasoningBlocker {
    return {
      ...blocker,
      score: this.blockerScore(blocker.type),
    };
  }

  private stripScore(blocker: ScoredReasoningBlocker): ReasoningBlocker {
    const { score: _score, ...plain } = blocker;
    return plain;
  }

  private rankAndDedupeBlockers(blockers: ScoredReasoningBlocker[]) {
    const seen = new Map<string, ScoredReasoningBlocker>();
    for (const blocker of blockers) {
      const key = `${blocker.type}:${blocker.message}`;
      const existing = seen.get(key);
      if (!existing || blocker.score > existing.score) {
        seen.set(key, blocker);
      }
    }
    return [...seen.values()].sort((a, b) => b.score - a.score);
  }

  private findSemanticErrorMatch(input: {
    locale: ManualLocale;
    entry: ManualEntry;
    errorCode: string | null;
    errorMessage: string | null;
    retrievalResults: RetrievalResult[];
  }): { likelyCause: string; actions: string[] } | null {
    const queryTokens = this.tokenizeForSemanticMatch(
      [input.errorCode ?? '', input.errorMessage ?? ''].join(' '),
    );
    if (!queryTokens.length) {
      return null;
    }

    let best:
      | {
          score: number;
          likelyCause: string;
          actions: string[];
        }
      | null = null;

    for (const item of (input.entry.common_errors ?? [])) {
      const corpus = [item.error_code, item.likely_cause, ...(item.fix_steps ?? [])].join(' ');
      const overlap = this.semanticOverlapStats(queryTokens, corpus);
      const score = overlap.weighted;
      if (
        overlap.matched >= 2 &&
        score >= 3 &&
        (!best || score > best.score)
      ) {
        best = {
          score,
          likelyCause: item.likely_cause,
          actions: item.fix_steps.slice(0, 4),
        };
      }
    }

    if (best) {
      return { likelyCause: best.likelyCause, actions: best.actions };
    }

    // Broader manual dependency evidence: purpose, workflow, prerequisites, related pages,
    // and retrieved chunks with section-aware + route-aware weighting.
    const localDependencyCorpora: Array<{
      text: string;
      actions: string[];
      section: RetrievalResult['section'];
      sameRoute: boolean;
    }> = [];

    const purposeText = input.entry.overview ?? input.entry.purpose ?? null;
    if (purposeText) {
      localDependencyCorpora.push({
        text: purposeText,
        actions:
          input.locale === 'sw'
            ? ['Anza na lengo la ukurasa huu kisha fuata hatua za kazi kwa mpangilio.']
            : ['Start from this page purpose, then follow the workflow in order.'],
        section: 'purpose',
        sameRoute: true,
      });
    }
    const workflowItems: Array<{ text: string; actions: string[] }> = [
      ...(input.entry.workflow ?? []).map((step) => ({
        text: [step.step, step.expected_result, step.if_blocked].filter(Boolean).join(' '),
        actions: [step.step, ...(step.if_blocked ? [step.if_blocked] : [])].slice(0, 3),
      })),
      ...(input.entry.common_tasks ?? []).map((task) => ({
        text: [task.task, ...task.steps].join(' '),
        actions: task.steps.slice(0, 3),
      })),
    ];
    for (const item of workflowItems) {
      if (!item.text) continue;
      localDependencyCorpora.push({
        text: item.text,
        actions: item.actions,
        section: 'workflow',
        sameRoute: true,
      });
    }
    const semanticPrereqs = [
      ...(input.entry.prerequisites ?? []).map((item) => item.check),
      ...(input.entry.before_you_start ?? []).map((item) => item.text),
    ];
    for (const text of semanticPrereqs) {
      if (!text) continue;
      localDependencyCorpora.push({
        text,
        actions:
          input.locale === 'sw'
            ? ['Kagua masharti ya awali ya ukurasa huu, kisha jaribu tena hatua uliyokuwa unafanya.']
            : ['Review this page prerequisite and retry the action.'],
        section: 'prerequisites',
        sameRoute: true,
      });
    }
    for (const related of input.entry.related_pages ?? []) {
      if (!related.reason) {
        continue;
      }
      localDependencyCorpora.push({
        text: related.reason,
        actions:
          input.locale === 'sw'
            ? ['Fungua ukurasa husika uliopendekezwa, timiza hatua ya utegemezi, kisha urudi hapa.']
            : ['Open the suggested related page, complete that dependency step, then return here.'],
        section: 'links',
        sameRoute: false,
      });
    }

    const retrievalEvidence = input.retrievalResults.map((item) => ({
      text: item.text,
      actions:
        item.section === 'workflow'
          ? input.locale === 'sw'
            ? ['Fuata mtiririko wa hatua za kazi kwa mpangilio kisha ujaribu tena.']
            : ['Follow the workflow sequence in order, then retry.']
          : item.section === 'prerequisites'
            ? input.locale === 'sw'
              ? ['Timiza masharti ya awali yaliyooneshwa kwa ukurasa huu.']
              : ['Satisfy the listed prerequisites for this page.']
            : input.locale === 'sw'
              ? ['Kagua muktadha wa ukurasa na hatua zinazohusiana, kisha jaribu tena.']
              : ['Review page context and related steps, then retry.'],
      section: item.section,
      sameRoute: this.normalizeRoute(item.route) === this.normalizeRoute(input.entry.route),
    }));

    const retrievalCandidate = [...localDependencyCorpora, ...retrievalEvidence]
      .map((item) => ({
        overlap: this.semanticOverlapStats(queryTokens, item.text),
        section: item.section,
        sameRoute: item.sameRoute,
        text: item.text,
        actions: item.actions,
      }))
      .filter((item) => item.overlap.matched >= 2)
      .map((item) => ({
        score:
          item.overlap.weighted +
          this.semanticSectionWeight(item.section) +
          (item.sameRoute ? 2 : 0),
        text: item.text,
        actions: item.actions,
      }))
      .sort((a, b) => b.score - a.score)[0];

    if (!retrievalCandidate || retrievalCandidate.score < 2) {
      return null;
    }

    const inferredCause = this.trimSentence(retrievalCandidate.text);
    if (!inferredCause) {
      return null;
    }
    return {
      likelyCause: inferredCause,
      actions: retrievalCandidate.actions,
    };
  }

  private semanticOverlapStats(queryTokens: string[], corpus: string) {
    const corpusTokens = new Set(this.tokenizeForSemanticMatch(corpus));
    let weighted = 0;
    let matched = 0;
    for (const token of queryTokens) {
      if (corpusTokens.has(token)) {
        matched += 1;
        weighted += token.length >= 8 ? 2 : 1;
      }
    }
    return { weighted, matched };
  }

  private semanticSectionWeight(section: RetrievalResult['section']) {
    switch (section) {
      case 'errors':
        return 3;
      case 'prerequisites':
        return 2;
      case 'workflow':
        return 1.5;
      case 'purpose':
        return 1;
      case 'links':
      default:
        return 0.5;
    }
  }

  private tokenizeForSemanticMatch(text: string) {
    const stopWords = new Set([
      'error',
      'errors',
      'failed',
      'failure',
      'request',
      'requests',
      'business',
      'settings',
      'setting',
      'active',
      'user',
      'users',
      'missing',
      'required',
      'require',
      'context',
      'route',
      'page',
      'please',
      'this',
      'that',
    ]);
    return Array.from(
      new Set(
        text
          .toLowerCase()
          .split(/[^a-z0-9_]+/i)
          .map((token) => token.trim())
          .filter((token) => token.length >= 4 && !stopWords.has(token)),
      ),
    );
  }

  private trimSentence(text: string) {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) {
      return null;
    }
    const first = clean.split(/[.!?]/).find((part) => part.trim().length > 0)?.trim();
    return first && first.length > 8 ? first : clean.slice(0, 180);
  }

  private blockerScore(type: ReasoningBlocker['type']) {
    switch (type) {
      case 'error_family_match':
        return 0.95;
      case 'scope_mismatch':
        return 0.91;
      case 'sequence_violation':
        return 0.89;
      case 'prerequisite_missing':
        return 0.87;
      case 'permission_likely_missing':
        return 0.84;
      case 'playbook_match':
        return 0.98;
      case 'insufficient_evidence':
      default:
        return 0.55;
    }
  }

  private getEntryByRoute(locale: ManualLocale, route: string) {
    const map = this.getLocaleMap(locale).byRoute;
    return map.get(route) ?? null;
  }

  private getLocaleMap(locale: ManualLocale) {
    const cached = this.manualCache.get(locale);
    if (cached) {
      return cached;
    }
    const sourcePath = this.resolveFilePath(
      this.config.get<string>('supportChat.manualSourceDir')
        ? path.join(
            this.config.get<string>('supportChat.manualSourceDir')!,
            `manual.${locale}.json`,
          )
        : `frontend/docs/manual/manual.${locale}.json`,
    );
    const dataset = JSON.parse(fs.readFileSync(sourcePath, 'utf8')) as ManualDataset;
    const byRoute = new Map<string, ManualEntry>();
    const byId = new Map<string, ManualEntry>();
    for (const entry of dataset.entries ?? []) {
      byRoute.set(this.normalizeRoute(entry.route), entry);
      byId.set(entry.id, entry);
    }
    const resolved = { byRoute, byId };
    this.manualCache.set(locale, resolved);
    return resolved;
  }

  private normalizeRoute(route: string) {
    const clean = route.split('?')[0].split('#')[0].trim();
    return (clean || '/{locale}').replace(/^\/(en|sw)(?=\/|$)/, '/{locale}');
  }

  private resolveFilePath(relativeOrAbsolute: string) {
    if (path.isAbsolute(relativeOrAbsolute)) {
      return relativeOrAbsolute;
    }
    const local = path.resolve(process.cwd(), relativeOrAbsolute);
    if (fs.existsSync(local)) {
      return local;
    }
    return path.resolve(process.cwd(), '..', relativeOrAbsolute);
  }

  private asNumber(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  private asBoolean(value: unknown) {
    return typeof value === 'boolean' ? value : null;
  }

  private normalizeErrorCode(code: string | null | undefined) {
    if (!code) {
      return null;
    }
    const normalized = code
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/_+/g, '_');
    return normalized || null;
  }

  private extractErrorCodeFromMessage(message: string | null) {
    if (!message) {
      return null;
    }
    const match = message.match(/\b[A-Z][A-Z0-9_]{2,}\b/g)?.[0] ?? null;
    return this.normalizeErrorCode(match);
  }

  private errorCodeMatches(targetCode: string, candidateCode: string) {
    const normalizedCandidate = this.normalizeErrorCode(candidateCode);
    if (!normalizedCandidate) {
      return false;
    }
    if (
      normalizedCandidate === targetCode ||
      normalizedCandidate.includes(targetCode) ||
      targetCode.includes(normalizedCandidate)
    ) {
      return true;
    }
    const targetTokens = new Set(targetCode.split('_').filter((token) => token.length >= 4));
    const candidateTokens = normalizedCandidate
      .split('_')
      .filter((token) => token.length >= 4);
    let overlaps = 0;
    for (const token of candidateTokens) {
      if (targetTokens.has(token)) {
        overlaps += 1;
      }
      if (overlaps >= 2) {
        return true;
      }
    }
    return false;
  }
}
