import { Context, Application } from 'probot';

export const getRepoToken = async (robot: Application, context: Context): Promise<string> => {
  const hub = await robot.auth();
  const response = await hub.apps.createInstallationToken({
    installation_id: context.payload.installation.id,
  });
  return response.data.token;
};
