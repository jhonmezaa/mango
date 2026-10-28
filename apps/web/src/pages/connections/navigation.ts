/** A tab opened for the provider's sign-in (D100: the tab that asked stays). */
export interface ConsentTab {
  go: (url: string) => void;
  close: () => void;
}

/** Opens the provider in another tab. A seam for tests. */
export const consentNavigation = {
  /**
   * Opens an empty tab right away, inside the click (popup blockers allow it), and cuts its link
   * back to Mango (`opener = null`): the provider's pages never get a handle on Mango's tab
   * (reverse tabnabbing). Null when the browser blocked it.
   */
  open(): ConsentTab | null {
    const tab = window.open('', '_blank');
    if (!tab) return null;
    tab.opener = null;
    return {
      go(url) {
        tab.location.replace(url);
      },
      close() {
        tab.close();
      },
    };
  },
};
