import { Injectable } from '@nestjs/common';
import { SupportChatReasoning } from './support-chat-reasoner.service';

type ManualLocale = 'en' | 'sw';
type ChatIntent = 'explain_page' | 'troubleshoot_error' | 'how_to' | 'what_next';
type ResponseDepth = 'simple' | 'standard' | 'detailed';

type ContextPayload = {
  route: string;
  locale: ManualLocale;
  module: string;
  selected_error_id?: string | null;
  user: {
    id: string;
    email: string;
    scope: 'platform' | 'business' | 'support';
    role_ids: string[];
    permission_codes: string[];
  };
  scope: {
    business_id: string;
    branch_scope: string[];
    active_branch_id: string | null;
  };
  readiness_signals: Record<string, unknown>;
  latest_error: {
    error_code: string | null;
    error_message: string | null;
    error_source: 'backend' | 'frontend' | 'network' | 'unknown' | string;
    error_time: string | null;
    error_route: string | null;
  };
  generated_at: string;
};

type RetrievalResult = {
  score: number;
  chunk_id: string;
  id: string;
  route: string;
  module: string;
  locale: ManualLocale;
  section: 'purpose' | 'prerequisites' | 'workflow' | 'errors' | 'links';
  title: string;
  source: string;
  error_codes: string[];
  text: string;
};

type RetrievalPayload = {
  retrieval_mode: 'none' | 'vector' | 'keyword';
  result_count?: number;
  results: RetrievalResult[];
  deterministic_playbook?: {
    error_code: string;
    title: string;
    diagnosis: string;
    likely_cause: string;
    steps: string[];
    related_routes: string[];
    confidence: 'high' | 'medium' | 'low';
    confidence_reason?: string;
    source?: 'seeded' | 'manual';
  } | null;
};

type ComposeInput = {
  question: string;
  locale: ManualLocale;
  intent: ChatIntent;
  responseDepth: ResponseDepth;
  context: ContextPayload;
  retrieval: RetrievalPayload;
  reasoning: SupportChatReasoning;
  escalationContact: string;
};

type IntentPayloadSection = {
  key: string;
  title: string;
  kind: 'text' | 'list' | 'links';
  lines?: string[];
  links?: Array<{ route: string; reason?: string }>;
  collapsed?: boolean;
  secondary?: boolean;
};

type IntentPayload = {
  intent: ChatIntent;
  sections: IntentPayloadSection[];
};

