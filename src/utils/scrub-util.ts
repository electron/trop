import { inspect } from 'util';

// Matches the userinfo (`user:password@`) portion of a URL. simple-git embeds
// the GitHub App installation token into credentialed git URLs such as
// `https://x-access-token:<token>@github.com/<slug>.git`; this lets us strip
// those credentials before anything reaches a log sink. Anchoring on `://`
// (rather than the scheme name) keeps the match linear - a greedy scheme-name
// class would rescan the tail at every offset and turn this into quadratic
// (ReDoS-prone) work on long log strings.
const URL_CREDENTIALS_REGEX = /:\/\/[^/\s@]+@/g;

/**
 * Removes credentials embedded in URLs (such as the installation token
 * interpolated into git remote/clone URLs) from a string.
 *
 * @param value - the string to scrub
 * @returns the string with any URL userinfo replaced by `***`
 */
export const scrubCredentials = (value: string): string =>
  value.replace(URL_CREDENTIALS_REGEX, '://***@');

/**
 * Safely converts a value (typically an Error) into a credential-free string
 * suitable for logging. Errors thrown by simple-git attach the full git task -
 * including credentialed URLs in `task.commands` - to the error object, so the
 * value is fully inspected and then scrubbed.
 *
 * @param value - the value to render for logging
 * @returns a scrubbed string representation of the value
 */
export const scrubValueForLog = (value: unknown): string =>
  scrubCredentials(typeof value === 'string' ? value : inspect(value));
