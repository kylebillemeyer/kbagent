import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

export function loadConfig(envFile?: string): Config {
  const envPath = envFile ?? findEnvFile();
  dotenv.config({ path: envPath });

  return {
    repoPath: requireEnv('KB_AGENT_REPO_PATH'),
    worktreesDir: requireEnv('KB_AGENT_WORKTREES_DIR'),
    logFile: process.env['KB_AGENT_LOG_FILE'] ?? path.join(os.homedir(), 'Library', 'Logs', 'kbagent.log'),
    ticketProvider: process.env['KB_AGENT_TICKET_PROVIDER'] ?? 'plane',
    maxTurns: parseInt(process.env['KB_AGENT_MAX_TURNS'] ?? '50', 10),
    sleepNoWork: parseInt(process.env['KB_AGENT_SLEEP_NO_WORK'] ?? '15', 10),
    sleepError: parseInt(process.env['KB_AGENT_SLEEP_ERROR'] ?? '300', 10),
    validateCmd: process.env['KB_AGENT_VALIDATE_CMD'] ?? '',
    plane: {
      baseUrl: process.env['KB_AGENT_PLANE_BASE_URL'] ?? 'https://api.plane.so',
      workspaceSlug: requireEnv('KB_AGENT_PLANE_WORKSPACE_SLUG'),
      projectId: requireEnv('KB_AGENT_PLANE_PROJECT_ID'),
      stateBacklog: process.env['KB_AGENT_PLANE_STATE_BACKLOG'] ?? '',
      stateSpecApproved: requireEnv('KB_AGENT_PLANE_STATE_SPEC_APPROVED'),
      stateInProgress: requireEnv('KB_AGENT_PLANE_STATE_IN_PROGRESS'),
      stateNeedsInput: requireEnv('KB_AGENT_PLANE_STATE_NEEDS_INPUT'),
      stateInReview: requireEnv('KB_AGENT_PLANE_STATE_IN_REVIEW'),
    },
    planeApiKey: requireEnv('KB_AGENT_PLANE_API_KEY'),
    githubToken: process.env['KB_AGENT_GITHUB_TOKEN'] ?? '',
    claudeOAuthToken: process.env['KB_AGENT_CLAUDE_CODE_OAUTH_TOKEN'] ?? '',
  };
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`${name} is required but not set`);
  return val;
}

function findEnvFile(): string {
  let dir = process.cwd();
  for (;;) {
    const envPath = path.join(dir, '.env');
    if (fs.existsSync(envPath)) return envPath;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error('No .env file found in current directory or any parent directory');
    }
    dir = parent;
  }
}
