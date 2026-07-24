/**
 * Pure, dependency-free compute helpers exposed to the model as safe in-process MCP
 * tools (wired up in computeServer.ts). None of these touch the shell, filesystem, or
 * network — they exist so the knowledge-base assistant can do the numeric/data work it
 * needs WITHOUT the general `Bash` tool (which is arbitrary code execution). This module
 * deliberately does NOT import the Agent SDK, so the permission layer and unit tests that
 * reference the tool names stay lightweight.
 *
 * COPIED VERBATIM from yvoke-desktop/src/main/agent/computeTools.ts. The eval must reproduce production's tool
 * surface exactly, so this cannot drift: if the desktop copy changes, change this one in the same
 * commit. Duplicated rather than shared because the two repos have no common package — extracting
 * one is the right long-term fix and is tracked with the desktop work.
 */

export const COMPUTE_SERVER_NAME = 'compute';
export const COMPUTE_TOOL_PREFIX = `mcp__${COMPUTE_SERVER_NAME}__`;

/** Fully-qualified tool names, exactly as the model and the permission allow-list see them. */
export const COMPUTE_TOOLS = [
  `${COMPUTE_TOOL_PREFIX}calculate`,
  `${COMPUTE_TOOL_PREFIX}statistics`,
  `${COMPUTE_TOOL_PREFIX}date_diff`,
];

// ---------------------------------------------------------------------------
// Safe arithmetic evaluator
//
// A hand-written recursive-descent parser. It NEVER uses eval()/Function() and
// resolves identifiers only against fixed own-property whitelists, so a hostile
// expression (`require("fs")`, `constructor`, `process.exit(1)`, `1; drop()`,
// `__proto__`) cannot reach JS execution — it simply fails to parse.
// ---------------------------------------------------------------------------

const MAX_EXPRESSION_LENGTH = 1000;

/** Whitelisted functions. Fixed map — no dynamic `Math[name]` lookup is ever done. */
const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  abs: Math.abs,
  sign: Math.sign,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  trunc: Math.trunc,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  log2: Math.log2,
  log10: Math.log10,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  pow: Math.pow,
  hypot: Math.hypot,
  atan2: Math.atan2,
  min: Math.min,
  max: Math.max,
};

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
};

type Token =
  | { type: 'number'; value: number }
  | { type: 'name'; value: string }
  | { type: 'op'; value: string }
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'comma' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if ((c >= '0' && c <= '9') || c === '.') {
      let j = i;
      while (j < input.length && /[0-9.]/.test(input[j])) j++;
      if (j < input.length && (input[j] === 'e' || input[j] === 'E')) {
        j++;
        if (input[j] === '+' || input[j] === '-') j++;
        while (j < input.length && /[0-9]/.test(input[j])) j++;
      }
      const text = input.slice(i, j);
      const value = Number(text);
      if (!Number.isFinite(value)) throw new Error(`invalid number: "${text}"`);
      tokens.push({ type: 'number', value });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < input.length && /[a-zA-Z0-9_]/.test(input[j])) j++;
      tokens.push({ type: 'name', value: input.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    // `**` is an alias for the `^` power operator.
    if (c === '*' && input[i + 1] === '*') {
      tokens.push({ type: 'op', value: '^' });
      i += 2;
      continue;
    }
    if ('+-*/%^'.includes(c)) {
      tokens.push({ type: 'op', value: c });
      i++;
      continue;
    }
    if (c === '(') {
      tokens.push({ type: 'lparen' });
      i++;
      continue;
    }
    if (c === ')') {
      tokens.push({ type: 'rparen' });
      i++;
      continue;
    }
    if (c === ',') {
      tokens.push({ type: 'comma' });
      i++;
      continue;
    }
    throw new Error(`unexpected character: "${c}"`);
  }
  return tokens;
}

