import { invoke } from '@tauri-apps/api/core';

// ============ Types from Backend ============

export interface BackendWorktree {
  path: string;
  branch: string;
  is_main: boolean;
  is_bare: boolean;
}

export interface BackendBranch {
  name: string;
  is_remote: boolean;
  is_head: boolean;
}

export interface BackendWorktreeStatus {
  has_changes: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
}

/** Sync and change state of a worktree (`git status` summary) */
export interface GitStatusSummary {
  ahead: number;
  behind: number;
  has_upstream: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

export async function getWorktreeGitStatus(worktreePath: string): Promise<GitStatusSummary> {
  return invoke('get_worktree_git_status', { worktreePath });
}

export interface BackendIdeConfig {
  type: string;
  preset?: string;
  custom_command?: string;
}

export interface BackendProjectConfig {
  name: string;
  repo_path: string;
  default_base_branch?: string;
  ide?: BackendIdeConfig;
}

export interface Note {
  id: string;
  text: string;
  pinned: boolean;
}

export interface QuickLink {
  id: string;
  name: string;
  url: string;
  pinned: boolean;
}

export interface DeepLink {
  id: string;
  platform: DevicePlatform;
  package: string;
  name: string;
  url: string;
}

/** Options for the simulator/emulator quick bar (see src-tauri/src/types.rs) */
export interface QuickBarSettings {
  shrink_recordings: boolean;
  /** Lower is better quality and a bigger file (18-36) */
  video_crf: number;
  /** 0 keeps the original frame rate */
  video_fps: number;
  /** 0 keeps the original width */
  video_max_width: number;
  video_codec: 'h264' | 'hevc';
  /** Recordings older than this many hours are deleted when a new one starts; 0 keeps them */
  recording_keep_hours: number;
  screenshot_save_to_desktop: boolean;
}

export interface BackendAppSettings {
  ide?: BackendIdeConfig;
  theme: string;
  launch_at_startup?: boolean;
  default_worktree_template?: string;
  copy_paths?: string[];
  fetch_before_create?: boolean;
  clipboard_parse_patterns?: string[];
  last_used_project?: string;
  refresh_interval_minutes: number;
  skip_open_ide_confirm?: boolean;
  onboarding_completed?: boolean;
  projects: BackendProjectConfig[];
  github_configs: unknown[];
  jira_configs: unknown[];
  global_shortcut?: string;
  pinned_devices?: string[];
  device_notes?: Record<string, string>;
  notes?: Note[];
  quick_links?: QuickLink[];
  deep_links?: DeepLink[];
  quick_bar?: QuickBarSettings;
}

// ============ Devices API ============

export interface Device {
  id: string;
  name: string;
  runtime: string | null;
  state: string | null;
}

export async function listIosSimulators(): Promise<Device[]> {
  return invoke('list_ios_simulators');
}

export async function listAndroidEmulators(): Promise<Device[]> {
  return invoke('list_android_emulators');
}

export async function launchIosSimulator(udid: string): Promise<void> {
  return invoke('launch_ios_simulator', { udid });
}

export async function launchAndroidEmulator(avdName: string): Promise<void> {
  return invoke('launch_android_emulator', { avdName });
}

export async function setQuickLinks(links: QuickLink[]): Promise<void> {
  return invoke('set_quick_links', { links });
}

export async function setDeepLinks(links: DeepLink[]): Promise<void> {
  return invoke('set_deep_links', { links });
}

export async function openLink(url: string): Promise<void> {
  return invoke('open_link', { url });
}

export async function setNotes(notes: Note[]): Promise<void> {
  return invoke('set_notes', { notes });
}

export async function setDeviceNote(key: string, note: string): Promise<void> {
  return invoke('set_device_note', { key, note });
}

export async function setPinnedDevices(pinned: string[]): Promise<void> {
  return invoke('set_pinned_devices', { pinned });
}

// ============ Windows API ============

export async function openJsonViewer(): Promise<void> {
  return invoke('open_json_viewer');
}

export type DevicePlatform = 'ios' | 'android';

/** Opens the live native-log window for a running device. */
export async function openLogWindow(platform: DevicePlatform, deviceId: string, deviceName: string): Promise<void> {
  return invoke('open_log_window', { platform, deviceId, deviceName });
}

/** Saves log text to a temp file and returns its path. */
export async function saveLogSnapshot(deviceName: string, content: string): Promise<string> {
  return invoke('save_log_snapshot', { deviceName, content });
}

/** Process ID -> process (package) name for a running Android emulator. */
export async function listAndroidProcesses(deviceId: string): Promise<Record<string, string>> {
  return invoke('list_android_processes', { deviceId });
}

/** Shows the quick actions bar docked to a running device's window, or hides it if shown. */
export async function toggleDeviceDock(platform: DevicePlatform, deviceId: string, deviceName: string): Promise<void> {
  return invoke('toggle_device_dock', { platform, deviceId, deviceName });
}

/** Opens quick action bars for every currently running simulator/emulator that does not already have one. */
export async function openRunningDeviceDocks(): Promise<number> {
  return invoke('open_running_device_docks');
}

export type ToastKind = 'ok' | 'error' | 'busy';

/**
 * Shows a toast over the centre of the device the calling quick bar is docked to. It closes
 * itself, unless `sticky` (then it stays until the next toast replaces it). `busy` shows a spinner.
 */
export async function showDeviceToast(message: string, kind: ToastKind = 'ok', sticky = false): Promise<void> {
  return invoke('show_device_toast', { message, kind, sticky });
}

/** Shows a "recording" timer pill near the top of the device the calling quick bar is docked to. */
export async function showRecordingIndicator(startedAt: number): Promise<void> {
  return invoke('show_recording_indicator', { startedAt });
}

export async function hideRecordingIndicator(): Promise<void> {
  return invoke('hide_recording_indicator');
}

/** Starts recording; resolves with when it started (ms since the Unix epoch). */
export async function startDeviceRecording(platform: DevicePlatform, deviceId: string): Promise<number> {
  return invoke('start_device_recording', { platform, deviceId });
}

/** When the device's recording started (ms since the Unix epoch), or null if it isn't recording. */
export async function deviceRecordingStartedAt(platform: DevicePlatform, deviceId: string): Promise<number | null> {
  return invoke('device_recording_started_at', { platform, deviceId });
}

export interface FinishedRecording {
  path: string;
  /** Size as recorded, and after shrinking (equal when it wasn't shrunk) */
  original_bytes: number;
  final_bytes: number;
}

/** Stops the recording and resolves with the finished video file's path and sizes. */
export async function stopDeviceRecording(platform: DevicePlatform, deviceId: string): Promise<FinishedRecording> {
  return invoke('stop_device_recording', { platform, deviceId });
}

export type DeviceQuickAction = 'screenshot' | 'toggle_appearance' | 'open_url' | 'relaunch_app';

/** Runs a quick action; returns a short result (screenshot path, new appearance) when there is one. */
export async function deviceQuickAction(
  platform: DevicePlatform,
  deviceId: string,
  action: DeviceQuickAction,
  payload?: string
): Promise<string | null> {
  return invoke('device_quick_action', { platform, deviceId, action, payload });
}

export async function setQuickBarSettings(quickBar: QuickBarSettings): Promise<void> {
  return invoke('set_quick_bar_settings', { quickBar });
}

/** Opens the quick bar settings window (screenshot / recording options, saved recordings). */
export async function openQuickBarSettings(): Promise<void> {
  return invoke('open_quick_bar_settings');
}

export interface RecordingFile {
  name: string;
  path: string;
  size: number;
  /** Last modified, ms since the Unix epoch */
  modified_ms: number;
  /** Still being recorded: can't be deleted yet */
  in_progress: boolean;
}

/** Saved recordings, newest first. */
export async function listRecordings(): Promise<RecordingFile[]> {
  return invoke('list_recordings');
}

export async function deleteRecording(path: string): Promise<void> {
  return invoke('delete_recording', { path });
}

/** Deletes all saved recordings except ones in progress; resolves with how many were deleted. */
export async function deleteAllRecordings(): Promise<number> {
  return invoke('delete_all_recordings');
}

export async function openRecording(path: string): Promise<void> {
  return invoke('open_recording', { path });
}

export async function revealRecording(path: string): Promise<void> {
  return invoke('reveal_recording', { path });
}

/** Where ffmpeg was found, or null. Shrinking recordings needs it. */
export async function ffmpegLocation(): Promise<string | null> {
  return invoke('ffmpeg_location');
}

/** Apps the user installed on a running device (system apps excluded). */
export async function listUserApps(platform: DevicePlatform, deviceId: string): Promise<string[]> {
  return invoke('list_user_apps', { platform, deviceId });
}

/** `appFilter` (iOS only) limits the stream to processes whose name contains it. */
export async function startLogStream(platform: DevicePlatform, deviceId: string, appFilter = ''): Promise<void> {
  return invoke('start_log_stream', { platform, deviceId, appFilter });
}

// ============ Clipboard API ============

export async function readClipboardText(): Promise<string> {
  return invoke('read_clipboard_text');
}

// ============ Settings API ============

export async function getSettings(): Promise<BackendAppSettings> {
  return invoke('get_settings');
}

export async function setIde(ide: BackendIdeConfig): Promise<void> {
  return invoke('set_ide', { ide });
}

export async function setTheme(theme: string): Promise<void> {
  return invoke('set_theme', { theme });
}

export async function setLaunchAtStartup(enabled: boolean): Promise<void> {
  return invoke('set_launch_at_startup', { enabled });
}

export async function setDefaultWorktreeTemplate(template: string): Promise<void> {
  return invoke('set_default_worktree_template', { template });
}

export async function setCopyPaths(paths: string[]): Promise<void> {
  return invoke('set_copy_paths', { paths });
}

export async function setFetchBeforeCreate(enabled: boolean): Promise<void> {
  return invoke('set_fetch_before_create', { enabled });
}

export async function setClipboardParsePatterns(patterns: string[]): Promise<void> {
  return invoke('set_clipboard_parse_patterns', { patterns });
}

export async function setLastUsedProject(project: string): Promise<void> {
  return invoke('set_last_used_project', { project });
}

export async function setRefreshIntervalMinutes(minutes: number): Promise<void> {
  return invoke('set_refresh_interval_minutes', { minutes });
}

export async function setSkipOpenIdeConfirm(skip: boolean): Promise<void> {
  return invoke('set_skip_open_ide_confirm', { skip });
}

export async function setOnboardingCompleted(completed: boolean): Promise<void> {
  return invoke('set_onboarding_completed', { completed });
}

export async function setGlobalShortcut(shortcut: string | null): Promise<void> {
  return invoke('set_global_shortcut', { shortcut });
}

// ============ Projects API ============

export async function getProjects(): Promise<BackendProjectConfig[]> {
  return invoke('get_projects');
}

export async function addProject(project: BackendProjectConfig): Promise<void> {
  return invoke('add_project', { project });
}

export async function updateProject(repoPath: string, project: BackendProjectConfig): Promise<void> {
  return invoke('update_project', { repoPath, project });
}

export async function removeProject(repoPath: string): Promise<void> {
  return invoke('remove_project', { repoPath });
}

export async function reorderProjects(repoPaths: string[]): Promise<void> {
  return invoke('reorder_projects', { repoPaths });
}

// ============ Git - Worktree API ============

export async function getWorktrees(repoPath: string): Promise<BackendWorktree[]> {
  return invoke('get_worktrees', { repoPath });
}

export async function createWorktree(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  baseBranch: string
): Promise<void> {
  return invoke('create_worktree', { repoPath, worktreePath, branchName, baseBranch });
}

export async function createWorktreeExistingBranch(
  repoPath: string,
  worktreePath: string,
  branchName: string
): Promise<void> {
  return invoke('create_worktree_existing_branch', { repoPath, worktreePath, branchName });
}

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  force: boolean,
  deleteBranch: boolean = false,
  branchName?: string
): Promise<void> {
  return invoke('remove_worktree', { repoPath, worktreePath, force, deleteBranch, branchName });
}

