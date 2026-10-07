import { useEffect, useState } from 'react';
import * as api from '@/lib/api';

const NONE: api.NativeProjects = { ios_project: null, android_dir: null, start_command: null };

/** Detects iOS (Xcode) / Android (Gradle) projects and the npm `start` script in a worktree. */
export function useNativeProjects(worktreePath: string): api.NativeProjects {
  const [native, setNative] = useState<api.NativeProjects>(NONE);

  useEffect(() => {
    let cancelled = false;
    api
      .detectNativeProjects(worktreePath)
      .then((result) => {
        if (!cancelled) setNative(result);
      })
      .catch(() => {
        if (!cancelled) setNative(NONE);
      });
    return () => {
      cancelled = true;
    };
  }, [worktreePath]);

  return native;
}
