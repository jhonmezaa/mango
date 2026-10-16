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

/**
 * Design `ToolKind`, the only source of the kind badge (catalog and Builder): destructive (never
 * enabled, D84), write (an unclassified tool counts as one and is also marked «Sin clasificar»)
 * or read.
 */
export function AccessBadge({ tool }: { tool: Pick<Tool, 'access' | 'unclassified'> }) {
  const { t } = useTranslation();
  if (tool.access === 'destructive') {
    return (
      <Badge tone="red" title={t('mcpCatalog.access.destructiveTitle')}>
        {t('mcpCatalog.access.destructive')}
      </Badge>
    );
  }
  if (tool.access !== 'read') {
    return (
      <>
        <Badge tone="amber" title={t('mcpCatalog.access.writeTitle')}>
          {t('mcpCatalog.access.write')}
        </Badge>
        {tool.unclassified ? (
          <Badge title={t('mcpCatalog.access.unclassifiedTitle')}>
            {t('mcpCatalog.access.unclassified')}
          </Badge>
        ) : null}
      </>
    );
  }
  return <Badge>{t('mcpCatalog.access.read')}</Badge>;
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
