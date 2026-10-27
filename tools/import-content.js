import { openAsBlob } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOURCE_URL = 'https://api.az-boxa.aem.live/adobe/sites/helix-azure-da-nx/source/';
const CONTENT_TYPES = {
  '.html': 'text/html',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.css': 'text/css',
  '.js': 'text/javascript',
};

export async function listFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const files = [];
  for (const entry of entries) {
    if (!entry.name.startsWith('.')) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        files.push(...await listFiles(join(directory, entry.name), relativePath));
      } else if (entry.isFile()) {
        files.push(relativePath);
      } else {
        throw new Error(`Unsupported entry (symlink or special file): ${relativePath}`);
      }
    }
  }
  return files;
}

export async function importContent({
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

  let uploaded = 0;
  for (const path of files) {
    const url = `${SOURCE_URL}${path.split('/').map(encodeURIComponent).join('/')}`;
    if (dryRun) {
      console.log(`POST ${url}`);
    } else {
      const type = CONTENT_TYPES[extname(path).toLowerCase()] || 'application/octet-stream';
      const body = await openAsBlob(join(contentDir, path), { type });
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': type,
        },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) {
        const detail = response.headers.get('x-error') || response.statusText;
        await response.body?.cancel();
        throw new Error(`${path}: HTTP ${response.status} ${detail}`);
      }
      await response.body?.cancel();
      uploaded += 1;
      console.log(`[${uploaded}/${files.length}] Uploaded ${path}`);
    }
  }
  console.log(dryRun ? `Dry run: ${files.length} files; nothing uploaded.` : `Uploaded ${uploaded} files.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(`Usage: node tools/${basename(fileURLToPath(import.meta.url))} [--dry-run]
Uploads content/ to the Helix source bus using .hlx/.da-token.json.
Existing destination files may be overwritten. Requires Node.js 22+.`);
  } else if (args.some((arg) => arg !== '--dry-run')) {
    console.error('Unknown argument. Use --help for usage.');
    process.exitCode = 1;
  } else {
    importContent({ dryRun: args.includes('--dry-run') }).catch((error) => {
      console.error(`Import failed: ${error.message}`);
      process.exitCode = 1;
    });
  }
}
