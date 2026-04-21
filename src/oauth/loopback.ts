import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import type { Logger } from 'pino';

const SUCCESS_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Authorized</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:32rem;margin:6rem auto;padding:0 1rem;color:#222}</style>
</head><body>
<h1>Authorized.</h1>
<p>You can close this tab and return to Claude Desktop.</p>
</body></html>`;

export interface LoopbackResult {
  port: number;
  code: Promise<string>;
  cleanup: () => void;
}

/**
 * Start a one-shot HTTP listener on 127.0.0.1 that captures the OAuth
 * /callback. Picks a free port from [portMin, portMax]. Rejects if the
 * listener is still idle after timeoutMs.
 *
 * The returned Promise<string> resolves with the authorization code
 * when the browser redirects back; rejects on state mismatch, explicit
 * error param, or timeout.
 */
export async function listen(
  expectedState: string,
  portMin: number,
  portMax: number,
  timeoutMs: number,
  logger: Logger,
): Promise<LoopbackResult> {
  const server = await bind(portMin, portMax);
  const port = (server.address() as AddressInfo).port;

  let resolveCode: (c: string) => void = () => {};
  let rejectCode: (e: Error) => void = () => {};
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const timer = setTimeout(() => {
    rejectCode(new Error('authorization timed out'));
    server.close();
  }, timeoutMs);

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== '/callback') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      const err = url.searchParams.get('error');
      if (err) {
        res.statusCode = 400;
        res.end(`oauth error: ${err}`);
        rejectCode(new Error(`oauth error from provider: ${err}`));
        return;
      }
      const gotState = url.searchParams.get('state') ?? '';
      if (gotState !== expectedState) {
        res.statusCode = 400;
        res.end('state mismatch');
        rejectCode(new Error('state mismatch on /callback'));
        return;
      }
      const gotCode = url.searchParams.get('code') ?? '';
      if (!gotCode) {
        res.statusCode = 400;
        res.end('missing code');
        rejectCode(new Error('missing code on /callback'));
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(SUCCESS_PAGE);
      resolveCode(gotCode);
    } catch (e) {
      rejectCode(e instanceof Error ? e : new Error(String(e)));
    }
  });

  const cleanup = (): void => {
    clearTimeout(timer);
    server.close();
  };
  code.finally(cleanup).catch(() => {
    /* swallow unhandled rejection; caller awaits code */
  });

  logger.debug({ port, portMin, portMax }, 'loopback listener up');
  return { port, code, cleanup };
}

async function bind(portMin: number, portMax: number): Promise<Server> {
  let lastErr: unknown = null;
  for (let port = portMin; port <= portMax; port++) {
    try {
      return await tryListen(port);
    } catch (e) {
      lastErr = e;
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    }
  }
  throw new Error(
    `no free port in [${portMin}, ${portMax}]: ${(lastErr as Error)?.message ?? 'unknown'}`,
  );
}

function tryListen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    const onError = (e: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening);
      reject(e);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}
