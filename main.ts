// Entry point: bind the forge server to an ephemeral port, register that port with the
// make.fun trial environment, then wait until the environment says the trial is over.
//
// Lifecycle, in order:
//   1. MAKEFUN_ENV_URL must name the environment origin. Without it there is nothing to
//      register with, so the process exits 1 immediately.
//   2. The server from app.ts listens on port 0; the kernel picks a free port. Never bind
//      8080, the environment owns it.
//   3. POST {env}/register with {"port": N}. The first register wins; a 409 means another
//      entry already registered, and this process just keeps waiting.
//   4. GET {env}/done until the body reads {"done": true}. The environment answers at
//      once, so this is a poll with a short backoff, not a held request.
//   5. Close the server and exit 0.
//
// main.ts only imports its own server. No packages, no Node built-ins, no model calls.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** One request may take this long before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** First wait between retries, and the longest wait. */
const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 2_000;

/** Resolve after ms milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait after the nth failed attempt: exponential from RETRY_FIRST_MS, capped at RETRY_MAX_MS. */
function backoff(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/**
 * POST the bound port until the environment accepts it. 200 is normal; 409 means a first
 * register already won, which is not this process's problem. 400 and 405 are contract
 * errors and end the program; anything else is retried, since the environment may still
 * be starting.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) {
        if (response.status === 409) {
          process.stdout.write('[entry] register answered 409: another entry registered first; waiting\n');
        }
        return;
      }
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('register answered HTTP ')) throw error;
    }
    await sleep(backoff(attempt));
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The environment is not answering yet, or the poll timed out: not done, poll again.
    }
    await sleep(backoff(attempt));
  }
}

/** Bind the port, register it, then wait for the environment: the whole life of the process. */
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (error) {
  process.stderr.write(`[entry] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
