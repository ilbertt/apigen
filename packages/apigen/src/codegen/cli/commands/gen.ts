import { isAbsolute, join, resolve } from 'node:path';
import { defineCommand } from '@parshjs/core';
import { z } from 'zod';
import { generateFromSql } from '../../generate.js';

async function readMigrations(dir: string): Promise<string> {
  const abs = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
  const files = (await Array.fromAsync(new Bun.Glob('*.sql').scan({ cwd: abs }))).sort();
  if (files.length === 0) {
    throw new Error(`No *.sql migrations found in ${abs}`);
  }
  const parts = await Promise.all(files.map((file) => Bun.file(join(abs, file)).text()));
  return parts.join('\n');
}

export const command = defineCommand('gen', {
  description: 'Generate api.gen.ts from your Postgres migrations.',
  options: {
    migrations: {
      schema: z.string().default('migrations'),
      description: 'Directory of *.sql migrations (applied in filename order).',
    },
    out: {
      schema: z.string().default('api.gen.ts'),
      description: 'Output file.',
    },
    module: {
      schema: z.string().optional(),
      description: 'Runtime import specifier for the generated file (default @ilbertt/apigen).',
    },
  },
  handler: async ({ options, print }) => {
    const migrations = await readMigrations(options.migrations);
    const source = await generateFromSql({ migrations, moduleSpecifier: options.module });
    const outPath = isAbsolute(options.out) ? options.out : resolve(process.cwd(), options.out);
    await Bun.write(outPath, source);
    print.success(`Wrote ${outPath}`);
  },
});
