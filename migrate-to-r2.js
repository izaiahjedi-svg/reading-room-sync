const r2 = require('./r2-storage');

const token = (process.env.GITHUB_TOKEN || '').toString().trim();
const repository = (process.env.GITHUB_REPOSITORY || process.env.GITHUB_REPO || '').toString().trim();
const branch = (process.env.GITHUB_BRANCH || 'data').toString().trim() || 'data';
const prefix = (process.env.GITHUB_DB_PREFIX || 'sync-db').toString().trim().replace(/^\/+|\/+$/g, '') || 'sync-db';

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function githubHeaders() {
  return {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function githubJson(url) {
  const response = await fetch(url, { headers: githubHeaders() });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error('GitHub request failed (' + response.status + '): ' + text.slice(0, 240));
  }
  return response.json();
}

async function main() {
  if (!token) throw new Error('GITHUB_TOKEN is required');
  if (!repository || !repository.includes('/')) throw new Error('GITHUB_REPOSITORY must be owner/repository');
  if (!r2.isR2Configured()) throw new Error('R2_* variables are required');

  const treeUrl = 'https://api.github.com/repos/' + repository + '/git/trees/' + encodeURIComponent(branch) + '?recursive=1';
  const tree = await githubJson(treeUrl);
  if (tree.truncated) console.warn('GitHub tree response was truncated; migration may be incomplete.');

  const files = (tree.tree || []).filter((entry) => entry.type === 'blob' && (entry.path || '').startsWith(prefix + '/'));
  let migrated = 0;
  const failed = [];

  for (const entry of files) {
    try {
      const contentUrl = 'https://api.github.com/repos/' + repository + '/contents/' + entry.path.split('/').map(encodeURIComponent).join('/') + '?ref=' + encodeURIComponent(branch);
      const payload = await githubJson(contentUrl);
      const text = Buffer.from((payload.content || '').replace(/\n/g, ''), 'base64').toString('utf8');
      const value = JSON.parse(text);
      await r2.putJson(entry.path, value);
      migrated++;
      console.log('Migrated ' + entry.path);
    } catch (error) {
      failed.push({ path: entry.path, error: error.message });
      console.error('Failed ' + entry.path + ': ' + error.message);
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
