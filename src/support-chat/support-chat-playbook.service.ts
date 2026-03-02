import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import {
  PlaybookLocale,
  SupportChatPlaybook,
  SUPPORT_CHAT_PLAYBOOKS,
} from './support-chat-playbooks';

type ResolvePlaybookInput = {
  locale: PlaybookLocale;
  route?: string | null;
  module?: string | null;
  error_code?: string | null;
  error_message?: string | null;
};

type ManualEntry = {
  id: string;
  route: string;
  module: string;
  locale: PlaybookLocale;
  title: string;
  common_errors: {
    error_code: string;
    error_symptom: string;
    likely_cause: string;
    fix_steps: string[];
    related_route?: string;
  }[];
};

type ManualDataset = {
  entries: ManualEntry[];
};

type PlaybookCandidate = {
  playbook: SupportChatPlaybook;
  source: 'seeded' | 'manual';
};

@Injectable()
export class SupportChatPlaybookService {
  private manualCandidatesByCode: Map<string, PlaybookCandidate[]> | null = null;

  resolve(input: ResolvePlaybookInput) {
    const route = this.normalizeRoute(input.route);
    const module = this.normalizeModule(input.module);
    const normalizedCode = this.normalizeCode(
      input.error_code ?? this.extractCodeFromMessage(input.error_message),
    );
    if (!normalizedCode) {
      return null;
    }

    const candidates = this.getCandidatesForCode(normalizedCode);
    if (!candidates.length) {
      return null;
    }

    const ranked = candidates
      .map((candidate) => ({
        ...candidate,
        scoreDetails: this.score(candidate, route, module),
      }))
      .sort((a, b) => b.scoreDetails.total - a.scoreDetails.total);

    const selected = ranked[0];
    if (!selected) {
      return null;
    }

    const ambiguous = this.isAmbiguous(ranked);
    const confidence = this.deriveConfidence({
      source: selected.source,
      totalScore: selected.scoreDetails.total,
      routeMatched: selected.scoreDetails.routeMatched,
      moduleMatched: selected.scoreDetails.moduleMatched,
      ambiguous,
    });
    if (
      this.shouldSuppressForContextMismatch({
        route,
        module,
        selected,
      })
    ) {
      return null;
    }

    const locale = input.locale === 'sw' ? 'sw' : 'en';
    return {
      error_code: selected.playbook.error_code,
      title: selected.playbook.title[locale],
      diagnosis: selected.playbook.diagnosis[locale],
      likely_cause: selected.playbook.likely_cause[locale],
      steps: selected.playbook.steps[locale],
      related_routes: selected.playbook.related_routes,
      confidence: confidence.level,
      confidence_reason: confidence.reason,
      source: selected.source,
      matched_by: {
        code: normalizedCode,
        route,
        module,
      },
    };
  }

  private score(
    candidate: PlaybookCandidate,
    route: string | null,
    module: string | null,
  ) {
    const playbook = candidate.playbook;
    let total = 10;
    let routeMatched = false;
    let moduleMatched = false;

    if (candidate.source === 'seeded') {
      total += 20;
    }

    if (route && playbook.routes?.includes(route)) {
      total += 45;
      routeMatched = true;
    } else if (route && playbook.routes?.length) {
      total -= 10;
    } else if (!route) {
      total += 4;
    }

    if (module && playbook.modules?.includes(module)) {
      total += 25;
      moduleMatched = true;
    } else if (module && playbook.modules?.length) {
      total -= 8;
    } else if (!module) {
      total += 3;
    }

    total += this.scopeSpecificityBonus(playbook);

    return {
      total,
      routeMatched,
      moduleMatched,
      source: candidate.source,
    };
  }

  private deriveConfidence(input: {
    source: 'seeded' | 'manual';
    totalScore: number;
    routeMatched: boolean;
    moduleMatched: boolean;
    ambiguous: boolean;
  }) {
    if (input.ambiguous) {
      return {
        level: 'low' as const,
        reason: 'Multiple playbooks matched similarly; route/module context is not specific enough.',
      };
    }
    if (
      input.totalScore >= 80 &&
      (input.routeMatched || input.moduleMatched) &&
      input.source === 'seeded'
    ) {
      return {
        level: 'high' as const,
        reason: 'Exact deterministic playbook match with strong route/module context.',
      };
    }
    if (input.totalScore >= 60) {
      return {
        level: 'medium' as const,
        reason: 'Playbook matched, but context alignment is partial or based on manual-derived fallback.',
      };
    }
    return {
      level: 'low' as const,
      reason: 'Weak context match; provide support escalation if issue persists.',
    };
  }

  private isAmbiguous(
    ranked: Array<{
      scoreDetails: {
        total: number;
      };
    }>,
  ) {
    if (ranked.length < 2) {
      return false;
    }
    const first = ranked[0].scoreDetails.total;
    const second = ranked[1].scoreDetails.total;
    return Math.abs(first - second) <= 5;
  }

  private shouldSuppressForContextMismatch(input: {
    route: string | null;
    module: string | null;
    selected: {
      playbook: SupportChatPlaybook;
      scoreDetails: {
        routeMatched: boolean;
        moduleMatched: boolean;
      };
    };
  }) {
    const hasRouteScope = Boolean(input.selected.playbook.routes?.length);
    const hasModuleScope = Boolean(input.selected.playbook.modules?.length);
    const routeMismatch =
      Boolean(input.route) && hasRouteScope && !input.selected.scoreDetails.routeMatched;
    const moduleMismatch =
      Boolean(input.module) && hasModuleScope && !input.selected.scoreDetails.moduleMatched;
    return routeMismatch && moduleMismatch;
  }

