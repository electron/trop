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
