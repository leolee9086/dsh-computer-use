import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Exercise the real lazy loader with optional dependencies absent, as can
// happen after installation. Its public error must expose the runtime/reason
// and keep the cause without corrupting the string error code.
test('missing C# bridge retains the original resolution error and runtime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-csharp-missing-'));
  try {
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    for (const file of ['csharp.js', 'errors.js']) {
      await copyFile(new URL(`../src/${file}`, import.meta.url), join(directory, file));
    }
    const { loadCSharpFile } = await import(pathToFileURL(join(directory, 'csharp.js')).href);
    await assert.rejects(loadCSharpFile('windows-narrator.cs'), (error) => {
      assert.equal(error.name, 'ComputerUseError');
      assert.equal(error.code, 'COMPUTER_BRIDGE_LOAD_FAILED');
      assert.equal(error.cause?.code, 'MODULE_NOT_FOUND');
      assert.match(error.message, /edge-js could not load in (Node|Electron)/);
      assert.ok(error.message.includes(`ABI ${process.versions.modules}`));
      assert.ok(error.message.includes(error.cause.message));
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