  private scopeSpecificityBonus(playbook: SupportChatPlaybook) {
    let bonus = 0;
    if (playbook.routes?.length) {
      bonus += Math.max(1, 6 - playbook.routes.length);
    }
    if (playbook.modules?.length) {
      bonus += Math.max(1, 4 - playbook.modules.length);
    }
    return bonus;
  }

  private getCandidatesForCode(errorCode: string) {
    const seeded: PlaybookCandidate[] = SUPPORT_CHAT_PLAYBOOKS.filter(
      (item) => item.error_code === errorCode,
    ).map((playbook) => ({
      playbook,
      source: 'seeded' as const,
    }));

    const manual = this.getManualCandidates().get(errorCode) ?? [];

    if (!seeded.length) {
      return manual;
    }

    const seen = new Set(
      seeded.map((item) => this.candidateKey(item.playbook, item.source)),
    );
    for (const item of manual) {
      const key = this.candidateKey(item.playbook, item.source);
      if (!seen.has(key)) {
        seeded.push(item);
        seen.add(key);
      }
    }
    return seeded;
  }

  private candidateKey(
    playbook: SupportChatPlaybook,
    source: 'seeded' | 'manual',
  ) {
    const routeKey = (playbook.routes ?? []).join(',');
    const moduleKey = (playbook.modules ?? []).join(',');
    return `${source}|${playbook.error_code}|${routeKey}|${moduleKey}`;
  }

  private getManualCandidates() {
    if (this.manualCandidatesByCode) {
      return this.manualCandidatesByCode;
    }

    const enPath = this.resolveManualPath('frontend/docs/manual/manual.en.json');
    const swPath = this.resolveManualPath('frontend/docs/manual/manual.sw.json');
    if (!enPath || !swPath) {
      this.manualCandidatesByCode = new Map();
      return this.manualCandidatesByCode;
    }

    const enDataset = this.readManualDataset(enPath, 'en');
    const swDataset = this.readManualDataset(swPath, 'sw');
    const swByEntry = new Map(swDataset.entries.map((entry) => [entry.id, entry]));

    const map = new Map<string, PlaybookCandidate[]>();
    for (const enEntry of enDataset.entries) {
      const swEntry = swByEntry.get(enEntry.id);
      for (const enError of enEntry.common_errors ?? []) {
        const code = this.normalizeCode(enError.error_code);
        if (!code) {
          continue;
        }
        const swError =
          swEntry?.common_errors?.find((item) => item.error_code === enError.error_code) ??
          swEntry?.common_errors?.find(
            (item) => this.normalizeCode(item.error_code) === code,
          );
        const fallbackPlaybook = this.createManualFallbackPlaybook(
          enEntry,
          enError,
          swEntry ?? null,
          swError ?? null,
          code,
        );

        const current = map.get(code) ?? [];
        current.push({
          playbook: fallbackPlaybook,
          source: 'manual',
        });
        map.set(code, current);
      }
    }

    this.manualCandidatesByCode = map;
    return map;
  }

  private createManualFallbackPlaybook(
    enEntry: ManualEntry,
    enError: ManualEntry['common_errors'][number],
    swEntry: ManualEntry | null,
    swError: ManualEntry['common_errors'][number] | null,
    errorCode: string,
  ): SupportChatPlaybook {
    const swSteps = swError?.fix_steps?.length
      ? swError.fix_steps
      : ['Fuata hatua za kurekebisha kwenye mwongozo wa ukurasa huu.'];
    const enSteps = enError.fix_steps?.length
      ? enError.fix_steps
      : ['Follow the fix steps in this page guide.'];
    const relatedRoutes = [
      enEntry.route,
      enError.related_route,
      swError?.related_route,
      ...(swEntry ? [swEntry.route] : []),
    ].filter((value): value is string => Boolean(value));

    return {
      error_code: errorCode,
      modules: [enEntry.module],
      routes: [enEntry.route],
      title: {
        en: `${enEntry.title}: ${errorCode}`,
        sw: `${swEntry?.title ?? enEntry.title}: ${errorCode}`,
      },
      diagnosis: {
        en: enError.error_symptom,
        sw: swError?.error_symptom ?? enError.error_symptom,
      },
      likely_cause: {
        en: enError.likely_cause,
        sw: swError?.likely_cause ?? enError.likely_cause,
      },
      steps: {
        en: enSteps,
        sw: swSteps,
      },
      related_routes: [...new Set(relatedRoutes)],
      confidence: 'medium',
    };
  }

  private readManualDataset(pathname: string, locale: PlaybookLocale) {
    const parsed = JSON.parse(fs.readFileSync(pathname, 'utf8')) as ManualDataset;
    return {
      entries: (parsed.entries ?? []).map((entry) => ({
        ...entry,
        locale,
      })),
    };
  }

  private resolveManualPath(relativePath: string) {
    const current = process.cwd();
    const candidates = [
      path.resolve(current, relativePath),
      path.resolve(current, '..', relativePath),
      path.resolve(__dirname, '../../..', relativePath),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  private normalizeCode(code: string | null | undefined) {
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

  private extractCodeFromMessage(message: string | null | undefined) {
    if (!message) {
      return null;
    }
    const exactCode = message.match(/\b[A-Z][A-Z0-9_]{2,}\b/g)?.[0] ?? null;
    if (exactCode) {
      return this.normalizeCode(exactCode);
    }
    return null;
  }

  private normalizeModule(module: string | null | undefined) {
    if (!module) {
      return null;
    }
    return module.trim().toLowerCase();
  }

  private normalizeRoute(route: string | null | undefined) {
    if (!route) {
      return null;
    }
    return route
      .split('?')[0]
      .split('#')[0]
      .trim()
      .replace(/^\/(en|sw)(?=\/|$)/, '/{locale}');
  }
}
