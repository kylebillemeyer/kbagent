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
    repoPath: requireEnv('REPO_PATH'),
    worktreesDir: requireEnv('WORKTREES_DIR'),
    logFile: process.env['LOG_FILE'] ?? path.join(os.homedir(), 'Library', 'Logs', 'kbagent.log'),
    ticketProvider: process.env['TICKET_PROVIDER'] ?? 'plane',
    maxTurns: parseInt(process.env['MAX_TURNS'] ?? '50', 10),
    sleepNoWork: parseInt(process.env['SLEEP_NO_WORK'] ?? '15', 10),
    sleepError: parseInt(process.env['SLEEP_ERROR'] ?? '300', 10),
    validateCmd: process.env['VALIDATE_CMD'] ?? '',
    plane: {
      baseUrl: process.env['PLANE_BASE_URL'] ?? 'https://api.plane.so',
      workspaceSlug: requireEnv('PLANE_WORKSPACE_SLUG'),
      projectId: requireEnv('PLANE_PROJECT_ID'),
      stateBacklog: process.env['PLANE_STATE_BACKLOG'] ?? '',
      stateSpecApproved: requireEnv('PLANE_STATE_SPEC_APPROVED'),
      stateInProgress: requireEnv('PLANE_STATE_IN_PROGRESS'),
      stateNeedsInput: requireEnv('PLANE_STATE_NEEDS_INPUT'),
      stateInReview: requireEnv('PLANE_STATE_IN_REVIEW'),
    },
    planeApiKey: requireEnv('PLANE_API_KEY'),
    githubToken: process.env['GITHUB_TOKEN'] ?? '',
    claudeOAuthToken: process.env['CLAUDE_CODE_OAUTH_TOKEN'] ?? '',
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
