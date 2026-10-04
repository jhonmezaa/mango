import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { Agent } from '../agents/agents';
import { createApiClient } from '../api/client';
import { ApiError } from '../api/errors';
import type { ConversationSummary, Me } from '../api/schemas';
import type { RuntimeConfig } from '../config/runtimeConfig';
import { FullPageMessage } from '../components/FullPageMessage';
import { LoginLayout } from '../pages/login/LoginLayout';
import { NoAccess } from '../pages/login/NoAccess';
import { RestoringSession } from '../pages/login/RestoringSession';
import { SessionContext, type SessionContextValue } from './SessionContext';
import { useAuth } from './useAuth';

export function SessionProvider({
  config,
  children,
}: {
  config: RuntimeConfig;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const {
    getAccessToken,
    expireSession,
    refreshSession,
    logout,
    displayEmail,
    restored,
    federated,
  } = useAuth();
  const api = useMemo(
    () =>
      createApiClient({
        basePath: config.apiBasePath,
        getAccessToken,
        onUnauthorized: expireSession,
      }),
    [config.apiBasePath, getAccessToken, expireSession],
  );

  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState(false);
  // Verified session without a group (403 `no_group`, D20): deny by default.
  const [noGroup, setNoGroup] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [conversationsError, setConversationsError] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [agentsError, setAgentsError] = useState(false);
  const [agentsToken, setAgentsToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.getMe().then(
      (value) => {
        if (!cancelled) setMe(value);
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.code === 'no_group') setNoGroup(true);
        else setMeError(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    api.listConversations().then(
      (items) => {
        if (cancelled) return;
        setConversations(items);
        setConversationsError(false);
      },
      () => {
        if (!cancelled) setConversationsError(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, reloadToken]);

  // Independent of the conversations: both requests go out together.
  useEffect(() => {
    let cancelled = false;
    api.call('getAgents').then(
      (list) => {
        if (cancelled) return;
        setAgents(list.items);
        setAgentsError(false);
      },
      () => {
        if (!cancelled) setAgentsError(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, agentsToken]);

  const reloadConversations = useCallback(() => {
    setReloadToken((value) => value + 1);
  }, []);
  const reloadAgents = useCallback(() => {
    setAgentsToken((value) => value + 1);
  }, []);

  const value = useMemo<SessionContextValue | null>(
    () =>
      me
        ? {
            api,
            config,
            me,
            conversations,
            conversationsError,
            reloadConversations,
            agents,
            agentsError,
            reloadAgents,
          }
        : null,
    [
      api,
      config,
      me,
      conversations,
      conversationsError,
      reloadConversations,
      agents,
      agentsError,
      reloadAgents,
    ],
  );

  const recheck = useCallback(async () => {
    // New tokens make the pre-token trigger read the current groups.
    if (!(await refreshSession())) return false;
    try {
      setMe(await api.getMe());
      setNoGroup(false);
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'no_group') return false;
      throw error;
    }
  }, [api, refreshSession]);

  if (noGroup && !me) {
    return (
      <LoginLayout>
        <NoAccess
          email={displayEmail ?? ''}
          onRecheck={recheck}
          onLogout={() => {
            void logout();
          }}
        />
      </LoginLayout>
    );
  }
  if (meError) return <FullPageMessage message={t('errors.generic')} />;
  if (!value) {
    // Every way in keeps the sign-in frame until the application is ready (no flash, no generic
    // loading): a recovered session, the return from the IdP and the own sign-in form.
    if (restored) return <RestoringSession />;
    return <RestoringSession step={federated ? 'ssoReturn' : 'signingIn'} />;
  }
  return <SessionContext value={value}>{children}</SessionContext>;
}
