import { lazy, Suspense, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router';

import { AuthProvider } from './auth/AuthProvider';
import type { CognitoAuth } from './auth/cognito/flows';
import { SessionProvider } from './auth/SessionProvider';
import { useAuth } from './auth/useAuth';
import { FullPageMessage } from './components/FullPageMessage';
import { SoonView } from './components/SoonView';
import type { RuntimeConfig } from './config/runtimeConfig';
import { AppLayout } from './layouts/AppLayout';
import { AVAILABLE_VIEWS, VIEW_ICONS, type ViewKey } from './layouts/navigation';
import { SCREENS } from './layouts/screens';
import { ChatPage } from './pages/ChatPage';
import { LoginPage } from './pages/LoginPage';
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
  const { t } = useTranslation();
  const { status } = useAuth();
  if (status === 'loading') return <FullPageMessage message={t('app.loading')} busy />;
  if (status === 'unauthenticated') return <LoginPage config={config} />;
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
