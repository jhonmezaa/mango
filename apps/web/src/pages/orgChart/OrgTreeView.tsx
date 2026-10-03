import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { ChevronDownIcon } from '../../components/icons';
import { AgentIcon } from './AgentIcon';
import { countBelow, matches, type TreeNode } from './orgTree';

interface Props {
  root: TreeNode;
  selectedId: string | null;
  collapsed: ReadonlySet<string>;
  query: string;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}

interface NodeProps extends Omit<Props, 'root'> {
  node: TreeNode;
}

function OrgTreeNode({ node, ...shared }: NodeProps) {
  const { t } = useTranslation();
  const { selectedId, collapsed, query, onSelect, onToggle } = shared;
  const selected = selectedId === node.id;
  const folded = collapsed.has(node.id);
  const below = node.kids.length > 0 ? countBelow(node) : 0;
  const classes = ['oc-node'];
  if (selected) classes.push('on');
  if (node.isRoot) classes.push('root');
  if (node.ghost) classes.push('ghost');
  if (matches(node, query)) classes.push('hit');
  return (
    <li>
      <div className={classes.join(' ')}>
        <button
          type="button"
          className="oc-node-main"
          aria-pressed={selected}
          aria-label={t('orgChart.node', { name: node.name, role: node.role })}
          onClick={() => {
            onSelect(node.id);
          }}
        >
          {/* The design's status dot (`oc-pip`) has no data behind it yet: it is not drawn. */}
          <span className="oc-ic">
            <AgentIcon name={node.icon} size={15} />
          </span>
          <span className="min-w-0 text-left">
            <span className="oc-name">{node.name}</span>
            <span className="oc-role">{node.role}</span>
          </span>
        </button>
        {below > 0 ? (
          <button
            type="button"
            className="oc-toggle"
            aria-expanded={!folded}
            aria-label={t(folded ? 'orgChart.showBelow' : 'orgChart.hideBelow', {
              count: below,
              name: node.name,
            })}
            onClick={() => {
              onToggle(node.id);
            }}
          >
            {folded ? `+${below}` : <ChevronDownIcon size={11} />}
          </button>
        ) : null}
      </div>
      {below > 0 && !folded ? (
        <ul>
          {node.kids.map((kid) => (
            <OrgTreeNode key={kid.id} node={kid} {...shared} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * The «Reporta a» tree (design other-views.jsx `Node`). Names and roles come from agent
 * definitions written by creators: they are rendered as text. Memoized because the page renders
 * on every pan and zoom step.
 */
export const OrgTreeView = memo(function OrgTreeView({ root, ...shared }: Props) {
  return (
    <ul>
      <OrgTreeNode node={root} {...shared} />
    </ul>
  );
});