export async function pruneWorktrees(repoPath: string): Promise<void> {
  return invoke('prune_worktrees', { repoPath });
}

export async function getWorktreeStatus(worktreePath: string): Promise<BackendWorktreeStatus> {
  return invoke('get_worktree_status', { worktreePath });
}

// ============ Git - Branch API ============

export async function getBranches(repoPath: string, includeRemote: boolean): Promise<BackendBranch[]> {
  return invoke('get_branches', { repoPath, includeRemote });
}

export async function getCurrentBranch(repoPath: string): Promise<string> {
  return invoke('get_current_branch', { repoPath });
}

export async function getDefaultBranch(repoPath: string): Promise<string> {
  return invoke('get_default_branch', { repoPath });
}

export async function deleteBranch(repoPath: string, branchName: string, force: boolean): Promise<void> {
  return invoke('delete_branch', { repoPath, branchName, force });
}

export async function renameBranch(repoPath: string, oldName: string, newName: string): Promise<void> {
  return invoke('rename_branch', { repoPath, oldName, newName });
}

// ============ Git - Operations API ============

export async function gitFetch(repoPath: string): Promise<void> {
  return invoke('git_fetch', { repoPath });
}

export async function gitPull(worktreePath: string): Promise<void> {
  return invoke('git_pull', { worktreePath });
}

