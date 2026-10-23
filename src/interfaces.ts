import { BackportPurpose } from './enums';
import { SimpleWebHookRepoContext, WebHookPR } from './types';

export interface TryBackportOptions {
  context: SimpleWebHookRepoContext;
  repoAccessToken: string;
  purpose: BackportPurpose;
  // Every PR whose commits are backported together, ordered bottom to top.
  prs: WebHookPR[];
  slug: string;
  targetBranch: string;
}
