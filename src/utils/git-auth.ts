import { simpleGit, SimpleGit } from 'simple-git';

const GITHUB_ORIGIN = 'https://github.com/';

/**
 * The credential-free https URL of a GitHub repository. This is what trop
 * stores as a remote URL, so that no token ever lands in a `.git/config`.
 */
export const githubRemoteUrl = (slug: string) => `${GITHUB_ORIGIN}${slug}.git`;

/**
 * Environment variables that make a git child process authenticate to
 * `origin` (by default https://github.com/) with a GitHub App installation
 * token.
 *
 * The token travels in an `http.<url>.extraHeader` set through git's
 * GIT_CONFIG_COUNT/KEY/VALUE environment, not on the command line (argv is
 * world-readable in /proc/<pid>/cmdline) and not in a config file (it would
 * outlive the job in the clone or the shared cache). The header is scoped to
 * `origin` so git never sends it to any other host.
 *
 * Returns no auth variables for an empty token, so that public repositories
 * can be fetched anonymously (as the specs do).
 */
export const gitAuthEnv = (
  token: string,
  origin = GITHUB_ORIGIN,
): Record<string, string> => {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  if (!token) return env;

  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  env.GIT_CONFIG_COUNT = '1';
  env.GIT_CONFIG_KEY_0 = `http.${origin}.extraHeader`;
  env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
  return env;
};

/**
 * A simple-git instance for `dir` whose git processes authenticate to GitHub
 * with `token` (see gitAuthEnv). Use it only for commands that talk to GitHub.
 */
export const authenticatedGit = (dir: string, token: string): SimpleGit => {
  const authEnv = gitAuthEnv(token);
  // `.env()` replaces the child's whole environment. Leave out ambient GIT_*
  // variables, as simple-git does by default: passed explicitly, they would
  // make it refuse to run.
  const ambient = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith('GIT_'),
    ),
  );
  // simple-git 4 refuses GIT_* variables (and GIT_CONFIG_COUNT in
  // particular) passed through `.env()` unless they are explicitly allowed.
  return simpleGit({
    baseDir: dir,
    allowEnvironment: Object.keys(authEnv),
    unsafe: { allowUnsafeConfigEnvCount: true },
  }).env({ ...ambient, ...authEnv });
};
