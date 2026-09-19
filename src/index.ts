#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig } from './config';
import { NativeProvider } from './provider/native';
import { run } from './daemon';

const program = new Command();

program
  .name('kbagent')
  .description('Autonomous coding agent daemon')
  .option('-f, --file <path>', `credentials file (default: ~/.kbagent/.env)`);

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
    if (cfg.ticketProvider === 'native') {
      provider = new NativeProvider(cfg);
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
