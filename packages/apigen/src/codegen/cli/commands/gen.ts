import { isAbsolute, join, resolve } from 'node:path';
import { defineCommand } from '@parshjs/core';
import { SQL } from 'bun';
import { z } from 'zod';
import { generateFromDb, generateFromSql } from '../../generate.js';

const DEFAULT_MIGRATIONS_DIR = 'migrations';

async function readMigrations(dir: string): Promise<string> {
  const abs = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
  const files = (await Array.fromAsync(new Bun.Glob('*.sql').scan({ cwd: abs }))).sort();
  if (files.length === 0) {
    throw new Error(`No *.sql migrations found in ${abs}`);
  }
  const parts = await Promise.all(files.map((file) => Bun.file(join(abs, file)).text()));
  return parts.join('\n');
}

async function generateFromDatabaseUrl({
  url,
  moduleSpecifier,
}: {
  url: string;
  moduleSpecifier?: string;
}): Promise<string> {
  const sql = new SQL(url);
  try {
    return await generateFromDb({ db: sql, moduleSpecifier });
  } finally {
    await sql.end();
  }
}

export const command = defineCommand('gen', {
  description: 'Generate api.gen.ts from a running Postgres or from SQL migrations.',
  options: {
    'database-url': {
      schema: z.string().optional(),
      description: 'Connection string of a running Postgres to introspect directly (no PGlite).',
    },
    migrations: {
      schema: z.string().optional(),
      description: `Directory of *.sql migrations to introspect via PGlite (default: ./${DEFAULT_MIGRATIONS_DIR}).`,
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
    const databaseUrl = options['database-url'];
    const migrationsPath = options.migrations;
    if (databaseUrl && migrationsPath) {
      throw new Error('Pass either --database-url or --migrations, not both.');
    }
    const source = databaseUrl
      ? await generateFromDatabaseUrl({ url: databaseUrl, moduleSpecifier: options.module })
      : await generateFromSql({
          migrations: await readMigrations(migrationsPath ?? DEFAULT_MIGRATIONS_DIR),
          moduleSpecifier: options.module,
        });
    const outPath = isAbsolute(options.out) ? options.out : resolve(process.cwd(), options.out);
    await Bun.write(outPath, source);
    print.success(`Wrote ${outPath}`);
  },
});
