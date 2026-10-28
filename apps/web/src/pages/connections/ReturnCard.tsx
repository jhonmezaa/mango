import type { ComponentType, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import {
  CheckIcon,
  ClockIcon,
  LockIcon,
  RefreshIcon,
  ShieldIcon,
  WarnIcon,
  X2Icon,
  type IconProps,
} from '../../components/icons';
import { RmTile } from '../remoteMcp/parts';
import { UNNAMED_RESULTS, type ReturnResult } from './model';

/** Design `RET`: icon and tone of each result. */
const LOOK: Record<ReturnResult, [ComponentType<IconProps>, string]> = {
  ok: [CheckIcon, 'green'],
  expired: [ClockIcon, 'amber'],
  lost: [RefreshIcon, 'amber'],
  nosession: [LockIcon, 'muted'],
  notyours: [LockIcon, 'red'],
  denied: [X2Icon, 'red'],
  conditional: [ShieldIcon, 'amber'],
  error: [WarnIcon, 'amber'],
};

/**
 * The card of the return from the provider (design remote-views.jsx `RemoteReturn`). `service` is
 * null when Mango cannot know which one the person came back from: the line is then left out.
 */
export function ReturnCard({
  result,
  service,
  idp,
  children,
}: {
  result: ReturnResult;
  service: string | null;
  idp: string | null;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [Icon, tone] = LOOK[result];
  const provider = idp ?? t('connections.ret.providerFallback');
  return (
    <div className="rm-ret" role={result === 'ok' ? 'status' : 'alert'}>
      {service && !UNNAMED_RESULTS.has(result) && (
        <div className="rm-ret-svc flex items-center gap-2">
          <RmTile profile={{ name: service }} />
          <span>{service}</span>
          {idp && <span className="mk-meta">{t('connections.ret.from', { idp })}</span>}
        </div>
      )}
      <span className={`rm-ret-ic ${tone}`}>
        <Icon size={18} />
      </span>
      <h1 className="rm-ret-t">
        {t(`connections.ret.${result}.title`, { service: service ?? '', idp: provider })}
      </h1>
      <p className="rm-ret-b">{t(`connections.ret.${result}.body`, { idp: provider })}</p>
      <div className="flex flex-wrap justify-center gap-2">{children}</div>
    </div>
  );
}

/**
 * «Terminando la conexión…» (design `RemoteReturn`, phase `finishing`), while mango-api closes the
 * consent. The service line only when the person's connections already say which one it is.
 */
export function FinishingCard({ service, idp }: { service: string | null; idp: string | null }) {
  const { t } = useTranslation();
  return (
    <div className="rm-ret" role="status" aria-busy="true">
      {service && (
        <div className="rm-ret-svc flex items-center gap-2">
          <RmTile profile={{ name: service }} />
          <span>{service}</span>
          {idp && <span className="mk-meta">{t('connections.ret.from', { idp })}</span>}
        </div>
      )}
      <span className="rm-ret-ic muted">
        <span className="g-spin" aria-hidden="true" />
      </span>
      <h1 className="rm-ret-t">{t('connections.ret.finishing.title')}</h1>
      <p className="rm-ret-b">
        {service
          ? t('connections.ret.finishing.body', { service })
          : t('connections.ret.finishing.bodyUnnamed')}
      </p>
    </div>
  );
}
