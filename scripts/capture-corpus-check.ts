import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { bundleFromMessages, type StreamMessage } from '../src/agent/capture';

function transcriptsDir(): string {
  const sandboxDir = join(os.tmpdir(), 'yvoke-eval-sandbox');
  const candidates = new Set([sandboxDir]);
  try {
    candidates.add(realpathSync(sandboxDir));
  } catch {
    // Sandbox not present
  }
  const tried: string[] = [];
  for (const dir of candidates) {
    const slug = dir.replace(/[^a-zA-Z0-9]/g, '-');
    const full = join(os.homedir(), '.claude', 'projects', slug);
    tried.push(full);
    if (existsSync(full)) return full;
  }
  throw new Error(`No Claude Code transcripts found. Tried:\n${tried.map((t) => `  ${t}`).join('\n')}`);
}

const REF_ID_COVERAGE = 1.0;
const REF_LENGTH_RATIO = 0.5;
const REF_LONG = 200;
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

function refUuids(text: string): Set<string> {
  UUID_RE.lastIndex = 0;
  const set = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = UUID_RE.exec(text)) !== null) set.add(m[0].toLowerCase());
  return set;
}

function refWord5Grams(text: string): Set<string> {
  const words = text.toLowerCase().match(/\w+/g) || [];
  const grams = new Set<string>();
  for (let i = 0; i <= words.length - 5; i++) {
    grams.add(words.slice(i, i + 5).join(' '));
  }
  return grams;
}

function refRestated(earlier: string, later: string): boolean {
  if (earlier.length < REF_LONG || later.length < REF_LONG) return false;
  if (later.length < REF_LENGTH_RATIO * earlier.length) return false;
  const eIds = refUuids(earlier);
  if (eIds.size > 0) {
    const lIds = refUuids(later);
    let match = 0;
    for (const id of eIds) {
      if (lIds.has(id)) match++;
    }
    return match / eIds.size >= REF_ID_COVERAGE;
  }
  const eGrams = refWord5Grams(earlier);
  if (eGrams.size === 0) return false;
  const lGrams = refWord5Grams(later);
  let match = 0;
  for (const g of eGrams) {
    if (lGrams.has(g)) match++;
  }
  return match / eGrams.size >= 0.5;
}

interface RefResult {
  answer: string;
  duplicatesRemoved: number;
  allRawAssistantTexts: string[];
  droppedEarlierTexts: string[];
}

function refBundleFromMessages(messages: StreamMessage[]): RefResult {
  const textParts: string[] = [];
  const droppedEarlierTexts: string[] = [];
  const allRawAssistantTexts: string[] = [];
  let resultText: string | undefined;
  let hasSeenResult = false;
  let duplicatesRemoved = 0;

  for (const msg of messages) {
    const isSubAgent = msg.parent_tool_use_id != null;
    const content = Array.isArray(msg.message?.content) ? msg.message!.content : [];

    if (msg.type === 'assistant') {
      if (!isSubAgent && hasSeenResult) {
        textParts.length = 0;
        resultText = undefined;
        hasSeenResult = false;
      }
      if (!isSubAgent) {
        for (const b of content) {
          if (b && typeof b === 'object' && (b as { type?: string }).type === 'text') {
            const t = (b as { text?: string }).text;
            if (typeof t === 'string' && t) {
              allRawAssistantTexts.push(t);
              for (let i = textParts.length - 1; i >= 0; i--) {
                if (refRestated(textParts[i], t)) {
                  droppedEarlierTexts.push(textParts[i]);
                  textParts.splice(i, 1);
                  duplicatesRemoved++;
                }
              }
              textParts.push(t);
            }
          }
        }
      }
    } else if (msg.type === 'result') {
      hasSeenResult = true;
      if (typeof msg.result === 'string') resultText = msg.result;
    }
  }

  const answer = (textParts.join('\n\n').trim() || resultText || '').trim();
  return { answer, duplicatesRemoved, allRawAssistantTexts, droppedEarlierTexts };
}

