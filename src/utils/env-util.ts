import { log } from './log-util';
import { LogLevel } from '../enums';

/**
 * Checks that a given environment variable exists, and returns
 * its value if it does. Conditionally throws an error on failure.
 *
 * @param {string} envVar - the environment variable to retrieve
 * @param {string} defaultValue - default value to use if no environment var is found
 * @returns {string} - the value of the env var being checked, or the default value if one is passed
 */
export function getEnvVar(envVar: string, defaultValue?: string): string {
  log('getEnvVar', LogLevel.INFO, `Fetching env var '${envVar}'`);

  const value = process.env[envVar] || defaultValue;
  if (!value && value !== '') {
    log(
      'getEnvVar',
      LogLevel.ERROR,
      `Missing environment variable '${envVar}'`,
    );
    throw new Error(`Missing environment variable '${envVar}'`);
  }
  return value;
}
