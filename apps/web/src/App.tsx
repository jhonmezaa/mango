import { lazy, Suspense, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router';

import { AuthProvider } from './auth/AuthProvider';
import type { CognitoAuth } from './auth/cognito/flows';
import { SessionProvider } from './auth/SessionProvider';
import { hasAuthCallbackParams } from './auth/ssoUrls';
import { useAuth } from './auth/useAuth';
import { FullPageRetry } from './components/FullPageRetry';
import { SoonView } from './components/SoonView';
import type { RuntimeConfig } from './config/runtimeConfig';
import { AppLayout } from './layouts/AppLayout';
import { AVAILABLE_VIEWS, VIEW_ICONS, type ViewKey } from './layouts/navigation';
import { SCREENS } from './layouts/screens';
import { ChatPage } from './pages/ChatPage';
import { LoginPage } from './pages/LoginPage';
import { RestoringSession } from './pages/login/RestoringSession';
import { capturedReturn } from './pages/connections/consentReturn';
import { NoSessionReturn } from './pages/connections/NoSessionReturn';
import { NotFoundPage } from './pages/NotFoundPage';

// Admin screens are only for admins: they load on demand and stay out of the main chunk.
const AdminAuditPage = lazy(() =>
  import('./pages/AdminAuditPage').then((module) => ({ default: module.AdminAuditPage })),
);
const AdminBudgetsPage = lazy(() =>
  import('./pages/AdminBudgetsPage').then((module) => ({ default: module.AdminBudgetsPage })),
);
const AdminSettingsPage = lazy(() =>
  import('./pages/AdminSettingsPage').then((module) => ({ default: module.AdminSettingsPage })),
);

function Lazy({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Suspense
      fallback={
        <p role="status" className="flex items-center gap-2.5 p-8 text-muted">
          <span className="spinner" aria-hidden="true" />
          {t('app.loading')}
        </p>
      }
    >
      {children}
    </Suspense>
  );
}

// Views of the design without a backend yet: their routes exist and render SoonView. The views
// of `SCREENS` bring their own routes.
const SCREEN_VIEWS = new Set(SCREENS.map((screen) => screen.view));
const SOON_VIEWS = (Object.keys(VIEW_ICONS) as ViewKey[]).filter(
  (view) => !AVAILABLE_VIEWS.has(view) && !SCREEN_VIEWS.has(view),
);

function Soon({ view }: { view: ViewKey }) {
  const { t } = useTranslation();
  return <SoonView label={t(`nav.${view}`)} />;
}

/** Design deep link `/chat/<id>` → the chat's existing URL. */
function ChatRedirect() {
  const { conversationId } = useParams();
  return (
    <Navigate to={conversationId ? `/c/${encodeURIComponent(conversationId)}` : '/'} replace />
  );
}

/** Every route of the design; unavailable views render SoonView (exported for tests). */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<ChatPage />} />
        <Route path="c/:conversationId" element={<ChatPage />} />
        <Route path="chat" element={<ChatRedirect />} />
        <Route path="chat/:conversationId" element={<ChatRedirect />} />
        <Route
          path="audit"
          element={
            <Lazy>
              <AdminAuditPage />
            </Lazy>
          }
        />
        <Route
          path="budgets"
          element={
            <Lazy>
              <AdminBudgetsPage />
            </Lazy>
          }
        />
        <Route
          path="settings"
          element={
            <Lazy>
              <AdminSettingsPage />
            </Lazy>
          }
        />
        {/* Design round 19: Ajustes opens on the tab the path names (`/settings/areas`). */}
        <Route
          path="settings/:tab"
          element={
            <Lazy>
              <AdminSettingsPage />
            </Lazy>
          }
        />
        {SOON_VIEWS.map((view) => (
          <Route key={view} path={`${view}/*`} element={<Soon view={view} />} />
        ))}
        {SCREENS.flatMap(({ paths, Page }) =>
          paths.map((path) => (
            <Route
              key={path}
              path={path}
              element={
                <Lazy>
                  <Page />
                </Lazy>
              }
            />
          )),
        )}
        {/* Pre-v6 admin URLs; `admin/*` itself is the Agent Builder (design view `admin`). */}
        <Route path="admin/audit" element={<Navigate to="/audit" replace />} />
        <Route path="admin/budgets" element={<Navigate to="/budgets" replace />} />
        <Route path="admin/settings" element={<Navigate to="/settings" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

function AuthGate({ config }: { config: RuntimeConfig }) {
  const { status, retryRestore } = useAuth();
  const [signingIn, setSigningIn] = useState(false);
  if (status === 'loading') {
    // Coming back from the IdP is a sign-in in progress, not a session being recovered.
    return (
      <RestoringSession
        step={hasAuthCallbackParams(window.location.search) ? 'ssoReturn' : 'restoring'}
      />
    );
  }
  if (status === 'unauthenticated') {
    // Back from a remote service's sign-in without a Mango session (design `nosession`).
    if (!signingIn && capturedReturn()?.kind === 'session') {
      return (
        <NoSessionReturn
          onSignIn={() => {
            setSigningIn(true);
          }}
        />
      );
    }
    return <LoginPage config={config} />;
  }
  // The renewal did not answer: that is not «no session», so no sign-in form.
  if (status === 'unavailable') return <FullPageRetry onRetry={retryRestore} />;
  return (
    <SessionProvider config={config}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </SessionProvider>
  );
}

export function App({ config, cognito }: { config: RuntimeConfig; cognito: CognitoAuth }) {
  return (
    <AuthProvider config={config} cognito={cognito}>
      <AuthGate config={config} />
    </AuthProvider>
  );
}
