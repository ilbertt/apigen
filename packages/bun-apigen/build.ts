import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertBuildSuccess,
  cleanDir,
  printBuildOutput,
  setPackageJsonDependencies,
} from '@repo/pack-utils';

const CURRENT_DIR = import.meta.dir;
const ROOT_LICENSE_PATH = join(CURRENT_DIR, '../..', 'LICENSE');

const PKG_DIR = join(CURRENT_DIR, 'pkg');
const DIST_DIR = join(PKG_DIR, 'dist');
const SRC_DIR = join(CURRENT_DIR, 'src');
const LICENSE_DESTINATION_PATH = join(PKG_DIR, 'LICENSE');

// Runtime dependencies to keep external in the published bundle (resolved from
// this package.json, `catalog:` included). Empty for now — the placeholder
// library has no runtime dependencies.
const RUNTIME_DEPENDENCIES: string[] = [];

console.log('🧹 Cleaning dist directory...');
await cleanDir({ dir: DIST_DIR });

console.log('🔨 Building library...');
const buildResult = await Bun.build({
  entrypoints: ['./src/index.ts'],
  root: SRC_DIR,
  outdir: DIST_DIR,
  target: 'bun',
  external: [...RUNTIME_DEPENDENCIES],
});
assertBuildSuccess({ buildResult });
printBuildOutput({ buildResult });

console.log('📚 Compiling declarations...');
await Bun.$`bun run build:lib`;

console.log('📄 Copying license...');
await copyFile(ROOT_LICENSE_PATH, LICENSE_DESTINATION_PATH);

console.log('🔄 Updating package.json...');
await setPackageJsonDependencies({
  sourcePackageJsonPath: join(CURRENT_DIR, 'package.json'),
  targetPackageJsonPath: join(PKG_DIR, 'package.json'),
  dependencies: RUNTIME_DEPENDENCIES,
});

console.log('✅ Done');
