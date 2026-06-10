import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseToml } from 'smol-toml';

export interface PlaneConfig {
  baseUrl: string;
  workspaceSlug: string;
  projectId: string;
  stateBacklog: string;
  stateSpecApproved: string;
  stateInProgress: string;
  stateNeedsInput: string;
  stateInReview: string;
}

export interface Config {
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
    state_backlog?: string;
    state_spec_approved: string;
    state_in_progress: string;
    state_needs_input: string;
    state_in_review: string;
  };
}

const GLOBAL_ENV_PATH = path.join(os.homedir(), '.kbagent', '.env');

export function loadConfig(globalEnvFile?: string): Config {
  dotenv.config({ path: globalEnvFile ?? GLOBAL_ENV_PATH });

  const tomlPath = findTomlFile();
  const proj = parseToml(fs.readFileSync(tomlPath, 'utf8')) as unknown as ProjectToml;

  if (!proj.repo_path) throw new Error('kbagent.toml: repo_path is required');
  if (!proj.worktrees_dir) throw new Error('kbagent.toml: worktrees_dir is required');
  if (!proj.plane) throw new Error('kbagent.toml: [plane] section is required');

  const p = proj.plane;
  if (!p.workspace_slug) throw new Error('kbagent.toml: plane.workspace_slug is required');
  if (!p.project_id) throw new Error('kbagent.toml: plane.project_id is required');
  if (!p.state_spec_approved) throw new Error('kbagent.toml: plane.state_spec_approved is required');
  if (!p.state_in_progress) throw new Error('kbagent.toml: plane.state_in_progress is required');
  if (!p.state_needs_input) throw new Error('kbagent.toml: plane.state_needs_input is required');
  if (!p.state_in_review) throw new Error('kbagent.toml: plane.state_in_review is required');

  return {
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
      stateBacklog: p.state_backlog ?? '',
      stateSpecApproved: p.state_spec_approved,
      stateInProgress: p.state_in_progress,
      stateNeedsInput: p.state_needs_input,
      stateInReview: p.state_in_review,
    },
    planeApiKey: requireEnv('KB_AGENT_PLANE_API_KEY'),
    githubToken: process.env['KB_AGENT_GITHUB_TOKEN'] ?? '',
    claudeOAuthToken: process.env['KB_AGENT_CLAUDE_CODE_OAUTH_TOKEN'] ?? '',
  };
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`${name} is required but not set in ~/.kbagent/.env`);
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
