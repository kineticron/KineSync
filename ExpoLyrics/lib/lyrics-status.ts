export function trimTrailingSourceFromAction(actionText: string, sourceText: string) {
  const action = String(actionText || "").trim();
  const source = String(sourceText || "").trim();
  if (!action || !source) {
    return action;
  }

  const escapedSource = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const trailingSourcePatterns = [
    new RegExp(`\\s*\\(${escapedSource}\\)\\s*[.!…]*$`, "i"),
    new RegExp(
      `\\s+from\\s+${escapedSource}(?:\\s+on\\s+desktop)?\\s*[.!…]*$`,
      "i",
    ),
    new RegExp(`\\s+source\\s+${escapedSource}\\s*[.!…]*$`, "i"),
  ];

  for (const pattern of trailingSourcePatterns) {
    if (pattern.test(action)) {
      return action.replace(pattern, (match) =>
        match.toLowerCase().includes(" from ") ? " from" : "",
      );
    }
  }

  return action;
}

export function extractSourceFromStatusMessage(statusMessage: string) {
  const message = String(statusMessage || "").trim();
  if (!message) {
    return "";
  }

  const parentheticalMatch = message.match(/\(([^()]+)\)\s*[.!…]*$/);
  if (parentheticalMatch) {
    return parentheticalMatch[1]?.trim() || "";
  }

  const fromMatch = message.match(
    /\bfrom\s+(.+?)(?:\s+on\s+desktop)?\s*[.!…]*$/i,
  );
  if (fromMatch) {
    return fromMatch[1]?.trim() || "";
  }

  const sourceMatch = message.match(/\bsource\s+(.+?)\s*[.!…]*$/i);
  if (sourceMatch) {
    return sourceMatch[1]?.trim() || "";
  }

  return "";
}
