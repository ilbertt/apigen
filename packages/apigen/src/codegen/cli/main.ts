#!/usr/bin/env bun
import { createCli } from '@parshjs/core';
import { commandTree } from './command-tree.gen.js';

const cli = createCli({
  programName: 'apigen',
  programDescription: 'Generate PostgREST-compatible REST API handlers from your Postgres schema.',
  tree: commandTree,
});

declare module '@parshjs/core' {
  interface Register {
    cli: typeof cli;
  }
}

await cli.main();