/** Evaluate an arithmetic expression safely. Throws on anything it does not recognise. */
export function safeCalculate(expression: string): number {
  if (typeof expression !== 'string') throw new Error('expression must be a string');
  if (expression.length > MAX_EXPRESSION_LENGTH) throw new Error('expression too long');
  const tokens = tokenize(expression);
  if (tokens.length === 0) throw new Error('empty expression');

  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const isOp = (v: string): boolean => {
    const t = peek();
    return !!t && t.type === 'op' && t.value === v;
  };

  const parseExpression = (): number => {
    let value = parseTerm();
    while (isOp('+') || isOp('-')) {
      const op = (tokens[pos++] as { value: string }).value;
      const rhs = parseTerm();
      value = op === '+' ? value + rhs : value - rhs;
    }
    return value;
  };

  const parseTerm = (): number => {
    let value = parsePower();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = (tokens[pos++] as { value: string }).value;
      const rhs = parsePower();
      value = op === '*' ? value * rhs : op === '/' ? value / rhs : value % rhs;
    }
    return value;
  };

  const parsePower = (): number => {
    const base = parseUnary();
    if (isOp('^')) {
      pos++;
      return Math.pow(base, parsePower()); // right-associative
    }
    return base;
  };

  const parseUnary = (): number => {
    if (isOp('+')) {
      pos++;
      return parseUnary();
    }
    if (isOp('-')) {
      pos++;
      return -parseUnary();
    }
    return parsePrimary();
  };

  const parsePrimary = (): number => {
    const t = peek();
    if (!t) throw new Error('unexpected end of expression');
    if (t.type === 'number') {
      pos++;
      return t.value;
    }
    if (t.type === 'lparen') {
      pos++;
      const value = parseExpression();
      if (peek()?.type !== 'rparen') throw new Error('missing closing parenthesis');
      pos++;
      return value;
    }
    if (t.type === 'name') {
      pos++;
      const name = t.value;
      if (peek()?.type === 'lparen') {
        pos++;
        const args: number[] = [];
        if (peek()?.type !== 'rparen') {
          args.push(parseExpression());
          while (peek()?.type === 'comma') {
            pos++;
            args.push(parseExpression());
          }
        }
        if (peek()?.type !== 'rparen') throw new Error(`missing ) after ${name}(`);
        pos++;
        if (!Object.prototype.hasOwnProperty.call(FUNCTIONS, name)) {
          throw new Error(`unknown function: ${name}`);
        }
        return FUNCTIONS[name](...args);
      }
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) return CONSTANTS[name];
      throw new Error(`unknown name: ${name}`);
    }
    throw new Error('unexpected token');
  };

  const result = parseExpression();
  if (pos !== tokens.length) throw new Error('unexpected trailing tokens');
  if (!Number.isFinite(result)) throw new Error('result is not a finite number (e.g. division by zero)');
  return result;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export interface StatisticsResult {
  count: number;
  sum: number;
  mean: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
  range: number | null;
  /** Sample variance (n − 1); null for fewer than two values. */
  variance: number | null;
  /** Sample standard deviation; null for fewer than two values. */
  stdev: number | null;
}

export function computeStatistics(values: number[]): StatisticsResult {
  if (!Array.isArray(values)) throw new Error('values must be an array of numbers');
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('values must all be finite numbers');
  }
  const count = values.length;
  if (count === 0) {
    return { count: 0, sum: 0, mean: null, median: null, min: null, max: null, range: null, variance: null, stdev: null };
  }
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / count;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(count / 2);
  const median = count % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const min = sorted[0];
  const max = sorted[count - 1];
  let variance: number | null = null;
  let stdev: number | null = null;
  if (count > 1) {
    variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (count - 1);
    stdev = Math.sqrt(variance);
  }
  return { count, sum, mean, median, min, max, range: max - min, variance, stdev };
}

// ---------------------------------------------------------------------------
// Date difference
// ---------------------------------------------------------------------------

export type DurationUnit = 'weeks' | 'days' | 'hours' | 'minutes' | 'seconds' | 'milliseconds';

const UNIT_MS: Record<DurationUnit, number> = {
  milliseconds: 1,
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
};

/** Signed difference (to − from) between two parseable date/time strings, in `unit`. */
export function dateDiff(from: string, to: string, unit: DurationUnit = 'days'): number {
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (Number.isNaN(a)) throw new Error(`invalid "from" date: ${from}`);
  if (Number.isNaN(b)) throw new Error(`invalid "to" date: ${to}`);
  const ms = UNIT_MS[unit];
  if (!ms) throw new Error(`unknown unit: ${unit}`);
  return (b - a) / ms;
}
