import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listFiles } from './import-content.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SITE_URL = 'https://api.az-boxa.aem.live/adobe/sites/helix-azure-da-nx';

export async function publishContent({
  contentDir = join(ROOT, 'content'),
  tokenFile = join(ROOT, '.hlx/.da-token.json'),
  dryRun = false,
} = {}) {
  const files = await listFiles(contentDir);
  if (!files.length) throw new Error(`No files found in ${contentDir}`);

  let token;
  if (!dryRun) {
    const credentials = JSON.parse(await readFile(tokenFile, 'utf8'));
    token = credentials.access_token;
    if (typeof token !== 'string' || !token.trim()) {
      throw new Error(`Missing access_token in ${tokenFile}`);
    }
  }

  let published = 0;
  let skipUntil = 'ja/index.html';
  for (const file of files) {
    published += 1;
    if (file === skipUntil) {
      skipUntil = null;
    }
    if (!skipUntil) {
      const path = file.replace(/\.html$/i, '').split('/').map(encodeURIComponent).join('/');
      for (const action of ['preview', 'live']) {
        const url = `${SITE_URL}/${action}/${path}`;
        console.log(`POST ${url}`);
        if (!dryRun) {
          const response = await fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            redirect: 'error',
            signal: AbortSignal.timeout(120_000),
          });
          if (!response.ok) {
            const detail = response.headers.get('x-error') || response.statusText;
            await response.body?.cancel();
            throw new Error(`${file} (${action}): HTTP ${response.status} ${detail}`);
          }
          await response.body?.cancel();
        }
      }
      if (!dryRun) console.log(`[${published}/${files.length}] Previewed and published ${file}`);
    }
  }
  console.log(dryRun
    ? `Dry run: ${files.length} files; nothing previewed or published.`
    : `Previewed and published ${published} files.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(`Usage: node tools/publish-content.js [--dry-run]
Previews and publishes content/ paths using .hlx/.da-token.json.
HTML paths are sent without the .html extension. Requires Node.js 22+.`);
  } else if (args.some((arg) => arg !== '--dry-run')) {
    console.error('Unknown argument. Use --help for usage.');
    process.exitCode = 1;
  } else {
    publishContent({ dryRun: args.includes('--dry-run') }).catch((error) => {
      console.error(`Publish failed: ${error.message}`);
      process.exitCode = 1;
    });
  }
}
