import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseToml } from 'smol-toml';

export interface PlaneConfig {
  baseUrl: string;
  workspaceSlug: string;
  projectId: string;
  stateReady: string;
  stateInProgress: string;
  stateNeedsInput: string;
  stateInReview: string;
}

export interface Config {
  projectName: string;
  repoPath: string;
  worktreesDir: string;
  logFile: string;
  ticketProvider: string;
  maxTurns: number;
  sleepNoWork: number;
  sleepError: number;
  validateCmd: string;
  plane: PlaneConfig;
  planeApiKey: string;
  githubToken: string;
  claudeOAuthToken: string;
}

interface ProjectToml {
  name?: string;
  repo_path: string;
  worktrees_dir: string;
  ticket_provider?: string;
  validate_cmd?: string;
  max_turns?: number;
  sleep_no_work?: number;
  sleep_error?: number;
  log_file?: string;
  plane: {
    base_url?: string;
    workspace_slug: string;
    project_id: string;
    state_ready: string;
    state_in_progress: string;
    state_needs_input: string;
    state_in_review: string;
  };
}

const KBAGENT_DIR = path.join(os.homedir(), '.kbagent');
const GLOBAL_ENV_PATH = path.join(KBAGENT_DIR, '.env');

export function loadConfig(globalEnvFile?: string): Config {
  const tomlPath = findTomlFile();
  const proj = parseToml(fs.readFileSync(tomlPath, 'utf8')) as unknown as ProjectToml;

  if (!proj.repo_path) throw new Error('kbagent.toml: repo_path is required');
  if (!proj.worktrees_dir) throw new Error('kbagent.toml: worktrees_dir is required');
  if (!proj.plane) throw new Error('kbagent.toml: [plane] section is required');

  const p = proj.plane;
  if (!p.workspace_slug) throw new Error('kbagent.toml: plane.workspace_slug is required');
  if (!p.project_id) throw new Error('kbagent.toml: plane.project_id is required');
  if (!p.state_ready) throw new Error('kbagent.toml: plane.state_ready is required');
  if (!p.state_in_progress) throw new Error('kbagent.toml: plane.state_in_progress is required');
  if (!p.state_needs_input) throw new Error('kbagent.toml: plane.state_needs_input is required');
  if (!p.state_in_review) throw new Error('kbagent.toml: plane.state_in_review is required');

  // Secrets load in layers, lowest precedence first: the global file holds
  // account-scoped credentials (one Anthropic account), the project file holds
  // integration-scoped ones (this project's Plane workspace, GitHub repos, Supabase
  // project). Real environment variables outrank both. Values land in process.env so
  // devcontainer.json's `${localEnv:KB_AGENT_*}` bindings resolve for this project.
  const projectName = proj.name ?? path.basename(proj.repo_path);
  const shellKeys = new Set(Object.keys(process.env));
  applyEnvFile(globalEnvFile ?? GLOBAL_ENV_PATH, shellKeys);
  applyEnvFile(path.join(KBAGENT_DIR, `${projectName}.env`), shellKeys);

  return {
    projectName,
    repoPath: proj.repo_path,
    worktreesDir: proj.worktrees_dir,
    logFile: proj.log_file ?? path.join(os.homedir(), 'Library', 'Logs', 'kbagent.log'),
    ticketProvider: proj.ticket_provider ?? 'plane',
    maxTurns: proj.max_turns ?? 50,
    sleepNoWork: proj.sleep_no_work ?? 15,
    sleepError: proj.sleep_error ?? 300,
    validateCmd: proj.validate_cmd ?? '',
    plane: {
      baseUrl: p.base_url ?? 'https://api.plane.so',
      workspaceSlug: p.workspace_slug,
      projectId: p.project_id,
      stateReady: p.state_ready,
      stateInProgress: p.state_in_progress,
      stateNeedsInput: p.state_needs_input,
      stateInReview: p.state_in_review,
    },
    planeApiKey: requireEnv('KB_AGENT_PLANE_API_KEY'),
    githubToken: process.env['KB_AGENT_GITHUB_TOKEN'] ?? '',
    claudeOAuthToken: process.env['KB_AGENT_CLAUDE_CODE_OAUTH_TOKEN'] ?? '',
  };
}

// Merge one secrets layer into process.env. A missing file is not an error — every
// layer is optional. Keys already present in the real environment are left alone, so
// an exported variable always wins; otherwise a later layer overrides an earlier one.
function applyEnvFile(filePath: string, shellKeys: Set<string>): void {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  for (const [key, value] of Object.entries(dotenv.parse(raw))) {
    if (shellKeys.has(key)) continue;
    process.env[key] = value;
  }
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`${name} is required but not set in ~/.kbagent/.env or ~/.kbagent/<project>.env`);
  }
  return val;
}

function findTomlFile(): string {
  let dir = process.cwd();
  for (;;) {
    const p = path.join(dir, 'kbagent.toml');
    if (fs.existsSync(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('No kbagent.toml found in current directory or any parent directory');
    dir = parent;
  }
}