@Injectable()
export class SupportChatComposerService {
  compose(input: ComposeInput) {
    const locale = input.locale;
    // Manual-first behavior: deterministic playbook is used only when reasoner
    // explicitly selected playbook mode as fallback for weak manual evidence.
    const playbook =
      input.reasoning.mode === 'playbook'
        ? input.retrieval.deterministic_playbook ?? null
        : null;
    const results = input.retrieval.results ?? [];
    const top = results[0] ?? null;
    const hasErrorContext = Boolean(
      input.context.latest_error.error_code || input.context.latest_error.error_message,
    );
    const rawReasonedBlocker = input.reasoning.primary_blocker;
    const purposeText = this.extractPurpose(results);
    const workflowSteps = this.extractWorkflow(results);
    const prerequisiteChecks = this.extractPrerequisites(results);
    const confidence = this.resolveConfidence({
      intent: input.intent,
      retrieval_mode: input.retrieval.retrieval_mode,
      playbookConfidence: playbook?.confidence ?? null,
      topScore: top?.score ?? null,
      resultCount: results.length,
      hasPurpose: Boolean(purposeText),
      workflowCount: workflowSteps.length,
    });
    const depth = input.responseDepth;
    const reasonedBlocker =
      input.intent === 'explain_page' ? null : input.reasoning.primary_blocker;
    const permissionLimited = this.detectPermissionLimited({
      question: input.question,
      permissions: input.context.user.permission_codes ?? [],
    });
    const hasActionableIssue = hasErrorContext || Boolean(rawReasonedBlocker) || permissionLimited;
    const escalate =
      input.intent === 'explain_page' ? false : confidence === 'low' && hasActionableIssue;

    let summary = this.buildSummary({
      locale,
      intent: input.intent,
      depth,
      confidence,
      playbookTitle: playbook?.title ?? null,
      purposeText,
      reasonedBlockerMessage: reasonedBlocker?.message ?? null,
      isUnmappedErrorFlow:
        input.intent === 'troubleshoot_error' && hasErrorContext && !playbook,
      latestErrorCode: input.context.latest_error.error_code,
    });

    let primaryIssue = this.buildPrimaryIssue({
      locale,
      intent: input.intent,
      playbookDiagnosis: playbook?.diagnosis ?? null,
      reasonedBlockerMessage: reasonedBlocker?.message ?? null,
      purposeText,
      latestErrorCode: input.context.latest_error.error_code,
      latestErrorMessage: input.context.latest_error.error_message,
      confidence,
      workflowFirstStep: workflowSteps[0] ?? null,
    });

    let steps = this.buildSteps({
      locale,
      intent: input.intent,
      depth,
      playbookSteps: playbook?.steps ?? [],
      reasonedActions: reasonedBlocker?.actions ?? [],
      workflowSteps,
      prerequisiteChecks,
      escalationContact: input.escalationContact,
      confidence,
    });

    steps = this.dedupeSteps(steps, summary, primaryIssue);
    summary = this.cleanSentence(summary);
    primaryIssue = this.cleanSentence(primaryIssue);
    const errorInterpretation = this.cleanSentence(
      this.buildErrorInterpretation({
        locale,
        context: input.context,
        reasoningMode: input.reasoning.mode,
        intent: input.intent,
        depth,
      }),
    );
    const diagnosis = this.dedupeDiagnosisFields({
      primaryIssue,
      errorInterpretation,
    });

    const sources = results.slice(0, depth === 'simple' ? 3 : 6).map((item) => ({
      id: item.id,
      route: item.route,
      locale: item.locale,
      section: item.section,
      source: item.source,
    }));

    const relatedRoutes = this.buildRelatedRoutes({
      locale,
      depth,
      contextRoute: input.context.route,
      playbookRoutes: playbook?.related_routes ?? [],
      resultRoutes: results.map((item) => item.route),
    });

    const alternatives =
      input.intent === 'explain_page'
        ? []
        : permissionLimited || (confidence === 'low' && hasActionableIssue)
          ? this.buildAlternatives({
              locale,
              permissionLimited,
              escalationContact: input.escalationContact,
            })
          : [];

    const evidence = this.buildEvidence({
      playbook,
      results,
      context: input.context,
      reasoning: input.reasoning,
      depth,
    });

    const intent_payload = this.buildIntentPayload({
      locale,
      intent: input.intent,
      summary,
      primaryIssue: diagnosis.primaryIssue,
      errorInterpretation: diagnosis.errorInterpretation,
      steps,
      prerequisites: prerequisiteChecks,
      relatedRoutes,
      evidence,
      context: input.context,
    });

    return {
      ok: true,
      locale,
      summary,
      diagnosis: {
        primary_issue: diagnosis.primaryIssue,
        evidence,
        error_interpretation: diagnosis.errorInterpretation,
      },
      steps,
      alternatives,
      related_routes: relatedRoutes,
      sources,
      intent_payload,
      confidence,
      escalate,
      escalation_contact: escalate ? input.escalationContact : null,
      policy_flags: {
        used_playbook: Boolean(playbook),
        used_error_context: hasErrorContext,
        used_fallback: !playbook,
        permission_limited: permissionLimited,
      },
      reasoning: {
        mode: input.reasoning.mode,
        checks: input.reasoning.checks,
        primary_blocker: input.reasoning.primary_blocker,
        secondary_blockers: input.reasoning.secondary_blockers,
      },
      meta: {
        retrieval_mode: input.retrieval.retrieval_mode,
        response_depth: depth,
        rendered_intent: input.intent,
        confidence_reason: this.buildConfidenceReason({
          locale,
          intent: input.intent,
          confidence,
          playbookReason: playbook?.confidence_reason ?? null,
          hasErrorContext,
          resultCount: results.length,
          hasPurpose: Boolean(purposeText),
          workflowCount: workflowSteps.length,
        }),
      },
    };
  }

