import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { es } from './locales/es';

export const defaultNS = 'translation';
export const resources = { es: { translation: es } } as const;

// Only Spanish ships in the MVP. Resources are bundled (no remote backend) and no language
// detector is used, so nothing is read from or written to browser storage.
void i18n.use(initReactI18next).init({
  resources,
  lng: 'es',
  fallbackLng: 'es',
  defaultNS,
  interpolation: {
    // React already escapes interpolated values when rendering text.
    escapeValue: false,
  },
  returnNull: false,
});

export default i18n;
