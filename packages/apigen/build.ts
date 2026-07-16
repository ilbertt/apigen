import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertBuildSuccess,
  cleanDir,
  printBuildOutput,
  setPackageJsonDependencies,
} from '@repo/pack-utils';
import packageJson from './package.json' with { type: 'json' };

const CURRENT_DIR = import.meta.dir;
const ROOT_LICENSE_PATH = join(CURRENT_DIR, '../..', 'LICENSE');
const BUILDER_DIR = join(CURRENT_DIR, 'src/builder');
const PKG_DIR = join(CURRENT_DIR, 'pkg');
const DIST_DIR = join(PKG_DIR, 'dist');
const SRC_DIR = join(CURRENT_DIR, 'src');

// Kept external in the CLI bundle and declared as the optional peer. Typed against
// the real peerDependencies so the list can never drift from package.json.
const CLI_EXTERNAL: Extract<keyof typeof packageJson.peerDependencies, '@electric-sql/pglite'>[] = [
  '@electric-sql/pglite',
];

// Regenerate the parsh command tree first so the bundle can never embed a stale
// one. Reuses the `codegen` script so the command paths stay single-sourced.
console.log('⚙️  Generating command tree...');
await Bun.$`bun run codegen`;

console.log('🧹 Cleaning dist directory...');
await cleanDir({ dir: DIST_DIR });

console.log('📚 Compiling library...');
await Bun.$`bun run build:lib`;

console.log('🔨 Building CLI...');
const cliBuild = await Bun.build({
  entrypoints: ['./src/codegen/cli/main.ts'],
  root: SRC_DIR,
  outdir: DIST_DIR,
  target: 'bun',
  external: [...CLI_EXTERNAL],
});
assertBuildSuccess({ buildResult: cliBuild });
printBuildOutput({ buildResult: cliBuild });

console.log('📄 Copying licenses...');
await copyFile(ROOT_LICENSE_PATH, join(PKG_DIR, 'LICENSE'));
const notice = await Bun.file(join(BUILDER_DIR, 'NOTICE')).text();
const vendorLicense = await Bun.file(join(BUILDER_DIR, 'LICENSE')).text();
await Bun.write(
  join(PKG_DIR, 'NOTICE'),
  `${notice}\n\n--- sql-template-tag (MIT) ---\n\n${vendorLicense}`,
);

console.log('🔄 Updating package.json...');
await setPackageJsonDependencies({
  sourcePackageJsonPath: join(CURRENT_DIR, 'package.json'),
  targetPackageJsonPath: join(PKG_DIR, 'package.json'),
  dependencies: [],
  peerDependencies: [...CLI_EXTERNAL],
});

console.log('✅ Done');