// ============ Git - Remote Info API ============

export interface GitHubRemoteInfo {
  owner: string;
  repo: string;
}

export async function getGitHubRemoteInfo(repoPath: string, githubHost?: string): Promise<GitHubRemoteInfo | null> {
  return invoke('get_github_remote_info', { repoPath, githubHost: githubHost ?? null });
}

// ============ IDE/File Operations API ============

export async function openIde(path: string, idePreset: string, customCommand?: string): Promise<void> {
  return invoke('open_ide', { path, idePreset, customCommand });
}

export async function openInFinder(path: string): Promise<void> {
  return invoke('open_in_finder', { path });
}

export async function openTerminal(path: string): Promise<void> {
  return invoke('open_terminal', { path });
}

export interface NativeProjects {
  ios_project: string | null;
  android_dir: string | null;
  start_command: string | null;
}

export async function detectNativeProjects(path: string): Promise<NativeProjects> {
  return invoke('detect_native_projects', { path });
}

export async function openXcode(path: string): Promise<void> {
  return invoke('open_xcode', { path });
}

export async function runStartCommand(path: string): Promise<void> {
  return invoke('run_start_command', { path });
}

export async function openAndroidStudio(path: string): Promise<void> {
  return invoke('open_android_studio', { path });
}

export async function copyPathsToWorktree(
  sourcePath: string,
  targetPath: string,
  paths: string[]
): Promise<void> {
  return invoke('copy_paths_to_worktree', { sourcePath, targetPath, paths });
}