  private buildIntentPayload(input: {
    locale: ManualLocale;
    intent: ChatIntent;
    summary: string;
    primaryIssue: string;
    errorInterpretation: string;
    steps: string[];
    prerequisites: string[];
    relatedRoutes: Array<{ route: string; reason: string }>;
    evidence: string[];
    context: ContextPayload;
  }): IntentPayload {
    const sections: IntentPayloadSection[] = [];

    if (input.intent === 'explain_page') {
      sections.push({
        key: 'about',
        title: input.locale === 'sw' ? 'Ukurasa huu ni wa nini' : 'What this page is for',
        kind: 'text',
        lines: [input.summary],
      });
      if (input.steps.length) {
        sections.push({
          key: 'first-actions',
          title: input.locale === 'sw' ? 'Hatua za kuanza' : 'First actions',
          kind: 'list',
          lines: input.steps.slice(0, 3),
        });
      }
      if (input.prerequisites.length) {
        sections.push({
          key: 'checks',
          title: input.locale === 'sw' ? 'Mambo ya kukagua' : 'Checks before you proceed',
          kind: 'list',
          lines: input.prerequisites.slice(0, 2),
          collapsed: true,
          secondary: true,
        });
      }
      if (input.relatedRoutes.length) {
        sections.push({
          key: 'next',
          title: input.locale === 'sw' ? 'Wapi uende baada ya hapa' : 'Where to go next',
          kind: 'links',
          links: input.relatedRoutes.slice(0, 4),
        });
      }
      return { intent: input.intent, sections };
    }

    if (input.intent === 'troubleshoot_error') {
      sections.push({
        key: 'what-happened',
        title: input.locale === 'sw' ? 'Kilichotokea' : 'What happened',
        kind: 'text',
        lines: [input.primaryIssue],
      });
      if (input.errorInterpretation) {
        sections.push({
          key: 'why-likely',
          title: input.locale === 'sw' ? 'Kwa nini huenda ikawa hivyo' : 'Why this likely happened',
          kind: 'text',
          lines: [input.errorInterpretation],
        });
      }
      if (input.steps.length) {
        sections.push({
          key: 'fix-now',
          title: input.locale === 'sw' ? 'Hatua za kurekebisha sasa' : 'Fix now',
          kind: 'list',
          lines: input.steps.slice(0, 5),
        });
      }
      const technicalLines = this.buildTechnicalLines({
        locale: input.locale,
        errorCode: input.context.latest_error.error_code,
        errorMessage: input.context.latest_error.error_message,
        evidence: input.evidence,
      });
      if (technicalLines.length) {
        sections.push({
          key: 'technical',
          title: input.locale === 'sw' ? 'Maelezo ya kiufundi' : 'Technical details',
          kind: 'list',
          lines: technicalLines,
          collapsed: true,
          secondary: true,
        });
      }
      return { intent: input.intent, sections };
    }

    if (input.intent === 'what_next') {
      sections.push({
        key: 'goal',
        title: input.locale === 'sw' ? 'Lengo la sasa' : 'Current goal',
        kind: 'text',
        lines: [input.summary],
      });
      if (input.steps.length) {
        sections.push({
          key: 'next-steps',
          title: input.locale === 'sw' ? 'Hatua zinazofuata' : 'Next steps',
          kind: 'list',
          lines: input.steps.slice(0, 4),
        });
      }
      if (input.prerequisites.length) {
        sections.push({
          key: 'checks',
          title: input.locale === 'sw' ? 'Mambo ya kukagua' : 'Checks',
          kind: 'list',
          lines: input.prerequisites.slice(0, 2),
          collapsed: true,
          secondary: true,
        });
      }
      return { intent: input.intent, sections };
    }

    sections.push({
      key: 'goal',
      title: input.locale === 'sw' ? 'Unachotaka kufanya' : 'What you want to do',
      kind: 'text',
      lines: [input.summary],
    });
    if (input.steps.length) {
      sections.push({
        key: 'steps',
        title: input.locale === 'sw' ? 'Hatua' : 'Steps',
        kind: 'list',
        lines: input.steps.slice(0, 4),
      });
    }
    if (input.prerequisites.length) {
      sections.push({
        key: 'checks',
        title: input.locale === 'sw' ? 'Mambo ya kukagua' : 'Checks',
        kind: 'list',
        lines: input.prerequisites.slice(0, 2),
        collapsed: true,
        secondary: true,
      });
    }
    return { intent: input.intent, sections };
  }

