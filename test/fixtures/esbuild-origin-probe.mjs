import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { context } from 'esbuild';

// Real local HTTP reproduction, serving only a generated non-sensitive fixture.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-esbuild-origin-'));
let build;
try {
  build = await context({ stdin: { contents: 'console.log("origin probe")', sourcefile: 'probe.js' },
    outfile: path.join(directory, 'probe.js'), logLevel: 'silent' });
  const server = await build.serve({ servedir: directory, host: '127.0.0.1', port: 0 });
  const response = await fetch(`http://127.0.0.1:${server.port}/probe.js`, { headers: { Origin: 'https://untrusted.example.invalid' } });
  const origin = response.headers.get('access-control-allow-origin');
  console.log(JSON.stringify({ status: response.status, accessControlAllowOrigin: origin }));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /origin probe/);
  assert.equal(origin, null, 'Untrusted web origins must not be granted read access to the build server');
} finally {
  await build?.dispose();
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('factory-esbuild-origin-'));
  await fs.rm(directory, { recursive: true, force: true });
}
