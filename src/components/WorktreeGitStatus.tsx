import { ArrowDown, ArrowUp, Check, TriangleAlert } from 'lucide-react';
import type { GitStatusSummary } from '@/lib/api';

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

interface WorktreeGitStatusProps {
  status?: GitStatusSummary;
}

/** Compact git state of a worktree: pull/push counts, staged and changed files, or "clean". */
export function WorktreeGitStatus({ status }: WorktreeGitStatusProps) {
  if (!status) return null;

  const changed = status.unstaged + status.untracked;
  const isClean = status.staged === 0 && changed === 0 && status.conflicted === 0;
  const inSync = status.has_upstream && status.ahead === 0 && status.behind === 0;

  const changedTitle = [
    status.unstaged > 0 && `${plural(status.unstaged, 'modified file')}`,
    status.untracked > 0 && `${plural(status.untracked, 'untracked file')}`,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <div className="worktree-git-status">
      {status.conflicted > 0 && (
        <span className="git-chip git-chip-conflict" title={`${plural(status.conflicted, 'conflicted file')}`}>
          <TriangleAlert size={10} />
          {status.conflicted}
        </span>
      )}
      {status.behind > 0 && (
        <span className="git-chip git-chip-pull" title={`${plural(status.behind, 'commit')} to pull`}>
          <ArrowDown size={10} />
          {status.behind}
        </span>
      )}
      {status.ahead > 0 && (
        <span className="git-chip git-chip-push" title={`${plural(status.ahead, 'commit')} to push`}>
          <ArrowUp size={10} />
          {status.ahead}
        </span>
      )}
      {!status.has_upstream && (
        <span className="git-chip git-chip-muted" title="No upstream branch: push to publish it">
          local
        </span>
      )}
      {status.staged > 0 && (
        <span className="git-chip git-chip-staged" title={`${plural(status.staged, 'staged file')}`}>
          +{status.staged}
        </span>
      )}
      {changed > 0 && (
        <span className="git-chip git-chip-changed" title={changedTitle}>
          ~{changed}
        </span>
      )}
      {isClean && (
        <span
          className="git-chip git-chip-muted"
          title={inSync ? 'Clean and up to date' : 'No uncommitted changes'}
        >
          <Check size={10} />
          clean
        </span>
      )}
    </div>
  );
}
