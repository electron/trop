// Reading the patches trop backports, on the trusted server.
//
// A commit's `.patch` (format-patch output) mixes its message, which the PR
// author controls and reviewers rarely read closely, with its diff. `git am`
// takes the first line of the message that looks like the start of a patch
// as where the patch begins, and applies any diff after it, including one
// written into the message. So the message never goes near git:
//  - the commit's diff is cut out of its `.patch` with the help of its
//    `.diff` (which has no message, so its file headers can be trusted, but
//    also no binary data, which the `.patch` has);
//  - the job applies that diff alone, wrapped in an mbox with a fixed
//    message (backportMbox);
//  - the server derives the commit message from the `.patch` itself, the way
//    `git am` always has (commitMessage), and sets it when it creates the
//    commit.

const C_ESCAPES: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  '"': 0x22,
  '\\': 0x5c,
};

/**
 * Undoes git's C-style quoting of a path (`"a/caf\303\251"`); returns other
 * strings unchanged, and null for a malformed quoted string.
 */
export const unquoteGitPath = (s: string): string | null => {
  if (!s.startsWith('"')) return s;
  if (s.length < 2 || !s.endsWith('"')) return null;
  const bytes: number[] = [];
  const body = s.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') return null;
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const next = body[++i];
    if (next === undefined) return null;
    if (next in C_ESCAPES) {
      bytes.push(C_ESCAPES[next]);
    } else if (/^[0-3][0-7]{2}$/.test(body.slice(i, i + 3))) {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else {
      return null;
    }
  }
  return Buffer.from(bytes).toString('utf8');
};

const QUOTED_HEADER = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/;

const stripPrefix = (p: string | null, prefix: 'a/' | 'b/') =>
  p?.startsWith(prefix) ? p.slice(2) : null;

const lines = (text: string) =>
  text.split('\n').map((l) => l.replace(/\r$/, ''));

const DIFF_HEADER = 'diff --git ';

/** One file of a diff, from its extended header lines only. */
export interface DiffFile {
  /** The `diff --git` line, verbatim. */
  header: string;
  /** Path before and after; undefined for an added or deleted file. */
  oldPath?: string;
  newPath?: string;
  /** Object ids from the `index` line (usually abbreviated). */
  preimage?: string;
  postimage?: string;
  oldMode?: string;
  newMode?: string;
}

/**
 * The files of a diff (git's own diff output: no commit message). Only the
 * extended header lines of each file are read, never hunk content, which
 * cannot start with `diff --git` and so cannot start a file either.
 */
export const diffFiles = (diff: string): DiffFile[] => {
  const files: (DiffFile & { inHeader: boolean })[] = [];
  let file: (DiffFile & { inHeader: boolean }) | null = null;
  for (const line of lines(diff)) {
    let m: RegExpExecArray | null;
    if (line.startsWith(DIFF_HEADER)) {
      file = { header: line, inHeader: true };
      files.push(file);
      const rest = line.slice(DIFF_HEADER.length);
      const len = (rest.length - 5) / 2;
      const p = Number.isInteger(len) && len > 0 ? rest.slice(2, 2 + len) : '';
      if (p && rest === `a/${p} b/${p}`) {
        file.oldPath = p;
        file.newPath = p;
      } else if ((m = QUOTED_HEADER.exec(rest))) {
        file.oldPath = stripPrefix(unquoteGitPath(m[1]), 'a/') ?? undefined;
        file.newPath = stripPrefix(unquoteGitPath(m[2]), 'b/') ?? undefined;
      }
      continue;
    }
    if (!file?.inHeader) continue;
    if (
      line.startsWith('@@') ||
      line.startsWith('GIT binary patch') ||
      line.startsWith('Binary files ')
    ) {
      file.inHeader = false;
    } else if ((m = /^old mode ([0-7]{6})$/.exec(line))) {
      file.oldMode = m[1];
    } else if ((m = /^new mode ([0-7]{6})$/.exec(line))) {
      file.newMode = m[1];
    } else if ((m = /^deleted file mode ([0-7]{6})$/.exec(line))) {
      file.oldMode = m[1];
      file.newPath = undefined;
    } else if ((m = /^new file mode ([0-7]{6})$/.exec(line))) {
      file.newMode = m[1];
      file.oldPath = undefined;
    } else if ((m = /^(rename|copy) from (.*)$/.exec(line))) {
      file.oldPath = unquoteGitPath(m[2]) ?? undefined;
    } else if ((m = /^(rename|copy) to (.*)$/.exec(line))) {
      file.newPath = unquoteGitPath(m[2]) ?? undefined;
    } else if (
      (m = /^index ([0-9a-f]{4,64})\.\.([0-9a-f]{4,64})(?: ([0-7]{6}))?$/.exec(
        line,
      ))
    ) {
      file.preimage = /^0+$/.test(m[1]) ? undefined : m[1];
      file.postimage = /^0+$/.test(m[2]) ? undefined : m[2];
      if (m[3]) file.oldMode = file.newMode = m[3];
    } else if ((m = /^--- (.*)$/.exec(line))) {
      const p = m[1].replace(/\t$/, '');
      if (p === '/dev/null') file.oldPath = undefined;
      else file.oldPath = stripPrefix(unquoteGitPath(p), 'a/') ?? file.oldPath;
    } else if ((m = /^\+\+\+ (.*)$/.exec(line))) {
      const p = m[1].replace(/\t$/, '');
      if (p === '/dev/null') file.newPath = undefined;
      else file.newPath = stripPrefix(unquoteGitPath(p), 'b/') ?? file.newPath;
    }
  }
  return files.map(({ inHeader: _, ...f }) => f);
};

