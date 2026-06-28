import simpleGit, { SimpleGit, SimpleGitOptions } from 'simple-git';

// Name of the environment variable the inline git credential helper reads the
// installation token from. Supplying the token through the environment (instead
// of embedding it in the remote/clone URL) keeps it out of git's argv, out of
// any GitError thrown by simple-git (`task.commands`), and out of the on-disk
// .git/config - none of which are safe places for a credential to live.
const TOKEN_ENV_VAR = 'TROP_GIT_ACCESS_TOKEN';

// Per-invocation `-c` config that installs an inline credential helper. The
// helper script only ever references the *name* of the environment variable, so
// the token itself never appears on the command line. The leading empty
// `credential.helper=` resets any inherited (system/global) helpers first.
const CREDENTIAL_CONFIG: string[] = [
  'credential.helper=',
  `credential.helper=!f() { test "$1" = get && printf 'username=x-access-token\\npassword=%s\\n' "$${TOKEN_ENV_VAR}"; }; f`,
];

// Because we hand simple-git an explicit child environment (required so that
// each concurrent backport gets its own token), simple-git inspects that
// environment and refuses to run if it contains any variable it deems unsafe
// (an inherited GIT_ASKPASS, EDITOR, PAGER, GIT_SSH_COMMAND, etc.). We strip
// those rather than enable more `unsafe` overrides: git should authenticate via
// our credential helper, not via an inherited askpass/editor/pager, so removing
// them is both what unblocks simple-git and the more correct behaviour. The
// list mirrors simple-git's own unsafe-environment-variable set (matched
// case-insensitively).
const UNSAFE_ENV_VARS = new Set([
  'editor',
  'git_askpass',
  'git_config',
  'git_config_count',
  'git_config_global',
  'git_config_system',
  'git_editor',
  'git_exec_path',
  'git_external_diff',
  'git_pager',
  'git_proxy_command',
  'git_sequence_editor',
  'git_ssh',
  'git_ssh_command',
  'git_template_dir',
  'pager',
  'prefix',
  'ssh_askpass',
]);

/**
 * Builds the child-process environment for an authenticated git instance: the
 * current environment (so PATH, proxy settings, etc. are preserved) with any
 * simple-git-blocklisted variables removed and the credential-helper token
 * added.
 */
const buildGitEnv = (accessToken: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase().startsWith('git_config_')) continue;
    if (UNSAFE_ENV_VARS.has(key.toLowerCase())) continue;
    env[key] = value;
  }
  env[TOKEN_ENV_VAR] = accessToken ?? '';
  return env;
};

/**
 * Returns a simple-git instance authenticated for github.com over HTTPS via an
 * inline credential helper. The installation token is passed through the child
 * process environment rather than being interpolated into git URLs, so it can
 * never leak into logs through a thrown GitError or be persisted to disk.
 *
 * @param baseDir - the working directory for git commands
 * @param accessToken - the GitHub App installation token
 * @returns an authenticated simple-git instance
 */
export const authenticatedGit = (
  baseDir: string,
  accessToken: string,
): SimpleGit => {
  const options: Partial<SimpleGitOptions> = {
    baseDir,
    config: CREDENTIAL_CONFIG,
    // simple-git blocks `credential.helper` config by default because it can be
    // an arbitrary-command-execution vector. Our helper string is a static
    // constant - neither the slug nor the token are interpolated into it - so
    // there is no injection surface, and only this single category is unblocked.
    unsafe: {
      allowUnsafeCredentialHelper: true,
    },
  };

  // `env` replaces the child environment wholesale, so build it from the current
  // environment (minus simple-git's blocklisted variables) plus the token.
  return simpleGit(options).env(buildGitEnv(accessToken));
};

/**
 * Builds a credential-free clone/remote URL for the given repository slug.
 *
 * @param slug - the `owner/repo` slug
 * @returns an HTTPS git URL with no embedded credentials
 */
export const repoCloneUrl = (slug: string): string =>
  `https://github.com/${slug}.git`;