export function runCorpusCheck(): {
  sessionsChecked: number;
  removableDuplicatesAt80Percent: number;
  duplicatesRemoved: number;
  citedIdsLost: number;
  violations: string[];
  emptied: number;
} {
  const dir = transcriptsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));

  let sessionsChecked = 0;
  let removableDuplicatesAt80Percent = 0;
  let totalDuplicatesRemoved = 0;
  let citedIdsLost = 0;
  let emptied = 0;
  const violations: string[] = [];

  for (const file of files) {
    const fullPath = join(dir, file);
    let lines: any[];
    try {
      lines = readFileSync(fullPath, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
    } catch {
      continue;
    }

    const firstUser = lines.find((o) => o.type === 'user' && typeof o.message?.content === 'string');
    if (!firstUser) continue;
    const userContent = firstUser.message.content as string;
    if (userContent.startsWith('## Question under test')) continue; // judge transcript

    const messages: StreamMessage[] = lines
      .filter((o) => o.type === 'assistant' || o.type === 'user' || o.type === 'result')
      .map((o) => ({
        type: o.type,
        subtype: o.subtype,
        message: o.message,
        result: o.result,
        parent_tool_use_id: null,
      }));

    if (!messages.some((m) => m.type === 'assistant' && Array.isArray(m.message?.content))) continue;

    sessionsChecked++;

    const ref = refBundleFromMessages(messages);
    const candidate = bundleFromMessages(messages);

    // Track removable pairs at 80% coverage
    const rawTexts = ref.allRawAssistantTexts;
    for (let i = 0; i < rawTexts.length - 1; i++) {
      const e = rawTexts[i];
      const l = rawTexts[i + 1];
      if (e.length >= 200 && l.length >= 200 && l.length >= 0.5 * e.length) {
        const eIds = refUuids(e);
        if (eIds.size > 0) {
          const lIds = refUuids(l);
          let match = 0;
          for (const id of eIds) if (lIds.has(id)) match++;
          if (match / eIds.size >= 0.8) removableDuplicatesAt80Percent++;
        } else {
          const eg = refWord5Grams(e);
          if (eg.size > 0) {
            const lg = refWord5Grams(l);
            let match = 0;
            for (const g of eg) if (lg.has(g)) match++;
            if (match / eg.size >= 0.5) removableDuplicatesAt80Percent++;
          }
        }
      }
    }

    totalDuplicatesRemoved += ref.duplicatesRemoved;

    // Check 1: Candidate answer matches reference answer byte-for-byte
    if (candidate.answer !== ref.answer) {
      violations.push(`Mismatch in ${file}: candidate length=${candidate.answer.length}, ref length=${ref.answer.length}`);
    }

    // Check 2: Emptied answers
    if (rawTexts.length > 0 && candidate.answer.length === 0) {
      emptied++;
      violations.push(`Emptied answer in ${file}`);
    }

    // Check 3: Cited IDs lost
    const candidateAnswerIds = refUuids(candidate.answer);
    for (const droppedText of ref.droppedEarlierTexts) {
      const droppedIds = refUuids(droppedText);
      for (const id of droppedIds) {
        if (!candidateAnswerIds.has(id)) {
          citedIdsLost++;
          violations.push(`Lost cited ID ${id} in ${file}`);
        }
      }
    }
  }

  return {
    sessionsChecked,
    removableDuplicatesAt80Percent,
    duplicatesRemoved: totalDuplicatesRemoved,
    citedIdsLost,
    violations,
    emptied,
  };
}

if (process.argv[1] && process.argv[1].endsWith('capture-corpus-check.ts')) {
  console.log('Running capture corpus invariant check across recorded transcripts...');
  const res = runCorpusCheck();
  console.log(`Sessions checked: ${res.sessionsChecked}`);
  console.log(`Removable duplicates (at 80% coverage): ${res.removableDuplicatesAt80Percent}`);
  console.log(`Duplicates removed: ${res.duplicatesRemoved}`);
  console.log(`Reduction ratio: ${(res.duplicatesRemoved / (res.removableDuplicatesAt80Percent || 1) * 100).toFixed(2)}%`);
  console.log(`Cited IDs lost: ${res.citedIdsLost}`);
  console.log(`Emptied answers: ${res.emptied}`);
  console.log(`Safety violations: ${res.violations.length}`);

  let failed = false;
  if (res.violations.length > 0) {
    console.error(`FAILED: ${res.violations.length} violations found (first 5):`);
    for (const v of res.violations.slice(0, 5)) console.error(`  - ${v}`);
    failed = true;
  }
  if (res.emptied > 0) {
    console.error(`FAILED: ${res.emptied} answers emptied`);
    failed = true;
  }
  if (res.citedIdsLost > 0) {
    console.error(`FAILED: ${res.citedIdsLost} cited IDs lost`);
    failed = true;
  }
  const ratio = res.duplicatesRemoved / (res.removableDuplicatesAt80Percent || 1);
  if (ratio < 0.95) {
    console.error(`FAILED: Duplicate reduction ratio ${(ratio * 100).toFixed(2)}% < 95%`);
    failed = true;
  }

  if (failed) {
    process.exit(1);
  } else {
    console.log('PASS: All corpus invariants satisfied.');
  }
}