  private buildTechnicalLines(input: {
    locale: ManualLocale;
    errorCode: string | null;
    errorMessage: string | null;
    evidence: string[];
  }) {
    const lines: string[] = [];
    if (input.errorCode) {
      lines.push(
        input.locale === 'sw'
          ? `Code ya kosa: ${input.errorCode}`
          : `Error code: ${input.errorCode}`,
      );
    }
    if (input.errorMessage) {
      lines.push(
        input.locale === 'sw'
          ? `Ujumbe wa kosa: ${input.errorMessage}`
          : `Error message: ${input.errorMessage}`,
      );
    }
    const manualEvidence = input.evidence
      .filter((item) => item.startsWith('manual:'))
      .slice(0, 3)
      .map((item) =>
        input.locale === 'sw'
          ? `Ushahidi wa manual: ${item}`
          : `Manual evidence: ${item}`,
      );
    lines.push(...manualEvidence);
    return this.cleanList(lines);
  }

  private resolveConfidence(input: {
    intent: ChatIntent;
    retrieval_mode: 'none' | 'vector' | 'keyword';
    playbookConfidence: 'high' | 'medium' | 'low' | null;
    topScore: number | null;
    resultCount: number;
    hasPurpose: boolean;
    workflowCount: number;
  }): 'high' | 'medium' | 'low' {
    if (input.playbookConfidence) {
      return input.playbookConfidence;
    }
    if (input.intent === 'explain_page') {
      if (input.hasPurpose && input.workflowCount >= 1) {
        return input.resultCount >= 2 ? 'high' : 'medium';
      }
      if (input.hasPurpose || input.workflowCount >= 1) {
        return 'medium';
      }
      return 'low';
    }
    if (!input.resultCount || input.topScore === null) {
      return 'low';
    }
    if (input.retrieval_mode === 'vector') {
      if (input.topScore >= 0.78 && input.resultCount >= 2) {
        return 'high';
      }
      if (input.topScore >= 0.45) {
        return 'medium';
      }
      return 'low';
    }
    if (input.retrieval_mode === 'keyword') {
      if (input.topScore >= 4 && input.resultCount >= 2) {
        return 'high';
      }
      if (input.topScore >= 2) {
        return 'medium';
      }
      return 'low';
    }
    return 'low';
  }

