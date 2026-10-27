/** Leaves the page for the provider (same tab, D98 (17)). A seam for tests. */
export const consentNavigation = {
  go(url: string): void {
    window.location.assign(url);
  },
};
