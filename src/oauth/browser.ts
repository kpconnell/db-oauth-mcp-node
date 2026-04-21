import open from 'open';

/** Open a URL in the user's default browser. Platform-specific under the hood. */
export async function openBrowser(url: string): Promise<void> {
  await open(url, { wait: false });
}
