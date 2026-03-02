import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { SupportChatPlaybookService } from './support-chat-playbook.service';
import { SupportChatContextService } from './support-chat-context.service';
import { SupportChatComposerService } from './support-chat-composer.service';
import { SupportChatReasonerService } from './support-chat-reasoner.service';

type ManualLocale = 'en' | 'sw';
type ChatIntent = 'explain_page' | 'troubleshoot_error' | 'how_to' | 'what_next';
type ResponseDepth = 'simple' | 'standard' | 'detailed';

type RetrievalInput = {
  question: string;
  locale: ManualLocale;
  route?: string;
  module?: string;
  intent?: ChatIntent;
  error_code?: string;
  error_message?: string;
  error_route?: string;
  topK: number;
};

type JwtUser = {
  sub: string;
  email: string;
  businessId: string;
  roleIds: string[];
  permissions: string[];
  branchScope: string[];
  scope?: 'platform' | 'business' | 'support';
};

type ChatInput = {
  user: JwtUser;
  question: string;
  locale?: ManualLocale;
  intent?: ChatIntent;
  response_depth?: ResponseDepth;
  route?: string;
  module?: string;
  branchId?: string;
  topK?: number;
  selected_error_id?: string | null;
  recent_errors?: Array<{
    id?: string | null;
    error_code?: string | null;
    error_message?: string | null;
    error_source?: 'backend' | 'frontend' | 'network' | 'unknown' | string;
    error_time?: string | null;
    error_route?: string | null;
    business_id?: string | null;
    branch_id?: string | null;
  }>;
  latest_error?: {
    id?: string | null;
    error_code?: string | null;
    error_message?: string | null;
    error_source?: 'backend' | 'frontend' | 'network' | 'unknown' | string;
    error_time?: string | null;
    error_route?: string | null;
    business_id?: string | null;
    branch_id?: string | null;
  };
};

type LatestErrorPayload = {
  id?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  error_source?: 'backend' | 'frontend' | 'network' | 'unknown' | string;
  error_time?: string | null;
  error_route?: string | null;
  business_id?: string | null;
  branch_id?: string | null;
};

type IndexRecord = {
  id: string;
  route: string;
  module: string;
  locale: ManualLocale;
  title: string;
  source: string;
  error_codes: string[];
};

type ManualEntry = {
  id: string;
  route: string;
  module: string;
  locale: ManualLocale;
  title: string;
  purpose: string;
  audience: string[];
  prerequisites: { check: string }[];
  workflow: { step: string; expected_result?: string; if_blocked?: string }[];
  common_errors: {
    error_code: string;
    error_symptom: string;
    likely_cause: string;
    fix_steps: string[];
    related_route?: string;
  }[];
  related_pages: { id: string; route: string; reason: string; order: string }[];
};

type ManualDataset = {
  entries: ManualEntry[];
};

