const STOP_WORDS = new Set([
  "add", "agent", "bug", "change", "feature", "fix", "issue", "remove", "space", "support", "update",
]);

export interface IssueText {
  title: string;
  body: string;
}

export function issueOverlapScore(proposed: IssueText, candidate: IssueText): number {
  const proposedTitle = features(proposed.title);
  const candidateTitle = features(candidate.title);
  const titleShared = intersectionSize(proposedTitle, candidateTitle);
  if (titleShared < 2 && !sharesWord(proposedTitle, candidateTitle)) return 0;
  const title = dice(proposedTitle, candidateTitle);
  const body = dice(
    features(`${proposed.title}\n${proposed.body}`),
    features(`${candidate.title}\n${candidate.body}`),
  );
  return Math.max(title, title * 0.7 + body * 0.3);
}

function features(value: string): Set<string> {
  const normalized = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/<!--[^]*?-->/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
  const tokens = new Set<string>();
  for (const word of normalized.match(/[a-z0-9][a-z0-9._-]{2,}/g) ?? []) {
    if (!STOP_WORDS.has(word)) tokens.add(`w:${word}`);
  }
  for (const sequence of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    for (let index = 0; index < sequence.length - 1; index += 1) {
      tokens.add(`c:${sequence.slice(index, index + 2)}`);
    }
  }
  return tokens;
}

function sharesWord(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const token of left) if (token.startsWith("w:") && right.has(token)) return true;
  return false;
}

function intersectionSize(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let count = 0;
  for (const token of left) if (right.has(token)) count += 1;
  return count;
}

function dice(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size + right.size === 0) return 0;
  return (2 * intersectionSize(left, right)) / (left.size + right.size);
}
