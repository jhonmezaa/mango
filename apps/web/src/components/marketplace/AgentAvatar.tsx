import { agentIconStyle } from './agentIcons';

const ICON_SIZE = { sm: 14, md: 17, lg: 22 } as const;

interface Props {
  icon: string;
  /** Index in the palette; out of range falls back to the first color. */
  color?: number;
  size?: keyof typeof ICON_SIZE;
  /** Design «tus agentes en curso»: gray, whatever the color of the draft. */
  muted?: boolean;
}

/** Agent icon on its color (design `mk-avatar`). */
export function AgentAvatar({ icon, color = 0, size = 'md', muted = false }: Props) {
  const { Icon, colorClass } = agentIconStyle(icon, color);
  const classes = ['mk-avatar', muted ? 'mk-avatar-muted' : colorClass];
  if (size !== 'md') classes.push(size);
  return (
    <span className={classes.join(' ')}>
      <Icon size={ICON_SIZE[size]} />
    </span>
  );
}
