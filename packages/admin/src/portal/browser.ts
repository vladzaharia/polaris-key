/**
 * Leaving the page (a download URL, an external link). One indirection so tests can observe it:
 * jsdom cannot navigate.
 */
export const browser = {
  go(url: string): void {
    window.location.assign(url);
  },
};