type RetrievalChunk = {
  chunk_id: string;
  id: string;
  route: string;
  module: string;
  locale: ManualLocale;
  section: 'purpose' | 'prerequisites' | 'workflow' | 'errors' | 'links';
  source: string;
  title: string;
  error_codes: string[];
  text: string;
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

type VectorMatch = {
  chunk_id: string;
  entry_id: string;
  route: string;
  module: string;
  locale: string;
  section: string;
  title: string;
  source: string;
  error_codes: string[] | null;
  content: string;
  distance: number;
};

const SUPPORT_CHAT_ERROR_MAX_AGE_MS = 5 * 60 * 1000;

type ErrorContextResolution = {
  error: LatestErrorPayload | null;
  status:
    | 'attached_selected'
    | 'attached_fallback_queue_single'
    | 'attached_fallback_latest_error'
    | 'none_explicit_without_error'
    | 'none_selected_not_found'
    | 'none_selected_not_relevant'
    | 'none_explain_intent'
    | 'none_ambiguous_queue'
    | 'none_no_error_context'
    | 'none_latest_error_not_relevant';
  reason: string;
};

@Injectable()
export class SupportChatService {
  constructor(
    private readonly config: ConfigService,
    private readonly playbookService: SupportChatPlaybookService,
    private readonly supportChatContextService: SupportChatContextService,
    private readonly supportChatComposerService: SupportChatComposerService,
    private readonly supportChatReasonerService: SupportChatReasonerService,
  ) {}

  private pool: Pool | null = null;
  private openai: OpenAI | null = null;
  private cache:
    | {
        chunks: RetrievalChunk[];
      }
    | null = null;

  async chat(input: ChatInput) {
    if (!this.config.get<boolean>('supportChat.enabled')) {
      throw new NotFoundException('Support chat is disabled.');
    }

    const locale: ManualLocale = input.locale === 'sw' ? 'sw' : 'en';
    const topK = Number.isFinite(Number(input.topK))
      ? Math.min(Math.max(Number(input.topK), 1), 20)
      : 6;
    const question = input.question?.trim() ?? '';
    const intent = this.resolveIntent(input.intent, question);
    const responseDepth = this.resolveDepth(input.response_depth, question);
    const errorContextResolution = this.resolveLatestErrorContext(input, intent);
    const resolvedLatestError = errorContextResolution.error;

    const context = await this.supportChatContextService.buildContext(input.user, {
      route: input.route,
      locale,
      branchId: input.branchId,
      latest_error: resolvedLatestError ?? undefined,
      selected_error_id: input.selected_error_id ?? null,
    });

    const retrieval = await this.retrieve({
      question,
      locale,
      route: context.route,
      module: input.module ?? context.module,
      intent,
      error_code: resolvedLatestError?.error_code ?? undefined,
      error_message: resolvedLatestError?.error_message ?? undefined,
      error_route: resolvedLatestError?.error_route ?? undefined,
      topK,
    });

    const escalationContact =
      this.config.get<string>('supportChat.escalationContact') ??
      process.env.SUPPORT_CHAT_ESCALATION_CONTACT ??
      'support@newvisioninventory.com';
    const retrievalMode =
      retrieval.retrieval_mode === 'vector' ||
      retrieval.retrieval_mode === 'keyword' ||
      retrieval.retrieval_mode === 'none'
        ? retrieval.retrieval_mode
        : 'none';

    const response = this.supportChatComposerService.compose({
      question,
      locale,
      intent,
      responseDepth,
      context,
      retrieval: {
        retrieval_mode: retrievalMode,
        result_count: retrieval.result_count ?? retrieval.results.length,
        results: retrieval.results,
        deterministic_playbook: retrieval.deterministic_playbook ?? null,
      },
      reasoning: this.supportChatReasonerService.analyze({
        locale,
        intent,
        question,
        context,
        retrieval: {
          deterministic_playbook: retrieval.deterministic_playbook ?? null,
          results: retrieval.results,
        },
      }),
      escalationContact,
    });

    return {
      ...response,
      meta: {
        ...(response.meta ?? {}),
        error_context_status: errorContextResolution.status,
        error_context_reason: errorContextResolution.reason,
      },
      context: {
        route: context.route,
        module: context.module,
        locale: context.locale,
      },
      generated_at: new Date().toISOString(),
    };
  }

  private normalizeLatestError(
    value: LatestErrorPayload | null | undefined,
  ): LatestErrorPayload | null {
    if (!value) {
      return null;
    }
    const errorCode = value.error_code?.trim() ?? '';
    const errorMessage = value.error_message?.trim() ?? '';
    const errorRoute = value.error_route?.trim() ?? '';
    const errorTime = value.error_time?.trim() ?? '';
    const errorId = value.id?.trim() ?? '';

    if (!errorCode && !errorMessage && !errorRoute) {
      return null;
    }

    return {
      id: errorId || null,
      error_code: errorCode || null,
      error_message: errorMessage || null,
      error_source: value.error_source ?? 'unknown',
      error_time: errorTime || null,
      error_route: errorRoute || null,
      business_id: value.business_id ?? null,
      branch_id: value.branch_id ?? null,
    };
  }

  private resolveLatestErrorContext(
    input: ChatInput,
    intent: ChatIntent,
  ): ErrorContextResolution {
    const normalizedRoute = this.normalizeRoutePattern(input.route);
    const activeBranchId = this.resolveActiveBranchId(
      input.branchId,
      input.user.branchScope ?? [],
    );
    const relevanceInput = {
      route: normalizedRoute,
      businessId: input.user.businessId,
      activeBranchId,
      nowMs: Date.now(),
      maxAgeMs: SUPPORT_CHAT_ERROR_MAX_AGE_MS,
    };
    const selectedErrorId =
      typeof input.selected_error_id === 'string'
        ? input.selected_error_id.trim()
        : input.selected_error_id;

    if (selectedErrorId === null) {
      return {
        error: null,
        status: 'none_explicit_without_error',
        reason: 'User explicitly asked without attaching an error.',
      };
    }

    const queueAll = (input.recent_errors ?? [])
      .map((item) => this.normalizeLatestError(item))
      .filter((item): item is LatestErrorPayload => Boolean(item));
    const queue = queueAll.filter((item) => this.isErrorRelevant(item, relevanceInput));

    if (typeof selectedErrorId === 'string' && selectedErrorId.length > 0) {
      const selectedAny = queueAll.find(
        (item) =>
          typeof item.id === 'string' &&
          item.id.trim().length > 0 &&
          item.id.trim() === selectedErrorId,
      );
      if (!selectedAny) {
        return {
          error: null,
          status: 'none_selected_not_found',
          reason: 'Selected error id was not found in provided recent errors.',
        };
      }
      if (!this.isErrorRelevant(selectedAny, relevanceInput)) {
        return {
          error: null,
          status: 'none_selected_not_relevant',
          reason: 'Selected error did not pass relevance checks.',
        };
      }
      return {
        error: selectedAny,
        status: 'attached_selected',
        reason: 'Selected error attached successfully.',
      };
    }

    if (intent === 'explain_page') {
      return {
        error: null,
        status: 'none_explain_intent',
        reason: 'Explain-page intent does not auto-attach error context.',
      };
    }

    if (queue.length > 1) {
      return {
        error: null,
        status: 'none_ambiguous_queue',
        reason: 'Multiple relevant recent errors require explicit user selection.',
      };
    }
    if (queue.length === 1) {
      return {
        error: queue[0],
        status: 'attached_fallback_queue_single',
        reason: 'Exactly one relevant recent error was available and attached.',
      };
    }

    const fallback = this.normalizeLatestError(input.latest_error);
    if (!fallback) {
      return {
        error: null,
        status: 'none_no_error_context',
        reason: 'No valid error context was provided.',
      };
    }
    if (!this.isErrorRelevant(fallback, relevanceInput)) {
      return {
        error: null,
        status: 'none_latest_error_not_relevant',
        reason: 'Fallback latest_error did not pass relevance checks.',
      };
    }
    return {
      error: fallback,
      status: 'attached_fallback_latest_error',
      reason: 'Fallback latest_error attached after relevance checks.',
    };
  }

  private normalizeRoutePattern(route?: string | null): string | null {
    if (!route) {
      return null;
    }
    const clean = route.split('?')[0].split('#')[0].trim();
    if (!clean) {
      return null;
    }
    return clean.replace(/^\/(en|sw)(?=\/|$)/, '/{locale}') || '/{locale}';
  }

  private resolveActiveBranchId(
    inputBranchId: string | undefined,
    branchScope: string[],
  ): string | null {
    if (inputBranchId && branchScope.includes(inputBranchId)) {
      return inputBranchId;
    }
    if (branchScope.length === 1) {
      return branchScope[0];
    }
    return null;
  }

  private isErrorRelevant(
    error: LatestErrorPayload | null,
    input: {
      route: string | null;
      businessId: string;
      activeBranchId: string | null;
      nowMs: number;
      maxAgeMs: number;
    },
  ): boolean {
    if (!error) {
      return false;
    }

    const errorTimeMs = error.error_time ? Date.parse(error.error_time) : Number.NaN;
    if (!Number.isFinite(errorTimeMs)) {
      return false;
    }
    if (input.nowMs - errorTimeMs > input.maxAgeMs) {
      return false;
    }

    const errorRoute = this.normalizeRoutePattern(error.error_route ?? null);
    if (errorRoute && input.route && errorRoute !== input.route) {
      return false;
    }

    if (error.business_id && error.business_id !== input.businessId) {
      return false;
    }

    // Keep branch relevance behavior aligned with frontend:
    // only enforce mismatch when both branch ids are present.
    if (error.branch_id && input.activeBranchId && error.branch_id !== input.activeBranchId) {
      return false;
    }

    return true;
  }

  async retrieve(input: RetrievalInput) {
    if (!this.config.get<boolean>('supportChat.enabled')) {
      throw new NotFoundException('Support chat is disabled.');
    }

    const question = input.question.trim();
    const route = input.route?.trim() || null;
    const module = input.module?.trim() || null;
    const intent = this.resolveIntent(input.intent, question);
    const shouldUsePlaybook = this.shouldUseDeterministicPlaybook({
      intent,
      route,
      errorRoute: input.error_route ?? null,
    });
    if (!question) {
      const deterministicPlaybook = shouldUsePlaybook
        ? this.playbookService.resolve({
            locale: input.locale,
            route,
            module,
            error_code: input.error_code ?? null,
            error_message: input.error_message ?? null,
          })
        : null;
      return {
        ok: true,
        query: input.question,
        locale: input.locale,
        route,
        module,
        deterministic_playbook: deterministicPlaybook,
        retrieval_mode: 'none',
        results: [] as RetrievalResult[],
      };
    }

    const vectorResults = await this.retrieveByVector(
      question,
      input.locale,
      route,
      input.topK,
    );
    const filteredVectorResults = this.filterResultsForTroubleshootingIntent({
      results: vectorResults,
      intent,
      errorCode: input.error_code ?? null,
      errorMessage: input.error_message ?? null,
    });
    const intentVectorResults = this.filterResultsForIntent({
      results: filteredVectorResults,
      intent,
      topK: input.topK,
    });
    if (intentVectorResults.length) {
      const deterministicPlaybook = shouldUsePlaybook
        ? this.playbookService.resolve({
            locale: input.locale,
            route,
            module,
            error_code: input.error_code ?? null,
            error_message: input.error_message ?? null,
          })
        : null;
      return {
        ok: true,
        query: input.question,
        locale: input.locale,
        route,
        module,
        deterministic_playbook: deterministicPlaybook,
        retrieval_mode: 'vector',
        result_count: intentVectorResults.length,
        results: intentVectorResults,
      };
    }

    const keywordResults = this.retrieveByKeyword(
      question,
      input.locale,
      route,
      input.topK,
    );
    const filteredKeywordResults = this.filterResultsForTroubleshootingIntent({
      results: keywordResults,
      intent,
      errorCode: input.error_code ?? null,
      errorMessage: input.error_message ?? null,
    });
    const intentKeywordResults = this.filterResultsForIntent({
      results: filteredKeywordResults,
      intent,
      topK: input.topK,
    });
    const deterministicPlaybook = shouldUsePlaybook
      ? this.playbookService.resolve({
          locale: input.locale,
          route,
          module,
          error_code: input.error_code ?? null,
          error_message: input.error_message ?? null,
        })
      : null;

    return {
      ok: true,
      query: input.question,
      locale: input.locale,
      route,
      module,
      deterministic_playbook: deterministicPlaybook,
      retrieval_mode: 'keyword',
      result_count: intentKeywordResults.length,
      results: intentKeywordResults,
    };
  }

  private filterResultsForIntent(input: {
    results: RetrievalResult[];
    intent: ChatIntent;
    topK: number;
  }) {
    if (input.intent !== 'explain_page') {
      return input.results;
    }
    const explainPreferred = input.results.filter(
      (item) => item.section === 'purpose' || item.section === 'workflow',
    );
    if (explainPreferred.length) {
      return explainPreferred.slice(0, input.topK);
    }
    const withoutLinks = input.results.filter((item) => item.section !== 'links');
    if (withoutLinks.length) {
      return withoutLinks.slice(0, input.topK);
    }
    return input.results.slice(0, input.topK);
  }

  private filterResultsForTroubleshootingIntent(input: {
    results: RetrievalResult[];
    intent: ChatIntent;
    errorCode: string | null;
    errorMessage: string | null;
  }): RetrievalResult[] {
    if (input.intent !== 'troubleshoot_error') {
      return input.results;
    }
    const normalizedErrorCode =
      this.normalizeErrorCode(
        input.errorCode ??
          this.extractErrorCodeFromMessage(input.errorMessage ?? null) ??
          null,
      ) ?? null;
    if (!normalizedErrorCode) {
      return input.results;
    }

    const matches = input.results.filter((item) =>
      item.error_codes.some((code) =>
        this.errorCodeMatches(normalizedErrorCode, code),
      ),
    );
    if (!matches.length) {
      // Keep manual evidence available for semantic/manual-first reasoning even when
      // no exact error-code family match exists.
      return input.results;
    }
    const matchedIds = new Set(matches.map((item) => item.chunk_id));
    const remaining = input.results.filter((item) => !matchedIds.has(item.chunk_id));
    return [...matches, ...remaining];
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
    const exactCode = message.match(/\b[A-Z][A-Z0-9_]{2,}\b/g)?.[0] ?? null;
    if (!exactCode) {
      return null;
    }
    return this.normalizeErrorCode(exactCode);
  }

  private retrieveByKeyword(
    question: string,
    locale: ManualLocale,
    route: string | null,
    topK: number,
  ) {
    const chunks = this.loadChunks();
    const queryTokens = this.tokenize(question);

    return chunks
      .filter((chunk) => chunk.locale === locale)
      .map((chunk) => ({ chunk, score: this.scoreChunk(chunk, queryTokens, route) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((item) => ({
        score: Number(item.score.toFixed(4)),
        chunk_id: item.chunk.chunk_id,
        id: item.chunk.id,
        route: item.chunk.route,
        module: item.chunk.module,
        locale: item.chunk.locale,
        section: item.chunk.section,
        title: item.chunk.title,
        source: item.chunk.source,
        error_codes: item.chunk.error_codes,
        text: item.chunk.text,
      }));
  }

  private async retrieveByVector(
    question: string,
    locale: ManualLocale,
    route: string | null,
    topK: number,
  ) {
    if (!this.config.get<boolean>('supportChat.vectorEnabled')) {
      return [];
    }
    const openai = this.getOpenAiClient();
    const pool = this.getPgPool();
    if (!openai || !pool) {
      return [];
    }

    try {
      const embeddingModel =
        this.config.get<string>('supportChat.embeddingModel') ??
        process.env.OPENAI_EMBEDDING_MODEL ??
        'text-embedding-3-small';

      const embedding = await openai.embeddings.create({
        model: embeddingModel,
        input: question,
      });
      const vector = embedding.data?.[0]?.embedding;
      if (!vector?.length) {
        return [];
      }

      const vectorLiteral = this.toVectorLiteral(vector);
      const normalizedRoute = route ? this.normalizeRoute(route) : null;
      const vectorTopK = this.config.get<number>('supportChat.vectorTopK') ?? 20;
      const rawLimit = Math.max(topK, vectorTopK);

      const sql = `
        SELECT
          "chunkId" AS chunk_id,
          "entryId" AS entry_id,
          "route",
          "module",
          "locale",
          "section",
          "title",
          "source",
          "errorCodes" AS error_codes,
          "content",
          ("embedding" <=> $1::vector) AS distance
        FROM "SupportChatManualEmbedding"
        WHERE "locale" = $2
          AND ($3::text IS NULL OR "route" = $3)
        ORDER BY "embedding" <=> $1::vector
        LIMIT $4
      `;
      const response = await pool.query<VectorMatch>(sql, [
        vectorLiteral,
        locale,
        normalizedRoute,
        rawLimit,
      ]);

      const minScore = this.config.get<number>('supportChat.vectorMinScore') ?? 0.05;
      return response.rows
        .map((row) => {
          const semantic = 1 - Number(row.distance ?? 1);
          const routeBonus =
            normalizedRoute && row.route === normalizedRoute ? 0.15 : 0;
          const score = semantic + routeBonus;
          return {
            score,
            chunk_id: row.chunk_id,
            id: row.entry_id,
            route: row.route,
            module: row.module,
            locale: row.locale as ManualLocale,
            section: row.section,
            title: row.title,
            source: row.source,
            error_codes: row.error_codes ?? [],
            text: row.content,
          };
        })
        .filter((item) => item.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .map((item) => ({
          ...item,
          score: Number(item.score.toFixed(4)),
        }));
    } catch {
      return [];
    }
  }

  private loadChunks() {
    if (this.cache) {
      return this.cache.chunks;
    }

    const indexPath = this.resolveFilePath(
      this.config.get<string>('supportChat.manualIndexPath') ??
        'frontend/docs/manual/manual.freeze.m09.index.jsonl',
    );
    if (!indexPath || !fs.existsSync(indexPath)) {
      throw new ServiceUnavailableException(
        'Manual retrieval index is not available.',
      );
    }

    const indexRows = fs
      .readFileSync(indexPath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as IndexRecord);

    const datasetByLocale = new Map<ManualLocale, ManualDataset>();
    const chunks: RetrievalChunk[] = [];

    for (const row of indexRows) {
      const locale = row.locale === 'sw' ? 'sw' : 'en';
      let dataset = datasetByLocale.get(locale);
      if (!dataset) {
        const sourcePath = this.resolveFilePath(
          this.config.get<string>('supportChat.manualSourceDir')
            ? path.join(
                this.config.get<string>('supportChat.manualSourceDir')!,
                `manual.${locale}.json`,
              )
            : `frontend/docs/manual/manual.${locale}.json`,
        );
        if (!sourcePath || !fs.existsSync(sourcePath)) {
          throw new ServiceUnavailableException(
            `Manual source file is missing for locale ${locale}.`,
          );
        }
        dataset = JSON.parse(fs.readFileSync(sourcePath, 'utf8')) as ManualDataset;
        datasetByLocale.set(locale, dataset);
      }

      const entry = dataset.entries.find((item) => item.id === row.id);
      if (!entry) {
        continue;
      }
      chunks.push(...this.buildChunksFromEntry(entry, row.source));
    }

    this.cache = { chunks };
    return chunks;
  }

  private buildChunksFromEntry(entry: ManualEntry, source: string): RetrievalChunk[] {
    const base = {
      id: entry.id,
      route: entry.route,
      module: entry.module,
      locale: entry.locale,
      source,
      title: entry.title,
      error_codes: entry.common_errors.map((item) => item.error_code),
    };

    const chunks: RetrievalChunk[] = [
      {
        ...base,
        chunk_id: `${entry.id}:${entry.locale}:purpose`,
        section: 'purpose',
        text: `${entry.title}. ${entry.purpose} Audience: ${entry.audience.join(', ')}`,
      },
    ];

    if (entry.prerequisites.length) {
      chunks.push({
        ...base,
        chunk_id: `${entry.id}:${entry.locale}:prerequisites`,
        section: 'prerequisites',
        text: entry.prerequisites.map((item) => item.check).join(' | '),
      });
    }

    if (entry.workflow.length) {
      chunks.push({
        ...base,
        chunk_id: `${entry.id}:${entry.locale}:workflow`,
        section: 'workflow',
        text: entry.workflow
          .map((step) =>
            [step.step, step.expected_result ?? '', step.if_blocked ?? '']
              .filter(Boolean)
              .join(' '),
          )
          .join(' | '),
      });
    }

    if (entry.common_errors.length) {
      chunks.push({
        ...base,
        chunk_id: `${entry.id}:${entry.locale}:errors`,
        section: 'errors',
        text: entry.common_errors
          .map((error) =>
            [
              error.error_code,
              error.error_symptom,
              error.likely_cause,
              error.fix_steps.join(' '),
            ]
              .filter(Boolean)
              .join(' '),
          )
          .join(' | '),
      });
    }

    if (entry.related_pages.length) {
      chunks.push({
        ...base,
        chunk_id: `${entry.id}:${entry.locale}:links`,
        section: 'links',
        text: entry.related_pages
          .map((item) => `${item.order} ${item.route} ${item.reason}`)
          .join(' | '),
      });
    }

    return chunks;
  }

  private scoreChunk(
    chunk: RetrievalChunk,
    queryTokens: string[],
    route: string | null,
  ) {
    if (!queryTokens.length) {
      return 0;
    }
    const text = chunk.text.toLowerCase();
    let score = 0;
    for (const token of queryTokens) {
      if (text.includes(token)) {
        score += 1;
      }
      if (chunk.error_codes.some((code) => code.toLowerCase().includes(token))) {
        score += 1.2;
      }
      if (chunk.title.toLowerCase().includes(token)) {
        score += 0.6;
      }
    }

    if (route) {
      if (this.normalizeRoute(route) === this.normalizeRoute(chunk.route)) {
        score += 2;
      }
    }
    if (chunk.section === 'errors') {
      score += 0.4;
    }
    return score;
  }

  private tokenize(text: string) {
    return Array.from(
      new Set(
        text
          .toLowerCase()
          .split(/[^a-z0-9_./-]+/i)
          .map((token) => token.trim())
          .filter((token) => token.length >= 2),
      ),
    );
  }

  private normalizeRoute(route: string) {
    const clean = route.split('?')[0].split('#')[0];
    return clean.replace(/^\/(en|sw)/, '/{locale}');
  }

  private resolveIntent(
    intent: RetrievalInput['intent'],
    question: string,
  ): ChatIntent {
    if (
      intent === 'explain_page' ||
      intent === 'troubleshoot_error' ||
      intent === 'how_to' ||
      intent === 'what_next'
    ) {
      return intent;
    }
    const text = question.toLowerCase();
    if (
      /(error|failed|failure|not working|can't|cannot|kosa|imeshindwa|haifanyi|tatizo|problem|issue)/i.test(
        text,
      )
    ) {
      return 'troubleshoot_error';
    }
    if (
      /(what\s+is\s+this\s+page|about\s+this\s+page|explain\s+this\s+page|page\s+about|ukurasa\s+huu)/i.test(
        text,
      )
    ) {
      return 'explain_page';
    }
    if (
      /(what\s+next|next\s+step|where\s+next|nifanye\s+nini\s+baada|hatua\s+inayofuata|baada\s+ya\s+hapa)/i.test(
        text,
      )
    ) {
      return 'what_next';
    }
    return 'how_to';
  }

  private resolveDepth(
    depth: ChatInput['response_depth'],
    question: string,
  ): ResponseDepth {
    if (depth === 'simple' || depth === 'standard' || depth === 'detailed') {
      return depth;
    }
    const text = question.toLowerCase();
    if (/(explain more|more detail|give details|fafanua zaidi|maelezo zaidi)/i.test(text)) {
      return 'detailed';
    }
    return 'simple';
  }

  private shouldUseDeterministicPlaybook(input: {
    intent: ChatIntent;
    route: string | null;
    errorRoute: string | null;
  }) {
    if (input.intent === 'explain_page' || input.intent === 'what_next') {
      return false;
    }
    if (!input.errorRoute) {
      return true;
    }
    const normalizedErrorRoute = this.normalizeRoute(input.errorRoute);
    if (input.route && normalizedErrorRoute !== input.route) {
      return false;
    }
    return true;
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

  private toVectorLiteral(vector: number[]) {
    return `[${vector.map((n) => Number(n).toFixed(8)).join(',')}]`;
  }

  private getOpenAiClient() {
    if (this.openai) {
      return this.openai;
    }
    const apiKey =
      this.config.get<string>('openai.apiKey') || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return null;
    }
    this.openai = new OpenAI({ apiKey });
    return this.openai;
  }

  private getPgPool() {
    if (this.pool) {
      return this.pool;
    }
    const connectionString =
      this.config.get<string>('database.url') || process.env.DATABASE_URL;
    if (!connectionString) {
      return null;
    }
    this.pool = new Pool({ connectionString });
    return this.pool;
  }
}