/** Every path a diff touches: old and new names alike. */
export const diffPaths = (diff: string) => {
  const paths = new Set<string>();
  for (const f of diffFiles(diff)) {
    if (f.oldPath) paths.add(f.oldPath);
    if (f.newPath) paths.add(f.newPath);
  }
  return paths;
};

/**
 * Whether git's mailinfo takes `line` as the start of the patch (its
 * patchbreak()): `diff -`, `Index: `, `--- <name>`, or `---` and blanks.
 */
const isPatchBreak = (line: string) => {
  if (line.startsWith('diff -') || line.startsWith('Index: ')) return true;
  if (!line.startsWith('---')) return false;
  if (line[3] === ' ' && line.length > 4 && !/\s/.test(line[4])) return true;
  return /^---\s*$/.test(line);
};

export class PatchError extends Error {}

/**
 * Splits a commit's `.patch` into the part before its diff (mail headers,
 * message, `---`, diffstat) and its diff: the last `diff --git` sections of
 * the patch, which must match the trusted `.diff`'s file headers one for
 * one. A diff written into the message comes before them and is dropped;
 * no hunk line can start with `diff --git`, so none can end up in between.
 *
 * Throws PatchError if the patch's diff doesn't line up with `.diff`.
 */
export const splitPatch = (patch: string, trustedDiff: string) => {
  const expected = diffFiles(trustedDiff).map((f) => f.header);
  const patchLines = patch.split('\n');
  const starts: number[] = [];
  for (const [i, line] of patchLines.entries()) {
    if (line.replace(/\r$/, '').startsWith(DIFF_HEADER)) starts.push(i);
  }
  // A commit without changes: `git am` fails on its empty diff, as it
  // always has.
  if (expected.length === 0) return { head: patchLines, diff: '' };
  if (starts.length < expected.length) {
    throw new PatchError('the patch has fewer files than its diff');
  }
  const own = starts.slice(starts.length - expected.length);
  for (const [k, i] of own.entries()) {
    if (patchLines[i].replace(/\r$/, '') !== expected[k]) {
      throw new PatchError('the patch does not match its diff');
    }
  }
  return {
    head: patchLines.slice(0, own[0]),
    diff: patchLines.slice(own[0]).join('\n'),
  };
};

/**
 * The mbox the job applies with `git am -3 --keep-cr`: a fixed message and
 * the commit's diff, exactly as GitHub serves it in the `.patch` (binary
 * data, CRs and the trailing signature included).
 */
export const backportMbox = (diff: string) =>
  [
    'From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001',
    'From: trop <trop@localhost>',
    'Date: Thu, 1 Jan 1970 00:00:00 +0000',
    'Subject: [PATCH] backport',
    '',
    '---',
    diff.endsWith('\n') ? diff : `${diff}\n`,
  ].join('\n');