  private buildSummary(input: {
    locale: ManualLocale;
    intent: ChatIntent;
    depth: ResponseDepth;
    confidence: 'high' | 'medium' | 'low';
    playbookTitle: string | null;
    purposeText: string | null;
    reasonedBlockerMessage: string | null;
    isUnmappedErrorFlow: boolean;
    latestErrorCode: string | null;
  }) {
    if (input.locale === 'sw') {
      if (input.intent === 'troubleshoot_error') {
        if (input.playbookTitle) {
          return `Tatizo lako linaendana na mwongozo huu: ${input.playbookTitle}.`;
        }
        if (input.reasonedBlockerMessage) {
          return `Kizuizi kinachowezekana ni: ${input.reasonedBlockerMessage}`;
        }
        if (input.isUnmappedErrorFlow) {
          return 'Nimeona kosa la hivi karibuni; nitakupa hatua salama za ukaguzi.';
        }
      }
      if (input.intent === 'explain_page') {
        return input.purposeText
          ? `Ukurasa huu unatumika kwa: ${input.purposeText}`
          : 'Nitaeleza kazi ya ukurasa huu na hatua za kuanza.';
      }
      if (input.intent === 'what_next') {
        return 'Hizi ni hatua zinazofuata kulingana na muktadha wako wa sasa.';
      }
      return input.confidence === 'low'
        ? 'Nina ushahidi mdogo; fuata hatua salama na wasiliana na support ikibidi.'
        : 'Nimeandaa hatua za kufanya sasa.';
    }

    if (input.intent === 'troubleshoot_error') {
      if (input.playbookTitle) {
        return `Your issue matches this guided fix flow: ${input.playbookTitle}.`;
      }
      if (input.reasonedBlockerMessage) {
        return `The likely blocker is: ${input.reasonedBlockerMessage}`;
      }
      if (input.isUnmappedErrorFlow) {
        return 'I detected a recent error; I will guide you through safe troubleshooting checks.';
      }
    }
    if (input.intent === 'explain_page') {
      return input.purposeText
        ? `This page is used to: ${input.purposeText}`
        : 'I will explain what this page does and the first actions to take.';
    }
    if (input.intent === 'what_next') {
      return 'Here are the most useful next steps for your current context.';
    }
    return input.confidence === 'low'
      ? 'I have limited evidence; follow safe checks and contact support if needed.'
      : 'I prepared practical next steps for your workflow.';
  }

  private buildPrimaryIssue(input: {
    locale: ManualLocale;
    intent: ChatIntent;
    playbookDiagnosis: string | null;
    reasonedBlockerMessage: string | null;
    purposeText: string | null;
    workflowFirstStep: string | null;
    latestErrorCode: string | null;
    latestErrorMessage: string | null;
    confidence: 'high' | 'medium' | 'low';
  }) {
    if (input.playbookDiagnosis) {
      return input.playbookDiagnosis;
    }
    if (input.reasonedBlockerMessage) {
      return input.reasonedBlockerMessage;
    }
    if (input.intent === 'explain_page') {
      if (input.workflowFirstStep) {
        return input.locale === 'sw'
          ? `Hatua ya kuanza kwa ukurasa huu ni: ${input.workflowFirstStep}`
          : `The first practical action on this page is: ${input.workflowFirstStep}`;
      }
      return input.locale === 'sw'
        ? 'Nitaanza na hatua ya kwanza ya kutumia ukurasa huu.'
        : 'I will start with the first practical action for this page.';
    }
    if (input.intent === 'troubleshoot_error') {
      if (input.latestErrorCode) {
        return input.locale === 'sw'
          ? 'Kosa la hivi karibuni linahitaji ukaguzi wa hatua husika kwa ukurasa huu.'
          : 'The recent error needs page-specific checks to resolve.';
      }
      if (input.latestErrorMessage) {
        return input.locale === 'sw'
          ? `Kosa lililogunduliwa: ${input.latestErrorMessage}`
          : `Detected error message: ${input.latestErrorMessage}`;
      }
    }
    return input.locale === 'sw'
      ? input.confidence === 'low'
        ? 'Hakuna ushahidi wa kutosha kwa utambuzi wa uhakika.'
        : 'Muktadha wa sasa unaonyesha hatua zinaweza kuendelea kwa utaratibu.'
      : input.confidence === 'low'
        ? 'There is not enough evidence for a high-certainty diagnosis.'
        : 'Current context suggests you can proceed with the guided sequence.';
  }

