import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { readReviewPage, FILE_REVIEW_READ_MAX_BYTES } from '../extensions/file-review-read.ts';
import { createExtensionHarness, emitExtensionEvent } from './helpers.js';

async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-review-read-'));
  try {
    await fs.mkdir(path.join(directory, 'src'));
    const original = Array.from({ length: 501 }, (_, i) => `const value${i} = ${i};`).join('\n');
    await fs.writeFile(path.join(directory, 'src/large.ts'), original);
    await run(directory, original);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function reviewer(directory) {
  const branch = [{ type: 'custom', id: 'branch-root', customType: 'unrelated', data: {} }];
  const harness = createExtensionHarness(branch, { cwd: directory });
  await emitExtensionEvent(harness, 'session_start', { reason: 'startup' });
  await harness.tools.find(item => item.name === 'switch_role')
    .execute('role', { role: 'developer-test' }, undefined, undefined, harness.context);
  const tool = harness.tools.find(item => item.name === 'file_review');
  const call = (input, signal) => tool.execute('review', input, signal, undefined, harness.context);
  const complete = fingerprint => call({ action: 'complete', path: 'src/large.ts', fingerprint,
    conclusion: 'keep', rationale: '读取职责已独立拆分，运行时仅负责会话校验与工具接线。' });
  return { harness, branch, call, complete };
}

async function readAll(call, extra = {}) {
  const pages = [];
  let offset = 1;
  do {
    const page = await call({ action: 'read', path: 'src/large.ts', limit: 200, ...extra, offset });
    assert.equal(page.details.ok, true, JSON.stringify(page.details));
    pages.push(page);
    offset = page.details.nextOffset;
  } while (offset !== null);
  return pages;
}

test('built-in pages alone return all original text and authorize exact-version complete', async () => {
  await fixture(async (directory, original) => {
    const { call, complete } = await reviewer(directory);
    const first = await call({ action: 'read', path: 'src/large.ts', limit: 1 });
    const fingerprint = first.details.fingerprint;
    assert.equal((await complete(fingerprint)).details.code, 'FILE_NOT_FULLY_READ');
    const pages = await readAll(call, { fingerprint });
    assert.equal(pages.map(page => page.content.at(-1).text).join(''), original);
    assert.equal((await complete(fingerprint)).details.ok, true);
  });
});

test('action-specific required inputs reject missing, wrong-type and malformed values without recording reviews', async () => {
  await fixture(async directory => {
    const { call, complete } = await reviewer(directory);
    const inventory = await call({ action: 'list', path: '../ignored.ts' });
    assert.equal(inventory.details.ok, true);
    const fingerprint = inventory.details.candidates[0].fingerprint;
    const valid = { action: 'complete', path: 'src/large.ts', fingerprint, conclusion: 'keep', rationale: '职责清晰且边界稳定，无需拆分。' };
    for (const [field, value, code] of [
      ['path', undefined, 'MISSING_PATH'], ['path', 42, 'INVALID_PATH_TYPE'], ['path', ' ', 'EMPTY_PATH'],
      ['fingerprint', undefined, 'MISSING_FINGERPRINT'], ['fingerprint', 42, 'INVALID_FINGERPRINT_TYPE'],
      ['fingerprint', '', 'INVALID_FINGERPRINT_FORMAT'], ['fingerprint', 'old', 'INVALID_FINGERPRINT_FORMAT'],
      ['conclusion', undefined, 'MISSING_CONCLUSION'], ['conclusion', 42, 'INVALID_CONCLUSION_TYPE'],
      ['conclusion', 'split', 'INVALID_CONCLUSION'],
      ['rationale', undefined, 'MISSING_RATIONALE'], ['rationale', 42, 'INVALID_RATIONALE_TYPE'],
      ['rationale', ' ', 'RATIONALE_TOO_SHORT'], ['rationale', '短理由', 'RATIONALE_TOO_SHORT'],
      ['rationale', '理'.repeat(2001), 'RATIONALE_TOO_LONG'],
    ]) {
      const result = await call({ ...valid, [field]: value });
      assert.equal(result.details.ok, false);
      assert.equal(result.details.code, code, field);
      assert.ok(result.details.message);
    }
    for (const [fingerprint, code] of [[42, 'INVALID_FINGERPRINT_TYPE'], ['', 'INVALID_FINGERPRINT_FORMAT']]) {
      assert.equal((await call({ action: 'read', path: valid.path, fingerprint })).details.code, code);
    }
    assert.equal((await complete(fingerprint)).details.code, 'FILE_NOT_FULLY_READ');
    await readAll(call, { fingerprint });
    assert.equal((await complete(fingerprint)).details.ok, true);
  });
});

test('page text preserves mixed physical line endings, BOM, Unicode and empty files', async () => {
  await fixture(async directory => {
    const original = '\ufeff你好\r\n\r仅CR\nfinal';
    await fs.writeFile(path.join(directory, 'src/large.ts'), original);
    const pages = [];
    for (let offset = 1; offset <= 4; offset++) {
      const result = await readReviewPage(directory, { path: 'src/large.ts', offset, limit: 1 });
      assert.equal(result.ok, true);
      pages.push(result.text);
      assert.equal(result.file.lineCount, 4);
      assert.equal(result.eof, offset === 4);
    }
    assert.equal(pages.join(''), original);
    await fs.writeFile(path.join(directory, 'src/empty.ts'), '');
    const empty = await readReviewPage(directory, { path: 'src/empty.ts' });
    assert.equal(empty.ok, true);
    assert.equal(empty.text, '');
    assert.equal(empty.nextOffset, null);
  });
});

test('invalid pagination and unsafe paths never return source or read credit', async () => {
  await fixture(async directory => {
    const { call, complete } = await reviewer(directory);
    const list = await call({ action: 'list' });
    const fingerprint = list.details.candidates[0].fingerprint;
    for (const input of [
      { offset: 0 }, { offset: -1 }, { offset: 1.5 }, { offset: '1' }, { offset: NaN },
      { offset: Infinity }, { offset: Number.MAX_SAFE_INTEGER + 1 },
      { offset: null }, { offset: true }, { limit: null }, { limit: {} },
      { limit: 0 }, { limit: 201 }, { limit: '2' }, { limit: 1.5 },
    ]) {
      assert.equal((await call({ action: 'read', path: 'src/large.ts', ...input })).details.code, 'INVALID_PAGINATION');
    }
    for (const [filePath, code] of [
      [undefined, 'MISSING_PATH'], ['', 'EMPTY_PATH'], ['../outside.ts', 'PATH_OUTSIDE_PROJECT'],
      ['AGENTS.md', 'UNSUPPORTED_FILE'], ['node_modules/pkg.ts', 'UNSUPPORTED_FILE'], ['.git/private.ts', 'UNSUPPORTED_FILE'],
      ['src/missing.ts', 'FILE_NOT_FOUND'],
    ]) {
      assert.equal((await call({ action: 'read', path: filePath })).details.code, code);
    }
    assert.equal((await call({ action: 'read', path: 'src/large.ts', offset: 502 })).details.code, 'OFFSET_OUT_OF_RANGE');
    assert.equal((await call({ action: 'list', limit: 51 })).details.code, 'INVALID_PAGINATION');
    assert.equal((await complete(fingerprint)).details.code, 'FILE_NOT_FULLY_READ');
  });
});

test('symlink files and directories cannot expose either inside or outside source', async () => {
  await fixture(async directory => {
    await fs.symlink(path.join(directory, 'src/large.ts'), path.join(directory, 'src/link.ts'));
    await fs.symlink(path.join(directory, 'src'), path.join(directory, 'linked'), 'dir');
    await fs.symlink(os.tmpdir(), path.join(directory, 'outside'), 'dir');
    for (const filePath of ['src/link.ts', 'linked/large.ts', 'outside/private.ts']) {
      const result = await readReviewPage(directory, { path: filePath });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'SYMLINK_UNSUPPORTED');
      assert.equal('text' in result, false);
    }
  });
});

