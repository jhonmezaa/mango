import { useTranslation } from 'react-i18next';

import { Badge } from '../../components/Badge';
import { CloudIcon, CommandIcon } from '../../components/icons';
import {
  LEVEL_TONE,
  STATUS_TONE,
  dataModeOf,
  isLevel,
  isWorking,
  type Server,
  type ServerStatus,
  type Tool,
} from './model';

// Small pieces shared by the tables and the detail panel (design `McpStatus`, `McpLevel`).

export function StatusBadge({ status }: { status: ServerStatus }) {
  const { t } = useTranslation();
  return (
    <Badge tone={STATUS_TONE[status]}>
      {isWorking(status) ? <span className="g-spin mc-spin" aria-hidden="true" /> : null}
      {t(`mcpCatalog.status.${status}`)}
    </Badge>
  );
}

/** Data level of a server (design `McpLevel`). */
export function LevelBadge({ server }: { server: Server }) {
  const { t } = useTranslation();
  const level = server.data_tier;
  if (!isLevel(level)) return <Badge>{level}</Badge>;
  // The design's hint for account data ("solo roles centrales") only holds when the server has
  // tools the backend does not filter per user (D35).
  const centralOnly = server.tools.some((tool) => tool.central_groups_only);
  const title =
    level === 'internal' || (level === 'account_data' && !centralOnly)
      ? undefined
      : t(`mcpCatalog.levelTitles.${level}`);
  return (
    <Badge tone={LEVEL_TONE[level]} {...(title ? { title } : {})}>
      {t(`mcpCatalog.levels.${level}`)}
    </Badge>
  );
}

/** «Solo centrales» or «Por usuario» for a server over account data (design `McpMode`). */
export function ModeBadge({ server }: { server: Server }) {
  const { t } = useTranslation();
  const mode = dataModeOf(server);
  if (mode === null) return null;
  return (
    <Badge
      tone={mode === 'central' ? 'violet' : 'neutral'}
      title={t(`mcpCatalog.modeTitles.${mode}`)}
    >
      {t(`mcpCatalog.modes.${mode}`)}
    </Badge>
  );
}

export function AccessBadge({ tool }: { tool: Tool }) {
  const { t } = useTranslation();
  return tool.access === 'write' ? (
    <Badge tone="amber" title={t('mcpCatalog.access.writeTitle')}>
      {t('mcpCatalog.access.write')}
    </Badge>
  ) : (
    <Badge>{t('mcpCatalog.access.read')}</Badge>
  );
}

export function ServerIcon({ server, large = false }: { server: Server; large?: boolean }) {
  const pack = server.kind === 'pack';
  const Icon = pack ? CloudIcon : CommandIcon;
  const classes = ['mc-ic'];
  if (large) classes.push('lg');
  if (pack) classes.push('pack');
  return (
    <span className={classes.join(' ')}>
      <Icon size={large ? 20 : 14} />
    </span>
  );
}

/** "MCP pack · AWS Labs" or "Conector de Mango" (design row and panel). */
export function KindLabel({ server }: { server: Server }) {
  const { t } = useTranslation();
  return server.kind === 'pack'
    ? t('mcpCatalog.kindPack', { provider: server.provider })
    : t('mcpCatalog.kindConnector');
}

/** Tool of an update: added (green) or removed (red, struck through). */
export function ToolChip({
  name,
  tone,
  write = false,
}: {
  name: string;
  tone?: 'add' | 'rem';
  write?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <code className={tone ? `mc-tool-chip ${tone}` : 'mc-tool-chip'}>
      {name}
      {write ? t('mcpCatalog.access.writeSuffix') : null}
    </code>
  );
}