  private buildSteps(input: {
    locale: ManualLocale;
    intent: ChatIntent;
    depth: ResponseDepth;
    playbookSteps: string[];
    reasonedActions: string[];
    workflowSteps: string[];
    prerequisiteChecks: string[];
    escalationContact: string;
    confidence: 'high' | 'medium' | 'low';
  }) {
    const max = this.depthStepLimit(input.depth);
    const base: string[] = [];

    if (input.playbookSteps.length) {
      base.push(...input.playbookSteps);
    } else if (input.reasonedActions.length) {
      base.push(...input.reasonedActions);
    } else if (input.intent === 'explain_page') {
      base.push(...input.workflowSteps.slice(0, 2));
      if (input.depth !== 'simple') {
        base.push(...input.prerequisiteChecks.slice(0, 1));
      }
    } else if (input.intent === 'what_next') {
      base.push(...input.prerequisiteChecks.slice(0, 2));
      base.push(...input.workflowSteps.slice(0, 2));
    } else {
      base.push(...input.workflowSteps.slice(0, 3));
      if (input.depth !== 'simple') {
        base.push(...input.prerequisiteChecks.slice(0, 1));
      }
    }

    if (!base.length) {
      const fallback =
        input.locale === 'sw'
          ? [
              'Thibitisha uko kwenye ukurasa sahihi wa kazi hii.',
              'Kagua ruhusa za jukumu lako kwenye Roles.',
              `Ukikwama, wasiliana na support: ${input.escalationContact}.`,
            ]
          : [
              'Confirm you are on the correct page for this operation.',
              'Verify your role permissions on the Roles page.',
              `If blocked, contact support at ${input.escalationContact}.`,
            ];
      return fallback.slice(0, max);
    }
    return this.cleanList(base).slice(0, max);
  }

  private buildErrorInterpretation(input: {
    locale: ManualLocale;
    context: ContextPayload;
    reasoningMode: 'playbook' | 'dependency' | 'fallback';
    intent: ChatIntent;
    depth: ResponseDepth;
  }) {
    const errorCode = input.context.latest_error.error_code;
    const errorMessage = input.context.latest_error.error_message;
    if (!errorCode && !errorMessage) {
      if (input.intent === 'explain_page') {
        return '';
      }
      return input.locale === 'sw'
        ? 'Hakuna kosa la hivi karibuni lililotumwa kwenye muktadha huu.'
        : 'No recent error was attached in this context.';
    }

    if (input.locale === 'sw') {
      if (input.depth === 'simple') {
        return 'Kuna kosa la hivi karibuni lililogunduliwa kwa muktadha huu.';
      }
      if (errorCode) {
        return input.reasoningMode === 'dependency'
          ? `Kosa ${errorCode} limeonekana; hatua zimeundwa kwa uchambuzi wa utegemezi wa ukurasa.`
          : `Kosa ${errorCode} limeonekana; hatua zimetolewa kwa muktadha wa ukurasa huu.`;
      }
      return errorMessage
        ? `Ujumbe wa kosa uliotumika: ${errorMessage}`
        : 'Ujumbe wa kosa wa hivi karibuni umetumika kutoa hatua.';
    }

    if (input.depth === 'simple') {
      return 'A recent error was detected in this context.';
    }
    if (errorCode) {
      return input.reasoningMode === 'dependency'
        ? `Error ${errorCode} was detected; guidance is derived from dependency context.`
        : `Error ${errorCode} was detected; guidance is generated from this page context.`;
    }
    return errorMessage
      ? `Detected error message used: ${errorMessage}`
      : 'Recent error text was used to generate guidance.';
  }

