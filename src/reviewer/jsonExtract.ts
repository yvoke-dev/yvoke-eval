/**
 * Extract the first JSON object from model text. Tolerates a ```json fence or surrounding prose —
 * the grader is instructed to return raw JSON, but the Agent SDK gives no schema guarantee (unlike
 * Gemini's responseSchema), so we parse defensively.
 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    /* not bare JSON — keep trying */
  }

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fenced block wasn't valid JSON */
    }
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      /* outermost braces weren't a valid object */
    }
  }

  throw new Error('no JSON object found in model output');
}
