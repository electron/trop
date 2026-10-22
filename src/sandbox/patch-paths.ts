// The repository paths a `git format-patch` style patch names, so the server
// can check that a sandbox job only changed files its patches touch. This
// reads the patch text the server itself fetched from GitHub; it never looks
// at anything the job produced.

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

const stripPrefix = (p: string | null, prefix: 'a/' | 'b/') =>
  p?.startsWith(prefix) ? p.slice(2) : null;

/**
 * Every path a patch's diff headers name (old and new names of renames and
 * copies included). Over-approximates: text in the commit message that looks
 * like a header adds paths too, which only widens what the check allows to
 * what the patch author wrote anyway.
 */
export const patchPaths = (patch: string): Set<string> => {
  const paths = new Set<string>();
  const add = (p: string | null) => {
    if (p) paths.add(p);
  };

  for (const line of patch.split('\n').map((l) => l.replace(/\r$/, ''))) {
    let m: RegExpExecArray | null;
    if ((m = /^diff --git (.*)$/.exec(line))) {
      const rest = m[1];
      // Unquoted `a/P b/P` (the same path on both sides).
      const len = (rest.length - 5) / 2;
      if (Number.isInteger(len) && len > 0) {
        const p = rest.slice(2, 2 + len);
        if (rest === `a/${p} b/${p}`) add(p);
      }
      // Quoted `"a/P" "b/Q"`, or one side quoted.
      const quoted = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(
        rest,
      );
      if (quoted) {
        add(stripPrefix(unquoteGitPath(quoted[1]), 'a/'));
        add(stripPrefix(unquoteGitPath(quoted[2]), 'b/'));
      }
    } else if ((m = /^--- (.*)$/.exec(line))) {
      add(stripPrefix(unquoteGitPath(m[1].replace(/\t$/, '')), 'a/'));
    } else if ((m = /^\+\+\+ (.*)$/.exec(line))) {
      add(stripPrefix(unquoteGitPath(m[1].replace(/\t$/, '')), 'b/'));
    } else if ((m = /^(?:rename|copy) (?:from|to) (.*)$/.exec(line))) {
      add(unquoteGitPath(m[1]));
    }
  }
  return paths;
};