  private buildConfidenceReason(input: {
    locale: ManualLocale;
    intent: ChatIntent;
    confidence: 'high' | 'medium' | 'low';
    playbookReason: string | null;
    hasErrorContext: boolean;
    resultCount: number;
    hasPurpose: boolean;
    workflowCount: number;
  }) {
    if (input.playbookReason) {
      return input.playbookReason;
    }
    if (input.intent === 'explain_page') {
      if (input.locale === 'sw') {
        if (input.confidence === 'high') {
          return 'Uhakika ni wa juu kwa sababu lengo na hatua za ukurasa huu zimepatikana kwenye mwongozo.';
        }
        if (input.confidence === 'medium') {
          return 'Uhakika ni wa wastani kwa sababu sehemu ya mwongozo imepatikana lakini si kamili.';
        }
        return 'Uhakika ni wa chini kwa sababu ushahidi wa mwongozo wa ukurasa huu ni mdogo.';
      }
      if (input.confidence === 'high') {
        return 'High confidence because this page purpose and workflow were matched from the manual.';
      }
      if (input.confidence === 'medium') {
        return 'Medium confidence because partial page guidance was matched from the manual.';
      }
      return 'Low confidence because page-specific manual evidence was limited.';
    }
    if (input.locale === 'sw') {
      if (!input.hasErrorContext) {
        return 'Uhakika umetokana na ushahidi wa mwongozo wa ukurasa bila muktadha wa kosa la moja kwa moja.';
      }
      if (input.confidence === 'high') {
        return 'Uhakika ni wa juu kwa sababu muktadha wa kosa na ushahidi wa mwongozo vimeendana.';
      }
      if (input.confidence === 'medium') {
        return 'Uhakika ni wa wastani kwa sababu muktadha wa kosa umeendana kwa sehemu na mwongozo.';
      }
      return 'Uhakika ni wa chini kwa sababu kosa halikuendana moja kwa moja na ushahidi wa mwongozo.';
    }
    if (!input.hasErrorContext) {
      return 'Confidence is based on manual page evidence without direct error context.';
    }
    if (input.confidence === 'high') {
      return 'High confidence because error context and manual evidence aligned clearly.';
    }
    if (input.confidence === 'medium') {
      return 'Medium confidence because error context partially aligned with manual evidence.';
    }
    return 'Low confidence because the error did not map directly to strong manual evidence.';
  }

  private buildEvidence(input: {
    playbook: RetrievalPayload['deterministic_playbook'];
    results: RetrievalResult[];
    context: ContextPayload;
    reasoning: SupportChatReasoning;
    depth: ResponseDepth;
  }) {
    const evidence: string[] = [];
    if (input.playbook?.error_code) {
      evidence.push(`playbook:${input.playbook.error_code}`);
    }
    if (input.context.route) {
      evidence.push(`route:${input.context.route}`);
    }
    if (input.context.module && input.context.module !== 'unknown') {
      evidence.push(`module:${input.context.module}`);
    }
    if (input.context.latest_error.error_code) {
      evidence.push(`error:${input.context.latest_error.error_code}`);
    } else if (input.context.latest_error.error_message) {
      evidence.push('error:message');
    }
    if (input.context.selected_error_id) {
      evidence.push(`selected_error:${input.context.selected_error_id}`);
    }
    const sourceLimit = input.depth === 'simple' ? 2 : 4;
    for (const item of input.results.slice(0, sourceLimit)) {
      evidence.push(`manual:${item.id}:${item.section}`);
    }
    evidence.push(`reasoning_mode:${input.reasoning.mode}`);
    for (const check of input.reasoning.checks.filter((item) => item.status === 'failed')) {
      evidence.push(`reasoning_check_failed:${check.id}`);
    }
    return evidence;
  }

  private buildAlternatives(input: {
    locale: ManualLocale;
    permissionLimited: boolean;
    escalationContact: string;
  }) {
    const alternatives: string[] = [];
    if (input.permissionLimited) {
      alternatives.push(
        input.locale === 'sw'
          ? 'Omba admin abadili ruhusa za jukumu lako au afanye hatua hiyo kwa niaba yako.'
          : 'Ask an administrator to update your role permissions or perform this action for you.',
      );
    }
    alternatives.push(
      input.locale === 'sw'
        ? `Tuma ombi la support na code/route/muda wa kosa: ${input.escalationContact}.`
        : `Open a support request with error code/route/time details: ${input.escalationContact}.`,
    );
    return alternatives;
  }

