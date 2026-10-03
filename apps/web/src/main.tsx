import './zodConfig';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { createCognitoAuth } from './auth/cognito/client';
import { FullPageMessage } from './components/FullPageMessage';
import { loadRuntimeConfig } from './config/runtimeConfig';
import i18n from './i18n';
import { applyTheme, readStoredTheme } from './preferences/theme';
import './index.css';

// Set before the first render (no inline script: CSP `script-src 'self'`).
applyTheme(readStoredTheme());

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');
const root = createRoot(container);

loadRuntimeConfig().then(
  (config) => {
    root.render(
      <StrictMode>
        <App config={config} cognito={createCognitoAuth(config)} />
      </StrictMode>,
    );
  },
  () => {
    root.render(<FullPageMessage message={i18n.t('config.error')} />);
  },
);
