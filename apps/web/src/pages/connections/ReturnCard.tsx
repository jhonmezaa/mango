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
import type { ReturnResult } from './model';

/** Design `RET`: icon and tone of each result. */
const LOOK: Record<ReturnResult, [ComponentType<IconProps>, string]> = {
  ok: [CheckIcon, 'green'],
  orphan: [RefreshIcon, 'amber'],
  expired: [ClockIcon, 'amber'],
  denied: [X2Icon, 'red'],
  conditional: [ShieldIcon, 'amber'],
  ambiguous: [WarnIcon, 'amber'],
  notyours: [LockIcon, 'red'],
  error: [WarnIcon, 'amber'],
};

/** «el proveedor no autorizó…» starts a sentence when the provider is not known. */
function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The card of the return from the provider (design remote-views.jsx `RemoteReturn`). The service
 * line only for «Listo», once the tab that closed it named the service (D100).
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
  const named = result === 'ok' && service !== null;
  return (
    <div className="rm-ret" role={result === 'ok' ? 'status' : 'alert'}>
      {named && (
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
        {sentence(t(`connections.ret.${result}.title`, { idp: provider }))}
      </h1>
      <p className="rm-ret-b">
        {result === 'ok' && !named
          ? t('connections.ret.ok.bodyUnnamed')
          : t(`connections.ret.${result}.body`, { idp: provider, service: service ?? '' })}
      </p>
      <div className="flex flex-wrap justify-center gap-2">{children}</div>
    </div>
  );
}

/**
 * «Terminando la conexión…» (design `RemoteReturn`, phase `relaying`), while the tab that pressed
 * «Conectar» closes the consent. It does not name the service: it does not know it yet.
 */
export function RelayingCard() {
  const { t } = useTranslation();
  return (
    <div className="rm-ret" role="status" aria-busy="true">
      <span className="rm-ret-ic muted">
        <span className="g-spin" aria-hidden="true" />
      </span>
      <h1 className="rm-ret-t">{t('connections.ret.relaying.title')}</h1>
      <p className="rm-ret-b">{t('connections.ret.relaying.body')}</p>
    </div>
  );
}
