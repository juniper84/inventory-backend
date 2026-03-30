import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import OpenAI from 'openai';
import { Pool } from 'pg';

type ManualLocale = 'en' | 'sw';

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
  // v2 fields
  overview?: string;
  before_you_start?: { text: string; link?: string }[];
  common_tasks?: { task: string; steps: string[] }[];
  warnings?: string[];
  elements?: { name: string; type: string; description: string; notes?: string }[];
  // v1 legacy fields
  purpose?: string;
  audience?: string[];
  prerequisites?: { check: string }[];
  workflow?: { step: string; expected_result?: string; if_blocked?: string }[];
  common_errors?: {
    error_code: string;
    error_symptom: string;
    likely_cause: string;
    fix_steps: string[];
    related_route?: string;
  }[];
  related_pages?: { id: string; route: string; reason: string; order: string }[];
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
  section: 'purpose' | 'prerequisites' | 'workflow' | 'warnings' | 'elements' | 'errors' | 'links';
  source: string;
  title: string;
  error_codes: string[];
  text: string;
};

const indexPath =
  process.env.SUPPORT_CHAT_MANUAL_INDEX_PATH ||
  'frontend/docs/manual/manual.freeze.m09.index.jsonl';
const sourceDir =
  process.env.SUPPORT_CHAT_MANUAL_SOURCE_DIR || 'frontend/docs/manual';
const embeddingModel =
  process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';

function resolveFilePath(relativeOrAbsolute: string) {
  if (path.isAbsolute(relativeOrAbsolute)) {
    return relativeOrAbsolute;
  }
  const local = path.resolve(process.cwd(), relativeOrAbsolute);
  if (fs.existsSync(local)) {
    return local;
  }
  return path.resolve(process.cwd(), '..', relativeOrAbsolute);
}

function buildChunksFromEntry(entry: ManualEntry, source: string): RetrievalChunk[] {
  const errorCodes = (entry.common_errors ?? []).map((item) => item.error_code);
  const base = {
    id: entry.id,
    route: entry.route,
    module: entry.module,
    locale: entry.locale,
    source,
    title: entry.title,
    error_codes: errorCodes,
  };

  const chunks: RetrievalChunk[] = [];

  // Purpose / Overview — prefer v2, fall back to v1
  const purposeText = entry.overview
    ? `${entry.title}. ${entry.overview}`
    : entry.purpose
      ? `${entry.title}. ${entry.purpose}${entry.audience?.length ? ` Audience: ${entry.audience.join(', ')}` : ''}`
      : `${entry.title}.`;
  chunks.push({
    ...base,
    chunk_id: `${entry.id}:${entry.locale}:purpose`,
    section: 'purpose',
    text: purposeText,
  });

  // Prerequisites / Before you start — prefer v2, fall back to v1
  const prereqItems = entry.before_you_start?.length
    ? entry.before_you_start.map((item) => item.text)
    : (entry.prerequisites ?? []).map((item) => item.check);
  if (prereqItems.length) {
    chunks.push({
      ...base,
      chunk_id: `${entry.id}:${entry.locale}:prerequisites`,
      section: 'prerequisites',
      text: prereqItems.join(' | '),
    });
  }

  // Workflow / Common tasks — prefer v2, fall back to v1
  const workflowItems = entry.common_tasks?.length
    ? entry.common_tasks.map((task) => `${task.task}: ${task.steps.join(' ')}`)
    : (entry.workflow ?? []).map((step) =>
        [step.step, step.expected_result ?? '', step.if_blocked ?? '']
          .filter(Boolean)
          .join(' '),
      );
  if (workflowItems.length) {
    chunks.push({
      ...base,
      chunk_id: `${entry.id}:${entry.locale}:workflow`,
      section: 'workflow',
      text: workflowItems.join(' | '),
    });
  }

  // Warnings (v2 only)
  if (entry.warnings?.length) {
    chunks.push({
      ...base,
      chunk_id: `${entry.id}:${entry.locale}:warnings`,
      section: 'warnings',
      text: entry.warnings.join(' | '),
    });
  }

  // Elements (v2 only)
  if (entry.elements?.length) {
    chunks.push({
      ...base,
      chunk_id: `${entry.id}:${entry.locale}:elements`,
      section: 'elements',
      text: entry.elements
        .map((el) => `${el.name} (${el.type}): ${el.description}${el.notes ? ` ${el.notes}` : ''}`)
        .join(' | '),
    });
  }

  // Errors (v1 legacy)
  const errors = entry.common_errors ?? [];
  if (errors.length) {
    chunks.push({
      ...base,
      chunk_id: `${entry.id}:${entry.locale}:errors`,
      section: 'errors',
      text: errors
        .map((error) =>
          [error.error_code, error.error_symptom, error.likely_cause, error.fix_steps.join(' ')]
            .filter(Boolean)
            .join(' '),
        )
        .join(' | '),
    });
  }

  // Related pages
  if ((entry.related_pages ?? []).length) {
    chunks.push({
      ...base,
      chunk_id: `${entry.id}:${entry.locale}:links`,
      section: 'links',
      text: (entry.related_pages ?? [])
        .map((item) => `${item.order} ${item.route} ${item.reason}`)
        .join(' | '),
    });
  }

  return chunks;
}

