#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "$(git rev-parse --is-inside-work-tree 2>/dev/null || true)" != "true" ]]; then
  echo "Repository audit requires a Git worktree." >&2
  exit 1
fi

blocked_files="$({
  git ls-files \
    | /usr/bin/grep -E '(^|/)(\.env($|\.)|MochiControlManifest\.json$)|\.(key|p12|pem)$' \
    || true
})"
if [[ -n "$blocked_files" ]]; then
  echo "Sensitive runtime files are tracked:" >&2
  echo "$blocked_files" >&2
  exit 1
fi

blocked_content="$({
  git grep -Il -E \
    '([[:alnum:]._%+-]+@(gmail|googlemail|outlook|hotmail|live|icloud|me|qq|foxmail|163|126)\.[[:alpha:]]+|(^|[^[:alnum:]])(gh[opsu]_[[:alnum:]_]{20,}|sk-[[:alnum:]_-]{20,}|cli_[[:alnum:]_]{12,}|o[uc]_[[:alnum:]_]{20,})|BEGIN ([A-Z ]+ )?PRIVATE KEY)' \
    -- . ':(exclude)script/check_repository.sh' \
    || true
})"
if [[ -n "$blocked_content" ]]; then
  echo "Potential personal data or credentials found in tracked files:" >&2
  echo "$blocked_content" >&2
  exit 1
fi

personal_path_files="$({
  git grep -In '/Users/' -- . ':(exclude)script/check_repository.sh' \
    | /usr/bin/grep -Ev '/Users/(Shared|_mochi|bridge|test)(/|"|`|$)' \
    | /usr/bin/grep -Fv '/Users/${' \
    | /usr/bin/cut -d: -f1 \
    | /usr/bin/sort -u \
    || true
})"
if [[ -n "$personal_path_files" ]]; then
  echo "Machine-specific user paths found in tracked files:" >&2
  echo "$personal_path_files" >&2
  exit 1
fi

history_revisions=(HEAD)
if [[ "${GITHUB_EVENT_NAME:-}" == "pull_request" && "${GITHUB_SHA:-}" == "$(git rev-parse HEAD)" ]]; then
  read -r -a pull_request_parents <<<"$(git show -s --format='%P' HEAD)"
  if [[ "${#pull_request_parents[@]}" != "2" ]]; then
    echo "Pull Request checkout is not the expected synthetic merge commit." >&2
    exit 1
  fi
  history_revisions=("${pull_request_parents[@]}")
fi

is_noreply_email() {
  [[ "$1" =~ @users\.noreply\.github\.com$ || "$1" == "noreply@github.com" ]]
}

is_allowed_commit_identity() {
  local commit="$1"
  local author_email committer_name committer_email subject
  IFS=$'\t' read -r author_email committer_name committer_email subject \
    <<<"$(git show -s --format='%ae%x09%cn%x09%ce%x09%s' "$commit")"

  if is_noreply_email "$author_email" && is_noreply_email "$committer_email"; then
    return 0
  fi

  if [[ "$committer_name" == "GitHub" \
    && "$committer_email" == "noreply@github.com" \
    && "$subject" =~ \(#[0-9]+\)$ ]] \
    && git cat-file -p "$commit" | /usr/bin/grep -q '^gpgsig '; then
    return 0
  fi

  return 1
}

unexpected_identity_commits=""
while IFS= read -r commit; do
  if ! is_allowed_commit_identity "$commit"; then
    unexpected_identity_commits+="${unexpected_identity_commits:+$'\n'}$commit"
  fi
done < <(git rev-list "${history_revisions[@]}")

if [[ -n "$unexpected_identity_commits" ]]; then
  echo "Git history contains unexpected author or committer identities:" >&2
  echo "$unexpected_identity_commits" >&2
  exit 1
fi

echo "Repository contains no tracked runtime secrets or unexpected personal identities."