  private buildRelatedRoutes(input: {
    locale: ManualLocale;
    depth: ResponseDepth;
    contextRoute: string;
    playbookRoutes: string[];
    resultRoutes: string[];
  }) {
    const max = input.depth === 'simple' ? 3 : 6;
    const routes = [
      input.contextRoute,
      ...input.playbookRoutes,
      ...input.resultRoutes.slice(0, 5),
    ];
    const unique = [...new Set(routes.filter(Boolean))].slice(0, max);
    return unique.map((route) => ({
      route,
      reason:
        input.locale === 'sw'
          ? 'Ukurasa husika kwa hatua inayofuata.'
          : 'Relevant page for the next step.',
    }));
  }

  private extractPurpose(results: RetrievalResult[]) {
    const purpose = results.find((item) => item.section === 'purpose')?.text ?? null;
    if (!purpose) {
      return null;
    }
    const first = purpose.split('Audience:')[0]?.trim() ?? purpose.trim();
    return this.cleanSentence(first.replace(/\s+/g, ' '));
  }

  private extractWorkflow(results: RetrievalResult[]) {
    return this.cleanList(
      results
        .filter((item) => item.section === 'workflow')
        .flatMap((item) => item.text.split('|'))
        .map((item) => this.cleanSentence(item))
        .filter((item) => item.length >= 8),
    );
  }

  private extractPrerequisites(results: RetrievalResult[]) {
    return this.cleanList(
      results
        .filter((item) => item.section === 'prerequisites')
        .flatMap((item) => item.text.split('|'))
        .map((item) => this.cleanSentence(item))
        .filter((item) => item.length >= 8),
    );
  }

  private depthStepLimit(depth: ResponseDepth) {
    if (depth === 'detailed') {
      return 6;
    }
    if (depth === 'standard') {
      return 4;
    }
    return 2;
  }

  private cleanSentence(text: string) {
    return text.replace(/\s+/g, ' ').trim();
  }

  private cleanList(items: string[]) {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const item of items) {
      const normalized = this.normalizeText(item);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      list.push(item);
    }
    return list;
  }

  private dedupeSteps(steps: string[], summary: string, diagnosis: string) {
    const summaryNorm = this.normalizeText(summary);
    const diagnosisNorm = this.normalizeText(diagnosis);
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const step of steps) {
      const norm = this.normalizeText(step);
      if (!norm || seen.has(norm)) {
        continue;
      }
      if (norm === summaryNorm || norm === diagnosisNorm) {
        continue;
      }
      seen.add(norm);
      cleaned.push(step);
    }
    return cleaned;
  }

  private dedupeDiagnosisFields(input: {
    primaryIssue: string;
    errorInterpretation: string;
  }) {
    const primaryNorm = this.normalizeText(input.primaryIssue);
    const interpretationNorm = this.normalizeText(input.errorInterpretation);
    if (!interpretationNorm) {
      return input;
    }
    if (!primaryNorm || primaryNorm === interpretationNorm) {
      return {
        primaryIssue: input.primaryIssue,
        errorInterpretation: '',
      };
    }
    if (
      primaryNorm.includes(interpretationNorm) ||
      interpretationNorm.includes(primaryNorm)
    ) {
      return {
        primaryIssue: input.primaryIssue,
        errorInterpretation: '',
      };
    }
    return input;
  }

  private normalizeText(text: string) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private detectPermissionLimited(input: {
    question: string;
    permissions: string[];
  }) {
    const q = input.question.toLowerCase();
    const perms = new Set((input.permissions ?? []).map((item) => item.toLowerCase()));
    if (
      (q.includes('refund') || q.includes('rejesh') || q.includes('marejesho')) &&
      !perms.has('sales.write')
    ) {
      return true;
    }
    if (
      (q.includes('credit') || q.includes('mkopo')) &&
      !perms.has('sales.credit.create')
    ) {
      return true;
    }
    if (
      (q.includes('transfer') || q.includes('hamisho')) &&
      !perms.has('transfers.write')
    ) {
      return true;
    }
    return false;
  }
}
