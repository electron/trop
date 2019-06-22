/**
 * Checks that a given environment variable exists, and returns
 * its value if it does. Throws an error on failure.
 *
 * @param {string} envVar
 * @returns string - the value of the env var being checked
 */
export function getEnvVar(envVar: string): string {
  const value = process.env[envVar];
  if (!value) throw new Error(`Missing environment variable ${envVar}`);
  return value;
}