function toVectorLiteral(vector: number[]) {
  return `[${vector.map((n) => Number(n).toFixed(8)).join(',')}]`;
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  const databaseUrl = process.env.DATABASE_URL;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required.');
  }
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required.');
  }

  const resolvedIndexPath = resolveFilePath(indexPath);
  if (!fs.existsSync(resolvedIndexPath)) {
    throw new Error(`Manual index not found: ${resolvedIndexPath}`);
  }

  const indexRows = fs
    .readFileSync(resolvedIndexPath, 'utf8')
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
      const sourcePath = resolveFilePath(path.join(sourceDir, `manual.${locale}.json`));
      if (!fs.existsSync(sourcePath)) {
        throw new Error(`Manual source missing: ${sourcePath}`);
      }
      dataset = JSON.parse(fs.readFileSync(sourcePath, 'utf8')) as ManualDataset;
      datasetByLocale.set(locale, dataset);
    }

    const entry = dataset.entries.find((item) => item.id === row.id);
    if (!entry) {
      continue;
    }
    chunks.push(...buildChunksFromEntry(entry, row.source));
  }

  const openai = new OpenAI({ apiKey });
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const batchSize = 32;
    let upserted = 0;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const embeddingResponse = await openai.embeddings.create({
        model: embeddingModel,
        input: batch.map((item) => item.text),
      });

      for (let j = 0; j < batch.length; j += 1) {
        const chunk = batch[j];
        const vector = embeddingResponse.data[j]?.embedding;
        if (!vector?.length) {
          continue;
        }
        const sql = `
          INSERT INTO "SupportChatManualEmbedding" (
            "chunkId", "entryId", "route", "module", "locale", "section",
            "title", "source", "errorCodes", "content", "embedding", "updatedAt"
          ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11::vector, NOW()
          )
          ON CONFLICT ("chunkId")
          DO UPDATE SET
            "entryId" = EXCLUDED."entryId",
            "route" = EXCLUDED."route",
            "module" = EXCLUDED."module",
            "locale" = EXCLUDED."locale",
            "section" = EXCLUDED."section",
            "title" = EXCLUDED."title",
            "source" = EXCLUDED."source",
            "errorCodes" = EXCLUDED."errorCodes",
            "content" = EXCLUDED."content",
            "embedding" = EXCLUDED."embedding",
            "updatedAt" = NOW()
        `;
        await pool.query(sql, [
          chunk.chunk_id,
          chunk.id,
          chunk.route,
          chunk.module,
          chunk.locale,
          chunk.section,
          chunk.title,
          chunk.source,
          chunk.error_codes,
          chunk.text,
          toVectorLiteral(vector),
        ]);
        upserted += 1;
      }

      console.log(
        `[support-chat:index] processed ${Math.min(i + batchSize, chunks.length)}/${chunks.length}`,
      );
    }

    console.log(
      `[support-chat:index] completed. chunks=${chunks.length} upserted=${upserted}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[support-chat:index] failed', error);
  process.exit(1);
});

