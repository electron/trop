/**
 * Checks that a given environment variable exists, and returns
 * its value if it does. Conditionally throws an error on failure.
 *
 * @param {string} envVar
 * @param {boolean} ignoreError - whether to throw an error if no environment var is found
 * @returns string - the value of the env var being checked
 */
export function getEnvVar(envVar: string, ignoreError: boolean = false): string {
  const value = process.env[envVar] || '';
  if (!ignoreError && !value) {
    throw new Error(`Missing environment variable ${envVar}`);
  }
  return value;
}
