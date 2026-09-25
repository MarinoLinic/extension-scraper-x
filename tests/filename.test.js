import { describe, it, expect } from 'vitest';
import { XA } from './helpers/load.js';

const { expandTemplate, sanitizeFilename, filenameFor } = XA.filename;

const ctx = {
  source: { type: 'profile', label: '@Alice posts', handle: 'Alice', tab: 'posts', key: 'profile:alice:posts' },
  run: { id: 'run_abc123', stats: { posts: 42 } },
  date: new Date('2024-05-06T07:08:09'),
  ext: 'json'
};

describe('filename tokens', () => {
  it('expands all documented tokens', () => {
    const out = expandTemplate('%type;%source;%handle;%title;%tab;%date;%time;%datetime;%num;%run;%ext', ctx);
    expect(out).toBe('profile;profile alice posts;Alice;@Alice posts;posts;2024-05-06;070809;2024-05-06_070809;42;run_abc123;json');
  });

  it('applies the default template shape', () => {
    expect(filenameFor(ctx, true)).toBe('x_profile_Alice_2024-05-06_42.json');
  });

  it('falls back deterministically for missing tokens', () => {
    const out = expandTemplate('%type_%handle_%title_%tab_%num', { ext: 'json' });
    expect(out).toBe('archive_x_archive_posts_0');
  });
});

describe('extension and suffix handling', () => {
  it('does not duplicate the extension when %ext is embedded in the template', () => {
    expect(filenameFor({ ...ctx, template: 'archive_%num_%ext', ext: 'json' }))
      .toBe('archive_42_json');
  });

  it('appends the extension when the template lacks it', () => {
    expect(filenameFor({ ...ctx, template: 'archive_%num', ext: 'json' }))
      .toBe('archive_42.json');
  });

  it('does not duplicate an extension already written in the template', () => {
    expect(filenameFor({ ...ctx, template: 'archive_%num.json', ext: 'json' }))
      .toBe('archive_42.json');
  });

  it('places _snapshot before the automatically appended extension', () => {
    expect(filenameFor({ ...ctx, template: 'archive_%num', ext: 'json', suffix: '_snapshot' }))
      .toBe('archive_42_snapshot.json');
  });

  it('places _snapshot before an extension already in the template', () => {
    expect(filenameFor({ ...ctx, template: 'archive_%num.json', ext: 'json', suffix: '_snapshot' }))
      .toBe('archive_42_snapshot.json');
  });

  it('appends the snapshot suffix deterministically when %ext is embedded', () => {
    expect(filenameFor({ ...ctx, template: 'archive_%num_%ext', ext: 'json', suffix: '_snapshot' }))
      .toBe('archive_42_json_snapshot');
  });
});

describe('filename sanitization', () => {
  it('strips Windows-illegal characters', () => {
    expect(sanitizeFilename('a<b>c:d"e/f\\g|h?i*j')).toBe('a b c d e f g h i j');
  });

  it('removes path traversal segments', () => {
    const out = sanitizeFilename('../../etc/passwd');
    expect(out).not.toMatch(/\.\./);
    expect(out).not.toMatch(/[\\/]/);
  });

  it('escapes Windows reserved device names', () => {
    for (const name of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9']) {
      expect(sanitizeFilename(name)).not.toBe(name);
      expect(sanitizeFilename(name)).toMatch(/^_/);
    }
    expect(sanitizeFilename('console')).toBe('console');
  });

  it('trims trailing dots and spaces and collapses whitespace', () => {
    expect(sanitizeFilename('  my   file  . ')).toBe('my file');
  });

  it('returns a non-empty fallback', () => {
    expect(sanitizeFilename('')).toBe('x-archive');
    expect(sanitizeFilename('???')).toBe('x-archive');
  });

  it('caps length', () => {
    expect(sanitizeFilename('x'.repeat(400)).length).toBeLessThanOrEqual(150);
  });

  it('sanitizes token values containing illegal chars', () => {
    const out = expandTemplate('%title', {
      source: { label: 'Search "a/b\\c:*?"' }, ext: 'json'
    });
    expect(out).not.toMatch(/[\\/:*?"]/);
    expect(out.length).toBeGreaterThan(0);
  });
});
