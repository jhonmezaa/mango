import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { CloseIcon, EditIcon, LockIcon } from '../../components/icons';
import { Soon, SoonTag } from '../../components/Soon';
import { AgentIcon } from './AgentIcon';
import { GitBranchIcon } from './icons';
import type { TreeNode } from './orgTree';

interface Props {
  node: TreeNode;
  /** UX only: the API decides who may edit an agent. */
  canEdit: boolean;
  onClose: () => void;
}

/** Design `MiniStat`. The delegation counters carry «—»: A2A has no backend yet (D30). */
function MiniStat({ label, value }: { label: string; value: number | '—' }) {
  return (
    <div className="oc-mini">
      <div className="oc-mini-v">{value}</div>
      <div className="oc-mini-l">{label}</div>
    </div>
  );
}

// Design `OrgAgentFacts` ("Disponible hoy"): rows this screen has no data for yet.
const SOON_FACTS = ['status', 'model', 'sharedWith', 'budget', 'data'] as const;

/**
 * Panel of the selected node (design other-views.jsx `OrgSidePanel` and `OrgAgentFacts`), read
 * only (D30). It shows what GET /api/agents/org returns: the agent, its role, description and
 * category, and who reports to it. Delegation, status, model, sharing, budget, data level and
 * costs have no data here yet ("Próximamente", without example values). The root and the
 * «Supervisor no visible» node are not agents: they say so and have no facts.
 */
export function OrgSidePanel({ node, canEdit, onClose }: Props) {
  const { t } = useTranslation();
  const kids = node.kids;
  return (
    <aside className="card oc-panel" aria-label={t('orgChart.panel.label', { name: node.name })}>
      <div className="oc-panel-h">
        <div className="flex min-w-0 items-center gap-3">
          <span className="oc-panel-ic">
            <AgentIcon name={node.icon} size={17} />
          </span>
          <div className="min-w-0">
            <div className="oc-panel-name">{node.name}</div>
            <div className="oc-panel-role">{node.role}</div>
          </div>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label={t('common.close')}
          onClick={onClose}
        >
          <CloseIcon size={13} />
        </button>
      </div>

      <div className="oc-panel-b">
        {kids.length > 0 ? (
          <Soon block name={t('orgChart.panel.delegate')} className="mb-3.5">
            <button type="button" className="btn btn-primary btn-sm w-full" tabIndex={-1}>
              <GitBranchIcon size={12} />
              {t('orgChart.panel.delegate')}
            </button>
          </Soon>
        ) : null}

        {node.ghost ? (
          <div className="mc-alert oc-panel-alert">
            <LockIcon size={13} />
            <div>{t('orgChart.hidden.note')}</div>
          </div>
        ) : null}
        {node.isRoot ? <p className="mk-meta oc-panel-note">{t('orgChart.root.note')}</p> : null}

        <div className="mb-3.5 flex gap-2">
          <MiniStat label={t('orgChart.panel.sent')} value="—" />
          <MiniStat label={t('orgChart.panel.received')} value="—" />
          <MiniStat label={t('orgChart.panel.reports')} value={kids.length} />
        </div>

        {kids.length > 0 ? (
          <div className="mb-3.5">
            <div className="oc-panel-t">{t('orgChart.panel.directReports')}</div>
            <ul>
              {kids.map((kid) => (
                <li key={kid.id} className="oc-kid">
                  <span className="oc-kid-ic">
                    <AgentIcon name={kid.icon} size={12} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="oc-kid-name">{kid.name}</div>
                    <div className="oc-kid-role">{kid.role}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {node.isRoot || node.ghost ? null : (
          <div className="flex flex-col gap-3.5">
            {node.description ? <p className="oc-panel-desc">{node.description}</p> : null}
            {node.canUse ? null : (
              <div className="oc-nouse" role="note">
                <div className="oc-nouse-t">
                  <LockIcon size={13} />
                  {t('orgChart.noUse.title')}
                </div>
                <div>{t('orgChart.noUse.body')}</div>
                {node.groups.length > 0 ? (
                  <div>
                    <div className="oc-nouse-l">{t('orgChart.noUse.usedBy')}</div>
                    {/* Group ids from the API, rendered as text. */}
                    <div className="oc-nouse-g">
                      {node.groups.map((group) => (
                        <span key={group}>{group}</span>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div className="oc-nouse-how">
                  {t(canEdit ? 'orgChart.noUse.howEditor' : 'orgChart.noUse.howOther')}
                </div>
              </div>
            )}
            <div>
              <div className="oc-panel-t">{t('orgChart.panel.agent')}</div>
              <div className="mk-kv oc-kv">
                <span>{t('orgChart.panel.category')}</span>
                <span>{node.category || '—'}</span>
              </div>
              {SOON_FACTS.map((key) => (
                <div key={key} className="mk-kv oc-kv">
                  <span>{t(`orgChart.panel.${key}`)}</span>
                  <span className="oc-kv-soon">
                    <span className="mk-meta">—</span>
                    <SoonTag />
                  </span>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {node.canUse ? (
                <Link className="btn btn-sm" to="/marketplace">
                  {t('orgChart.panel.marketplace')}
                </Link>
              ) : null}
              {canEdit && node.version !== null ? (
                // The id comes from the API: it only fills one encoded path segment. The
                // version is named too: without it the Builder needs `UseAgent` to find it.
                <Link
                  className="btn btn-sm"
                  to={`/admin/${encodeURIComponent(node.id)}/${String(node.version)}`}
                >
                  <EditIcon size={12} />
                  {t('orgChart.panel.edit')}
                </Link>
              ) : null}
              <Soon name={t('orgChart.panel.costs')}>
                <button type="button" className="btn btn-sm btn-ghost" tabIndex={-1}>
                  {t('orgChart.panel.costs')}
                </button>
              </Soon>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
