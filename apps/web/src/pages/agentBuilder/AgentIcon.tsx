import { createElement } from 'react';

import type { IconProps } from '../../components/icons';
import { agentIcon } from './agentIcons';

/** The icon of an agent by its name (`definition.icon`); an unknown name renders `Bot`. */
export function AgentIcon({ name, ...props }: IconProps & { name: string }) {
  return createElement(agentIcon(name), props);
}
