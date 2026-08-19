const fs = require('fs');
const path = require('path');
const r2 = require('./r2-storage');

const cloneDir = path.resolve(process.env.GITHUB_CLONE_DIR || path.join(process.cwd(), '..', 'sync-repo'));
const prefix = (process.env.GITHUB_DB_PREFIX || 'sync-db').toString().trim().replace(/^\/+|\/+$/g, '') || 'sync-db';

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

async function main() {
  if (!r2.isR2Configured()) throw new Error('R2_* variables are required');
  const sourceDir = path.join(cloneDir, prefix);
  if (!fs.existsSync(sourceDir)) throw new Error('Local clone path not found: ' + sourceDir);

  const files = [];
  function collectFiles(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) collectFiles(absolute);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) files.push(absolute);
    }
  }
  collectFiles(sourceDir);
  let migrated = 0;
  const failed = [];

  for (const absolutePath of files) {
    const relativePath = path.relative(cloneDir, absolutePath).replace(/\\/g, '/');
    try {
      const value = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
      await r2.putJson(relativePath, value);
      migrated++;
      console.log('Migrated ' + relativePath);
    } catch (error) {
      failed.push({ path: relativePath, error: error.message });
      console.error('Failed ' + relativePath + ': ' + error.message);
    }
  }

  console.log('Migration complete: ' + migrated + '/' + files.length + ' files migrated.');
  if (failed.length) {
    console.error('Failed files:');
    failed.forEach((entry) => console.error('- ' + entry.path + ': ' + entry.error));
    process.exitCode = 1;
  }
}

main().catch((error) => fail('Migration failed: ' + error.message));
