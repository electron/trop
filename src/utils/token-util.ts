import { Context, Application } from 'probot';
import { log } from './log-util';
import { LogLevel } from '../enums';

/**
 * Creates and returns an installation token for a GitHub App.
 *
 * @param {Application} robot - an instance of Probot
 * @param {Context} context - the context of the event that was triggered
 * @returns {Promise<string>} - a string representing a GitHub App installation token
 */
export const getRepoToken = async (robot: Application, context: Context): Promise<string> => {
  log('getRepoToken', LogLevel.INFO, 'Creating GitHub App token');

  const hub = await robot.auth();
  const response = await hub.apps.createInstallationToken({
    installation_id: context.payload.installation.id,
  });
  return response.data.token;
};
