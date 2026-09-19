import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseToml } from 'smol-toml';

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
  databaseUrl: string;
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
}

const KBAGENT_DIR = path.join(os.homedir(), '.kbagent');
const GLOBAL_ENV_PATH = path.join(KBAGENT_DIR, '.env');

export function loadConfig(globalEnvFile?: string): Config {
  const tomlPath = findTomlFile();
  const proj = parseToml(fs.readFileSync(tomlPath, 'utf8')) as unknown as ProjectToml;

  if (!proj.repo_path) throw new Error('kbagent.toml: repo_path is required');
  if (!proj.worktrees_dir) throw new Error('kbagent.toml: worktrees_dir is required');

  // Secrets load in layers, lowest precedence first: the global file holds
  // account-scoped credentials (one Anthropic account), the project file holds
  // integration-scoped ones (this project's ticket database, GitHub repos). Real
  // environment variables outrank both. Values land in process.env so
  // devcontainer.json's `${localEnv:KB_AGENT_*}` bindings resolve for this project.
  const projectName = proj.name ?? path.basename(proj.repo_path);
  const shellKeys = new Set(Object.keys(process.env));
  applyEnvFile(globalEnvFile ?? GLOBAL_ENV_PATH, shellKeys, globalEnvFile !== undefined);
  applyEnvFile(path.join(KBAGENT_DIR, `${projectName}.env`), shellKeys);

  return {
    projectName,
    repoPath: proj.repo_path,
    worktreesDir: proj.worktrees_dir,
    logFile: proj.log_file ?? path.join(os.homedir(), 'Library', 'Logs', 'kbagent.log'),
    ticketProvider: proj.ticket_provider ?? 'native',
    maxTurns: proj.max_turns ?? 50,
    sleepNoWork: proj.sleep_no_work ?? 15,
    sleepError: proj.sleep_error ?? 300,
    validateCmd: proj.validate_cmd ?? '',
    databaseUrl: requireEnv('KB_AGENT_DATABASE_URL'),
    githubToken: process.env['KB_AGENT_GITHUB_TOKEN'] ?? '',
    claudeOAuthToken: process.env['KB_AGENT_CLAUDE_CODE_OAUTH_TOKEN'] ?? '',
  };
}

// Merge one secrets layer into process.env. Keys already present in the real
// environment are left alone, so an exported variable always wins; otherwise a later
// layer overrides an earlier one.
//
// The default layers are optional, so a missing file is not an error. A path the user
// typed with -f is not: silently ignoring a typo there would start the agent with an
// empty token and fail much further downstream. Errors other than "not found" always
// throw — an unreadable ~/.kbagent/.env would otherwise surface as the misleading
// "KB_AGENT_DATABASE_URL is required".
function applyEnvFile(filePath: string, shellKeys: Set<string>, required = false): void {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' && !required) return;
    throw new Error(`cannot read credentials file ${filePath}: ${code ?? err}`);
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
