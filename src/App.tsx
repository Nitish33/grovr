import { useEffect, useState, useCallback, useRef } from 'react';
import { WorktreeListPage } from '@/pages/WorktreeListPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { ProjectSettingsPage } from '@/pages/ProjectSettingsPage';
import { AddProjectPage } from '@/pages/AddProjectPage';
import { CreateWorktreePage } from '@/pages/CreateWorktreePage';
import { EditWorktreePage } from '@/pages/EditWorktreePage';
import { UpdateDialog } from '@/components/ui/update-dialog';
import { onOpenUrl, getCurrent } from '@tauri-apps/plugin-deep-link';
import * as api from '@/lib/api';
import { parseDeepLink, findBestMatchingProject } from '@/lib/deep-link';
import { checkForUpdates, type UpdateInfo } from '@/lib/updater';
import type { Project, Worktree, IDEPreset, DeepLinkParams, IncomingNote } from '@/types';
import { applyTheme, type ThemeMode } from '@/lib/theme';
import './index.css';

const IS_MAC = /Mac/i.test(navigator.platform);

function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable;
}

type Page = 'worktrees' | 'settings' | 'project-settings' | 'add-project' | 'create-worktree' | 'edit-worktree';

interface ParsedClipboard {
  issueNumber: string;
  description: string;
  branchName?: string;
}

