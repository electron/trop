import { spawn } from 'child_process';
import * as http from 'http';
import { AddressInfo } from 'net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gitAuthEnv, githubRemoteUrl } from '../src/utils/git-auth';

const TOKEN = 'ghs_spec0123456789abcdefABCDEF';
const BASIC = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`;

// Runs `git ls-remote <url>` with `env` added and resolves with the exit code.
const lsRemote = (url: string, env: Record<string, string>) =>
  new Promise<number | null>((resolve, reject) => {
    const child = spawn('git', ['ls-remote', url], {
      env: { ...process.env, ...env },
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('close', resolve);
  });

describe('git-auth', () => {
  describe('githubRemoteUrl()', () => {
    it('builds a credential-free https URL', () => {
      expect(githubRemoteUrl('electron/electron')).toBe(
        'https://github.com/electron/electron.git',
      );
    });
  });

  describe('gitAuthEnv()', () => {
    it('passes the token as a github.com-scoped extra header', () => {
      expect(gitAuthEnv(TOKEN)).toEqual({
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
        GIT_CONFIG_VALUE_0: `Authorization: ${BASIC}`,
      });
    });

    it('adds no credentials for an empty token', () => {
      expect(gitAuthEnv('')).toEqual({ GIT_TERMINAL_PROMPT: '0' });
    });

    describe('against an HTTP server', () => {
      let server: http.Server;
      let origin: string;
      let authHeaders: (string | undefined)[];

      beforeEach(async () => {
        authHeaders = [];
        server = http.createServer((req, res) => {
          authHeaders.push(req.headers.authorization);
          res.writeHead(404).end();
        });
        await new Promise<void>((resolve) =>
          server.listen(0, '127.0.0.1', resolve),
        );
        origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      });

      afterEach(async () => {
        await new Promise((resolve) => server.close(resolve));
      });

      it('makes git send the header to its origin', async () => {
        await lsRemote(`${origin}electron/trop.git`, gitAuthEnv(TOKEN, origin));
        expect(authHeaders.length).toBeGreaterThan(0);
        expect(authHeaders).toEqual(authHeaders.map(() => BASIC));
      });

      it('never sends the header to another origin', async () => {
        await lsRemote(`${origin}electron/trop.git`, gitAuthEnv(TOKEN));
        expect(authHeaders.length).toBeGreaterThan(0);
        expect(authHeaders.every((h) => h === undefined)).toBe(true);
      });
    });
  });
});
