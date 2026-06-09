#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig } from './config';
import { PlaneProvider } from './provider/plane';
import { run } from './daemon';

const program = new Command();

program
  .name('kbagent')
  .description('Autonomous coding agent daemon')
  .option('-f, --file <path>', 'config .env file (default: walks up from cwd)');

program
  .command('daemon')
  .alias('run')
  .description('Start the agent daemon')
  .action(async () => {
    const opts = program.opts<{ file?: string }>();
    let cfg;
    try {
      cfg = loadConfig(opts.file);
    } catch (err) {
      console.error(`load config: ${err}`);
      process.exit(1);
    }

    let provider;
    if (cfg.ticketProvider === 'plane') {
      provider = new PlaneProvider(cfg);
    } else {
      console.error(`unknown ticket provider: ${cfg.ticketProvider}`);
      process.exit(1);
    }

    try {
      await provider.checkDeps();
    } catch (err) {
      console.error(String(err));
      process.exit(1);
    }

    const ac = new AbortController();
    const stop = () => ac.abort();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    await run(cfg, provider, ac.signal);
  });

program.parse(process.argv);
