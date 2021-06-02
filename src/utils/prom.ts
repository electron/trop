import * as pClient from 'prom-client';

export const client = pClient;
export const register = new client.Registry();

register.setDefaultLabels({
  app: 'trop',
});