function App() {
  const [page, setPage] = useState<Page>('worktrees');
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [selectedWorktree, setSelectedWorktree] = useState<Worktree | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [theme, setTheme] = useState<ThemeMode>('system');
  const [clipboardData, setClipboardData] = useState<ParsedClipboard | null>(null);
  const [incomingNote, setIncomingNote] = useState<IncomingNote | null>(null);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);
  const clipboardPatternsRef = useRef<string[]>(['\\[(?<issueNumber>[A-Z]+-\\d+)\\]\\s*(?<description>.+)']);

  // Load saved theme and clipboard pattern on startup
  useEffect(() => {
    api.getSettings()
      .then((settings) => {
        const savedTheme = (settings.theme as ThemeMode) || 'system';
        setTheme(savedTheme);
        applyTheme(savedTheme);
        if (settings.clipboard_parse_patterns && settings.clipboard_parse_patterns.length > 0) {
          clipboardPatternsRef.current = settings.clipboard_parse_patterns;
        }
      })
      .catch(() => {
        applyTheme('system');
      });
  }, []);

  // Check for updates on startup
  useEffect(() => {
    const checkUpdates = async () => {
      const update = await checkForUpdates();
      if (update) {
        setUpdateInfo(update);
      }
    };
    // Delay update check to not block initial render
    const timer = setTimeout(checkUpdates, 3000);
    return () => clearTimeout(timer);
  }, []);

  // Listen for system theme changes when in system mode
  useEffect(() => {
    if (theme !== 'system') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyTheme('system');
    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, [theme]);

  // Global keyboard shortcuts
  useEffect(() => {
    /** Matches the clipboard against the configured worktree patterns, e.g. "[ABC-123] description". */
    const parseWorktreeClipboard = (text: string): ParsedClipboard | null => {
      for (const pattern of clipboardPatternsRef.current) {
        try {
          const match = text.match(new RegExp(pattern));
          if (match?.groups) {
            return {
              issueNumber: match.groups.issueNumber || '',
              description: match.groups.description || '',
            };
          }
        } catch {
          // Invalid regex, skip
        }
      }
      return null;
    };

    const handleKeyDown = async (e: KeyboardEvent) => {
      // cmd+, : Open settings
      if (e.metaKey && e.key === ',') {
        e.preventDefault();
        setPage('settings');
        return;
      }

      const isPlainPasteKey = e.key.toLowerCase() === 'v' && !e.altKey && !e.shiftKey;
      if (!isPlainPasteKey || (e.ctrlKey === e.metaKey)) return; // exactly one of ctrl / cmd

      // Never hijack pasting into a text field, or while a dialog is open.
      // (On macOS ctrl+v is not a paste shortcut, so it may capture even from a field.)
      const typing = isEditableElement(document.activeElement);
      if ((typing && !(e.ctrlKey && IS_MAC)) || document.querySelector('[role="dialog"]')) return;

      e.preventDefault();
      try {
        const raw = await api.readClipboardText();
        const text = raw.trim();
        if (!text) return;

        // cmd+v: text that looks like "[ABC-123] description" still opens Create Worktree
        const matchedData = e.metaKey ? parseWorktreeClipboard(raw) : null;
        if (matchedData) {
          const projects = await api.getProjects();
          if (projects.length > 0) {
            const firstProject = projects[0];
            setSelectedProject({
              name: firstProject.name,
              repoPath: firstProject.repo_path,
              defaultBaseBranch: firstProject.default_base_branch,
              ide: firstProject.ide?.preset as IDEPreset | undefined,
              worktrees: [],
            });
            setClipboardData(matchedData);
            setPage('create-worktree');
            return;
          }
        }

        // Anything else (cmd+v or ctrl+v): save it as a note and open the Notes tab
        setIncomingNote({ id: Date.now(), text });
        setPage('worktrees');
      } catch {
        // Clipboard unavailable or not text - ignore
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleOpenProjectSettings = (project: Project) => {
    setSelectedProject(project);
    setPage('project-settings');
  };

  const handleCreateWorktree = (project: Project) => {
    setSelectedProject(project);
    setPage('create-worktree');
  };

  const handleEditWorktree = (worktree: Worktree, repoPath: string) => {
    setSelectedWorktree({ ...worktree, repoPath });
    setPage('edit-worktree');
  };

  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const handleProjectDeleted = useCallback(() => {
    handleRefresh();
    setPage('worktrees');
  }, [handleRefresh]);

  const handleProjectSaved = useCallback(() => {
    handleRefresh();
  }, [handleRefresh]);

  const handleProjectAdded = useCallback((repoPath: string) => {
    handleRefresh();
    setExpandedProjects((prev) => new Set([...prev, repoPath]));
  }, [handleRefresh]);

  const handleWorktreeCreated = useCallback(() => {
    handleRefresh();
    setClipboardData(null);
  }, [handleRefresh]);

  // Deep link handler
  const handleDeepLink = useCallback(async (params: DeepLinkParams) => {
    if (params.route === 'create-worktree') {
      try {
        const projects = await api.getProjects();
        if (projects.length === 0) {
          setPage('add-project');
          return;
        }

        let targetProject: (typeof projects)[0] | undefined;

        // Find project by name if specified
        if (params.project) {
          const matched = findBestMatchingProject(params.project, projects);
          if (matched) {
            targetProject = matched;
          }
        }

        // Fallback to last used project
        if (!targetProject) {
          const settings = await api.getSettings();
          if (settings.last_used_project) {
            targetProject = projects.find((p) => p.repo_path === settings.last_used_project);
          }
        }

        // Fallback to first project
        if (!targetProject) {
          targetProject = projects[0];
        }

        setSelectedProject({
          name: targetProject.name,
          repoPath: targetProject.repo_path,
          defaultBaseBranch: targetProject.default_base_branch,
          ide: targetProject.ide?.preset as IDEPreset | undefined,
          worktrees: [],
        });

        if (params.issue || params.description || params.branch) {
          setClipboardData({
            issueNumber: params.issue || '',
            description: params.description || '',
            branchName: params.branch,
          });
        }

        setPage('create-worktree');
      } catch (err) {
        console.error('Failed to handle deep link:', err);
      }
    } else if (params.route === 'settings') {
      setPage('settings');
    }
  }, []);

  // Deep link listener
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    const setupDeepLink = async () => {
      // Check for cold start deep link
      try {
        const urls = await getCurrent();
        if (urls && urls.length > 0) {
          const parsed = parseDeepLink(urls[0]);
          if (parsed.valid && parsed.params) {
            // Delay to ensure React is mounted
            setTimeout(() => handleDeepLink(parsed.params!), 100);
          }
        }
      } catch (err) {
        console.error('Failed to get current deep link:', err);
      }

      // Listen for warm start deep links
      try {
        unsubscribe = await onOpenUrl((urls) => {
          if (urls.length > 0) {
            const parsed = parseDeepLink(urls[0]);
            if (parsed.valid && parsed.params) {
              handleDeepLink(parsed.params);
            }
          }
        });
      } catch (err) {
        console.error('Failed to setup deep link listener:', err);
      }
    };

    setupDeepLink();

    return () => {
      unsubscribe?.();
    };
  }, [handleDeepLink]);

  const goToWorktrees = useCallback(() => setPage('worktrees'), []);

  return (
    <div className="app-container">
      <UpdateDialog
        updateInfo={updateInfo}
        open={showUpdateDialog}
        onOpenChange={setShowUpdateDialog}
      />
      {page === 'worktrees' && (
        <WorktreeListPage
          key={refreshKey}
          onOpenSettings={() => setPage('settings')}
          onOpenProjectSettings={handleOpenProjectSettings}
          onAddProject={() => setPage('add-project')}
          onCreateWorktree={handleCreateWorktree}
          onEditWorktree={handleEditWorktree}
          expandedProjects={expandedProjects}
          onExpandedProjectsChange={setExpandedProjects}
          updateInfo={updateInfo}
          onShowUpdate={() => setShowUpdateDialog(true)}
          incomingNote={incomingNote}
          onIncomingNoteHandled={() => setIncomingNote(null)}
        />
      )}
      {page === 'settings' && (
        <SettingsPage onBack={goToWorktrees} />
      )}
      {page === 'project-settings' && selectedProject && (
        <ProjectSettingsPage
          project={selectedProject}
          onBack={goToWorktrees}
          onDeleted={handleProjectDeleted}
          onSaved={handleProjectSaved}
        />
      )}
      {page === 'add-project' && (
        <AddProjectPage onBack={goToWorktrees} onProjectAdded={handleProjectAdded} />
      )}
      {page === 'create-worktree' && selectedProject && (
        <CreateWorktreePage
          project={selectedProject}
          onBack={() => {
            setPage('worktrees');
            setClipboardData(null);
          }}
          onWorktreeCreated={handleWorktreeCreated}
          initialData={clipboardData}
          allowProjectChange={!!clipboardData}
        />
      )}
      {page === 'edit-worktree' && selectedWorktree && (
        <EditWorktreePage
          worktree={selectedWorktree}
          onBack={goToWorktrees}
          onSaved={handleRefresh}
        />
      )}
    </div>
  );
}

export default App;