// RFC 2047 encoded words, as format-patch writes non-ASCII headers.
const decodeHeader = (value: string) =>
  value
    .replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(
      /=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g,
      (word, charset: string, encoding: string, text: string) => {
        if (!/^(utf-8|us-ascii|iso-8859-1)$/i.test(charset)) return word;
        const bytes =
          encoding.toUpperCase() === 'B'
            ? Buffer.from(text, 'base64')
            : Buffer.from(
                text
                  .replace(/_/g, ' ')
                  .replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) =>
                    String.fromCharCode(parseInt(h, 16)),
                  ),
                'latin1',
              );
        return bytes.toString(/^utf-8$/i.test(charset) ? 'utf8' : 'latin1');
      },
    );

/** mailinfo's cleanup_subject(): drops `Re:`, `[...]`, blanks and colons. */
const cleanupSubject = (subject: string) => {
  let s = subject;
  for (;;) {
    if (/^[Rr][Ee]:/.test(s) && s.length > 3) s = s.slice(3);
    else if (/^[ \t:]/.test(s)) s = s.slice(1);
    else if (s.startsWith('[') && s.includes(']'))
      s = s.slice(s.indexOf(']') + 1);
    else break;
  }
  return s.trim();
};

/** git's strbuf_stripspace() without comment stripping. */
const stripspace = (text: string) => {
  const out: string[] = [];
  let blank = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (line === '') {
      blank++;
      continue;
    }
    if (blank && out.length) out.push('');
    blank = 0;
    out.push(line);
  }
  return out.length ? `${out.join('\n')}\n` : '';
};

/**
 * The commit message `git am` makes from a `.patch` (format-patch output),
 * computed here rather than taken from anything the job returns: the
 * unfolded, decoded Subject without `[PATCH]` and other leading brackets,
 * then the message up to mailinfo's first patch break, with in-body
 * `Subject:`/`From:`/`Date:` lines at its start taken out of it, and
 * whitespace cleaned up as `git am` does. And the author from the `From:`
 * header; unlike `git am`, never from an in-body `From:` line, and none (a
 * PatchError for the caller) if the name or address has a control
 * character or angle bracket.
 */
export const commitMessage = (patchHead: string[]) => {
  const lines = patchHead.map((l) => l.replace(/\r$/, ''));
  const headerEnd = lines.findIndex((l) => l === '');
  const headers = headerEnd < 0 ? lines : lines.slice(0, headerEnd);
  const body = headerEnd < 0 ? [] : lines.slice(headerEnd + 1);

  // Unfold the mail headers.
  const unfolded: string[] = [];
  for (const line of headers) {
    if (/^[ \t]/.test(line) && unfolded.length) {
      unfolded[unfolded.length - 1] += ` ${line.slice(1).replace(/\s+$/, '')}`;
    } else {
      unfolded.push(line.replace(/\s+$/, ''));
    }
  }
  const header = (name: string) =>
    unfolded
      .find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))
      ?.slice(name.length + 1)
      .trim();
  let subject = decodeHeader(header('Subject') ?? '');

  const message: string[] = [];
  let inBodyHeaders = true;
  for (const line of body) {
    if (inBodyHeaders) {
      if (line === '') continue;
      const m = /^(From|Subject|Date):\s*(.*)$/i.exec(line);
      if (m) {
        if (m[1].toLowerCase() === 'subject') subject = decodeHeader(m[2]);
        // An in-body From: is dropped from the message as `git am` does,
        // but unlike `git am` it never changes the author: GitHub's patches
        // never carry one, so it can only be a message crediting someone
        // else.
        continue;
      }
      inBodyHeaders = false;
    }
    if (isPatchBreak(line)) break;
    message.push(line);
  }

  let author: { name: string; email: string } | undefined;
  const m = /^(.*?)\s*<([^>]*)>\s*$/.exec(decodeHeader(header('From') ?? ''));
  if (m) {
    const name = (
      /^"(.*)"$/.test(m[1].trim())
        ? m[1].trim().slice(1, -1).replace(/\\(.)/g, '$1')
        : m[1]
    ).trim();
    const email = m[2].trim();
    // It ends up in a Co-authored-by trailer: one line, one address.
    // eslint-disable-next-line no-control-regex
    const unsafe = /[\u0000-\u001f\u007f<>]/;
    if (!unsafe.test(name) && !unsafe.test(email) && email) {
      author = { name, email };
    }
  }
  return {
    message: stripspace(
      `${cleanupSubject(subject)}\n\n${message.join('\n')}`,
    ).trim(),
    author,
  };
};
