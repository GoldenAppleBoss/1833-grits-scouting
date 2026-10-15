import { mkdir, writeFile } from 'node:fs/promises';
// Protected application files are bundled with the function, not published by the CDN.
await mkdir('dist', { recursive: true });
await writeFile('dist/robots.txt', 'User-agent: *\nDisallow: /\n');
console.log('Vercel output prepared; protected routes are served by api/index.mjs.');
