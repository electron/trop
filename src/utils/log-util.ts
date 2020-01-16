import { LogLevel } from '../enums';

/**
 * Logs information about different actions taking place to console.
 *
 * @param {string} functionName - the name of the function where the logging is happening
 * @param {LogLevel }logLevel - the severity level of the log
 * @param {any[]} message - the message to write to console
 */
export const log = (functionName: string, logLevel: LogLevel, ...message: any[]) => {
  const output = `${functionName}: ${message}`;

  if (logLevel === LogLevel.INFO) {
    console.info(output);
  } else if (logLevel === LogLevel.WARN) {
    console.warn(output);
  } else if (logLevel === LogLevel.ERROR) {
    console.error(output);
  } else {
    console.log(output);
  }
};
