import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flagValue, positionals } from '../src/cli/atlas.ts';
import { serve } from '../src/cli/serve.ts';
import { cacheDir, extractorFingerprint, pruneStale } from '../src/cli/cache.ts';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-cli-'));
  dirs.push(dir);
  return dir;
}

describe('M8: CLI argument parsing', () => {
  test('flag values are read, and their values are not mistaken for positionals', () => {
    const args = ['main..HEAD', '--view', '-o', 'out.json', '--hops', '3'];
    assert.equal(flagValue(args, '-o'), 'out.json');
    assert.equal(flagValue(args, '--hops'), '3');
    assert.deepEqual(positionals(args), ['main..HEAD'], 'out.json and 3 are values, not targets');
  });

  test('a bare invocation has no positionals', () => {
    assert.deepEqual(positionals(['--view']), []);
  });

  test('-C is treated as a flag with a value', () => {
    assert.deepEqual(positionals(['-C', '/some/repo', 'HEAD~1..HEAD']), ['HEAD~1..HEAD']);
    assert.equal(flagValue(['-C', '/some/repo'], '-C'), '/some/repo');
  });

  test('an absent flag reads as undefined rather than throwing', () => {
    assert.equal(flagValue(['--view'], '--hops'), undefined);
  });
});

describe('M8: static server', () => {
  const bundle = (): string => {
    const dir = tempDir();
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>atlas</title>');
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
    return dir;
  };

  test('serves the bundle, the artifact, and a version stamp', async () => {
    const dir = tempDir();
    const artifact = join(dir, 'graph.json');
    writeFileSync(artifact, '{"meta":{"dialect":"t"}}');
    const server = await serve({ bundleDir: bundle(), artifactPath: artifact });
    try {
      assert.equal((await fetch(server.url)).status, 200);
      assert.equal((await fetch(`${server.url}assets/app.js`)).status, 200);
      const graph = await (await fetch(`${server.url}graph.json`)).json();
      assert.equal((graph as { meta: { dialect: string } }).meta.dialect, 't');
      const version = await (await fetch(`${server.url}version`)).json();
      assert.ok(typeof (version as { mtime: number }).mtime === 'number');
    } finally {
      await server.close();
    }
  });

  test('unknown paths fall back to index.html rather than 404ing the app', async () => {
    const dir = tempDir();
    const artifact = join(dir, 'graph.json');
    writeFileSync(artifact, '{}');
    const server = await serve({ bundleDir: bundle(), artifactPath: artifact });
    try {
      const response = await fetch(`${server.url}some/deep/route`);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /doctype html/);
    } finally {
      await server.close();
    }
  });

  test('path traversal cannot escape the bundle', async () => {
    const dir = tempDir();
    const artifact = join(dir, 'graph.json');
    writeFileSync(artifact, '{}');
    const server = await serve({ bundleDir: bundle(), artifactPath: artifact });
    try {
      const response = await fetch(`${server.url}../../../etc/passwd`);
      // Either refused or served the app shell, never the target file.
      assert.doesNotMatch(await response.text(), /root:/);
    } finally {
      await server.close();
    }
  });

  test('a missing bundle fails with an actionable message', async () => {
    await assert.rejects(
      () => serve({ bundleDir: join(tempDir(), 'nope'), artifactPath: 'x.json' }),
      /npm run build:web/,
    );
  });
});

describe('M8: cache pruning', () => {
  test('entries from other extractor versions are removed', () => {
    const repo = tempDir();
    const dir = cacheDir(repo);
    mkdirSync(dir, { recursive: true });
    const current = join(dir, `bevy-0.19-${extractorFingerprint()}-abc.json`);
    writeFileSync(current, '{}');
    writeFileSync(join(dir, 'bevy-0.19-deadbeef0000-abc.json'), '{}');
    writeFileSync(join(dir, 'bevy-0.19-abc.json'), '{}'); // pre-fingerprint format

    assert.equal(pruneStale(dir), 2);
    assert.deepEqual(readdirSync(dir), [`bevy-0.19-${extractorFingerprint()}-abc.json`]);
    assert.ok(existsSync(current));
  });
});

describe('M8: the atlas binary', () => {
  test('--help lists every documented subcommand', () => {
    const out = execFileSync('./bin/atlas.mjs', ['--help'], { encoding: 'utf8' });
    for (const command of ['diff', 'map', 'extract', 'serve']) {
      assert.match(out, new RegExp(`atlas ${command}`), `${command} missing from help`);
    }
    for (const flag of ['-C', '--view', '--hops', '--json', '--watch']) {
      assert.ok(out.includes(flag), `${flag} missing from help`);
    }
  });

  test('an unknown subcommand exits non-zero with usage', () => {
    assert.throws(
      () => execFileSync('./bin/atlas.mjs', ['bogus'], { encoding: 'utf8', stdio: 'pipe' }),
      /Command failed/,
    );
  });

  test('diff outside a git repository reports that clearly', () => {
    const dir = tempDir();
    try {
      execFileSync('./bin/atlas.mjs', ['diff', '-C', dir], { encoding: 'utf8', stdio: 'pipe' });
      assert.fail('should have exited non-zero');
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? '';
      assert.match(stderr, /not a git repository/);
    }
  });
});
