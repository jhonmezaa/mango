import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

import '../i18n';

afterEach(() => {
  cleanup();
});

// jsdom does not implement scrollIntoView.
Element.prototype.scrollIntoView = function scrollIntoView() {
  // no-op in tests
};
