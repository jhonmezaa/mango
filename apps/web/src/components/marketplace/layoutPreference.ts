import { readPreference, writePreference } from '../../preferences/storage';
import type { Layout } from './model';

// Cards or list in the Marketplace (design marketplace.jsx `mango-mk-layout`): a UI preference
// of this browser. Storage content is untrusted: anything but the two known values is ignored.

const KEY = 'mango-mk-layout';

export function readLayout(): Layout {
  return readPreference(KEY) === 'list' ? 'list' : 'cards';
}

export function writeLayout(layout: Layout): void {
  writePreference(KEY, layout);
}