test('UTF-8 byte cap returns only whole lines and does not credit oversized or truncated lines', async () => {
  await fixture(async directory => {
    const largeLine = '中'.repeat(6000);
    const source = ['first', largeLine, ...Array(499).fill('tail')].join('\n');
    await fs.writeFile(path.join(directory, 'src/large.ts'), source);
    const { call, complete } = await reviewer(directory);
    const first = await call({ action: 'read', path: 'src/large.ts', limit: 200 });
    assert.equal(first.content.at(-1).text, 'first\n');
    assert.equal(first.details.endLine, 1);
    assert.equal(first.details.nextOffset, 2);
    assert.equal(first.details.byteLimited, true);
    assert.ok(first.details.outputBytes <= FILE_REVIEW_READ_MAX_BYTES);
    assert.equal((await call({ action: 'read', path: 'src/large.ts', offset: 2 })).details.code, 'LINE_TOO_LONG');
    for (const offset of [3, 203, 403]) await call({ action: 'read', path: 'src/large.ts', offset, limit: 200 });
    assert.equal((await complete(first.details.fingerprint)).details.code, 'FILE_NOT_FULLY_READ');
    await fs.writeFile(path.join(directory, 'src/large.ts'), 'a'.repeat(FILE_REVIEW_READ_MAX_BYTES - 1) + '\nrest');
    const boundary = await readReviewPage(directory, { path: 'src/large.ts' });
    assert.equal(boundary.ok, true);
    assert.equal(boundary.outputBytes, FILE_REVIEW_READ_MAX_BYTES);
    assert.equal(boundary.endLine, 1);
  });
});