// ============ Worktree Memo API ============

export interface WorktreeMemo {
  description?: string;
  issue_number?: string;
}

export async function getWorktreeMemo(path: string): Promise<WorktreeMemo> {
  return invoke('get_worktree_memo', { path });
}

export async function setWorktreeMemo(path: string, memo: WorktreeMemo): Promise<void> {
  return invoke('set_worktree_memo', { path, memo });
}

// ============ GitHub Integration API ============

// Full config (used when saving - token sent to backend)
export interface GitHubConfig {
  id: string;
  name: string;
  config_type: 'personal' | 'enterprise';
  token: string;
  host?: string;
  username?: string;
}

// Metadata only (returned from backend - no token exposed)
export interface GitHubConfigMeta {
  id: string;
  name: string;
  config_type: 'personal' | 'enterprise';
  host?: string;
  username?: string;
}

export interface ValidateResult {
  valid: boolean;
  username?: string;
  error?: string;
}

export interface PullRequestInfo {
  number: number;
  title: string;
  state: string;
  merged: boolean;
  draft: boolean;
  url: string;
  review_decision?: string;
  checks_status?: string;
}

export async function getGitHubConfig(): Promise<GitHubConfigMeta | null> {
  return invoke('get_github_config');
}

export async function setGitHubConfig(config: GitHubConfig): Promise<void> {
  return invoke('set_github_config', { config });
}

export async function removeGitHubConfig(): Promise<void> {
  return invoke('remove_github_config');
}

export async function validateGitHubToken(config: GitHubConfig): Promise<ValidateResult> {
  return invoke('validate_github_token', { config });
}

export async function fetchPullRequests(
  owner: string,
  repo: string,
  branch: string
): Promise<PullRequestInfo[]> {
  return invoke('fetch_pull_requests', { owner, repo, branch });
}

// ============ Jira Integration API ============

// Full config (used when saving - token sent to backend)
export interface JiraConfig {
  host: string;
  email?: string;
  api_token?: string;
  display_name?: string;
}

// Metadata only (returned from backend - no token exposed)
export interface JiraConfigMeta {
  host: string;
  email?: string;
  display_name?: string;
  has_token?: boolean;
}

export interface JiraIssueInfo {
  key: string;
  summary: string;
  status: string;
  status_category: string;
  url: string;
}

export async function getJiraConfig(): Promise<JiraConfigMeta | null> {
  return invoke('get_jira_config');
}

export async function setJiraConfig(config: JiraConfig): Promise<void> {
  return invoke('set_jira_config', { config });
}

export async function removeJiraConfig(): Promise<void> {
  return invoke('remove_jira_config');
}

export async function validateJiraCredentials(config: JiraConfig): Promise<ValidateResult> {
  return invoke('validate_jira_credentials', { config });
}

export async function fetchJiraIssue(issueKey: string): Promise<JiraIssueInfo | null> {
  return invoke('fetch_jira_issue', { issueKey });
}
