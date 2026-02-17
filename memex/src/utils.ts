/**
 * Extract JSON from text that may contain markdown fences or surrounding text.
 */
export function extractJSON(text: string): string {
  // Try markdown code block
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) return match[1].trim();

  // Try raw JSON object
  const start = text.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  return text;
}
