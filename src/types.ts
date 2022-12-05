import { Context } from 'probot';

export type WebHookPRContext = Context<
  | 'pull_request.opened'
  | 'pull_request.closed'
  | 'pull_request.reopened'
  | 'pull_request.edited'
  | 'pull_request.synchronize'
  | 'pull_request.labeled'
  | 'pull_request.unlabeled'
>;
export type SimpleWebHookRepoContext = Pick<
  WebHookRepoContext,
  'octokit' | 'repo' | 'payload'
>;
export type WebHookRepoContext = Omit<WebHookPRContext, 'payload'> & {
  payload: Omit<
    WebHookPRContext['payload'],
    'pull_request' | 'number' | 'action'
  >;
};
export type WebHookPR = WebHookPRContext['payload']['pull_request'];