test('mixed file versions cannot combine coverage and stale fingerprint reads return no text', async () => {
  await fixture(async (directory, original) => {
    const { call, complete } = await reviewer(directory);
    const first = await call({ action: 'read', path: 'src/large.ts', limit: 200 });
    await fs.writeFile(path.join(directory, 'src/large.ts'), original.replace('value0', 'valueX'));
    const stale = await call({ action: 'read', path: 'src/large.ts', offset: 201, fingerprint: first.details.fingerprint });
    assert.equal(stale.details.code, 'STALE_VERSION');
    assert.equal((await complete(first.details.fingerprint)).details.code, 'STALE_VERSION');
    const second = await call({ action: 'read', path: 'src/large.ts', offset: 201, limit: 200 });
    await call({ action: 'read', path: 'src/large.ts', offset: 401, limit: 200 });
    assert.equal((await complete(second.details.fingerprint)).details.code, 'FILE_NOT_FULLY_READ');
    await call({ action: 'read', path: 'src/large.ts', limit: 200 });
    assert.equal((await complete(second.details.fingerprint)).details.ok, true);
  });
});

test('changes during filesystem read fail without returning raw text', async t => {
  await fixture(async directory => {
    const originalRead = fs.readFile;
    const target = await fs.realpath(path.join(directory, 'src/large.ts'));
    t.mock.method(fs, 'readFile', async (...args) => {
      const bytes = await originalRead(...args);
      if (args[0]?.fd !== undefined) await fs.writeFile(target, 'changed');
      return bytes;
    });
    syncBuiltinESMExports();
    try {
      const result = await readReviewPage(directory, { path: 'src/large.ts' });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'FILE_CHANGED_DURING_READ');
      assert.equal('text' in result, false);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
});

test('invalid UTF-8 is a structured failure, including incomplete three-byte sequences', async () => {
  await fixture(async directory => {
    for (const bytes of [Buffer.from([0xff]), Buffer.from([0xf0, 0x90, 0x80])]) {
      await fs.writeFile(path.join(directory, 'src/invalid.ts'), bytes);
      const result = await readReviewPage(directory, { path: 'src/invalid.ts' });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'UNSUPPORTED_ENCODING');
    }
  });
});

test('session shutdown or branch replacement during read discards both text and coverage', async () => {
  for (const transition of ['shutdown', 'branch', 'session-id']) {
    await fixture(async directory => {
      const { harness, branch, call, complete } = await reviewer(directory);
      const pending = call({ action: 'read', path: 'src/large.ts', limit: 200 });
      if (transition === 'shutdown') await emitExtensionEvent(harness, 'session_shutdown', {});
      else if (transition === 'branch') branch.splice(0, branch.length, { id: 'other-branch', type: 'custom', customType: 'unrelated', data: {} });
      else harness.context.sessionManager.getSessionId = () => 'other-session';
      const result = await pending;
      assert.equal(result.details.code, 'STALE_SESSION', transition);
      assert.equal('fingerprint' in result.details, false);
      await emitExtensionEvent(harness, 'session_start', { reason: 'startup' });
      await harness.tools.find(item => item.name === 'switch_role')
        .execute('restore-role', { role: 'developer-test' }, undefined, undefined, harness.context);
      const listed = await call({ action: 'list' });
      assert.equal(listed.details.ok, true, JSON.stringify(listed.details));
      assert.equal((await complete(listed.details.candidates[0].fingerprint)).details.code, 'FILE_NOT_FULLY_READ');
    });
  }
});

test('fully rereading a changed version updates inventory before complete without an extra list', async () => {
  await fixture(async (directory, original) => {
    const { call, complete } = await reviewer(directory);
    await call({ action: 'read', path: 'src/large.ts', limit: 200 });
    await fs.writeFile(path.join(directory, 'src/large.ts'), original.replace('value0', 'valueX'));
    const pages = await readAll(call);
    assert.equal((await complete(pages[0].details.fingerprint)).details.ok, true);
  });
});

test('cancellation before or during reading never credits a page', async () => {
  await fixture(async directory => {
    const { call, complete } = await reviewer(directory);
    const list = await call({ action: 'list' });
    for (const when of ['before', 'during']) {
      const controller = new AbortController();
      if (when === 'before') controller.abort();
      const pending = call({ action: 'read', path: 'src/large.ts', limit: 200 }, controller.signal);
      if (when === 'during') controller.abort();
      assert.equal((await pending).details.code, 'READ_ABORTED');
    }
    for (const offset of [201, 401]) await call({ action: 'read', path: 'src/large.ts', offset, limit: 200 });
    assert.equal((await complete(list.details.candidates[0].fingerprint)).details.code, 'FILE_NOT_FULLY_READ');
  });
});

test('read obeys the existing architect and recovery gates', async () => {
  await fixture(async directory => {
    const { harness, call } = await reviewer(directory);
    await harness.tools.find(item => item.name === 'switch_role')
      .execute('architect', { role: 'architect' }, undefined, undefined, harness.context);
    assert.equal((await call({ action: 'read', path: 'src/large.ts' })).details.code, 'ARCHITECT_CANNOT_REVIEW');
    const recovery = createExtensionHarness([{ type: 'custom', id: 'recovery', customType: 'pi-init-role-recovery',
      data: { status: 'pending' } }], { cwd: directory });
    await emitExtensionEvent(recovery, 'session_start', { reason: 'startup' });
    const result = await recovery.tools.find(item => item.name === 'file_review')
      .execute('read', { action: 'read', path: 'src/large.ts' }, undefined, undefined, recovery.context);
    assert.equal(result.details.code, 'ROLE_RECOVERY_PENDING');
  });
});

test('a symlink swapped in after path checks cannot return a different file', async t => {
  await fixture(async directory => {
    const target = await fs.realpath(path.join(directory, 'src/large.ts'));
    const other = path.join(directory, 'src/other.ts');
    await fs.writeFile(other, 'different source, never returned');
    const originalOpen = fs.open;
    t.mock.method(fs, 'open', async (filePath, ...args) => {
      if (filePath === target) {
        await fs.rename(target, `${target}.old.ts`);
        await fs.symlink(other, target);
      }
      return originalOpen(filePath, ...args);
    });
    syncBuiltinESMExports();
    try {
      const result = await readReviewPage(directory, { path: 'src/large.ts' });
      assert.equal(result.ok, false);
      assert.ok(['SYMLINK_UNSUPPORTED', 'FILE_CHANGED_DURING_READ'].includes(result.code));
      assert.equal('text' in result, false);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
});

test('read rejects case variants of excluded inventory directories', async () => {
  await fixture(async directory => {
    for (const name of ['NODE_MODULES', 'Vendor', '.GIT']) {
      await fs.mkdir(path.join(directory, name));
      await fs.writeFile(path.join(directory, name, 'hidden.ts'), 'private source');
      const result = await readReviewPage(directory, { path: name + '/hidden.ts' });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'UNSUPPORTED_FILE');
      assert.equal('text' in result, false);
    }
  });
});

test('native and built-in pages share exact-version coverage without crediting gaps', async () => {
  await fixture(async directory => {
    const { harness, call, complete } = await reviewer(directory);
    const first = await call({ action: 'read', path: 'src/large.ts', limit: 200 });
    await emitExtensionEvent(harness, 'tool_result', {
      type: 'tool_result', toolCallId: 'native-page', toolName: 'read',
      input: { path: 'src/large.ts', offset: 201, limit: 200 },
      content: [], details: undefined, isError: false,
    });
    await call({ action: 'read', path: 'src/large.ts', offset: 402, limit: 200 });
    assert.equal((await complete(first.details.fingerprint)).details.code, 'FILE_NOT_FULLY_READ');
    await call({ action: 'read', path: 'src/large.ts', offset: 401, limit: 1 });
    assert.equal((await complete(first.details.fingerprint)).details.ok, true);
  });
});

