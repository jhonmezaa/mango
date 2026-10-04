import { useTranslation } from 'react-i18next';

import { CloseIcon } from './icons';

/** Design `initials`: the first two characters of the email. */
function initials(label: string): string {
  return label.slice(0, 2).toUpperCase();
}

interface Props {
  /** The email of the person; an identifier when the directory gave no email. API text. */
  email: string;
  /** Shown in monospace: it is an identifier, not an email. */
  mono?: boolean;
  size?: 'lg';
  onRemove?: () => void;
}

/**
 * A person as a chip with initials and email (design `PersonChip`): Ajustes › Personas, the
 * administrators of the installation and Agent Builder › Acceso › Personas. The email is
 * rendered as text.
 */
export function PersonChip({ email, mono = false, size, onRemove }: Props) {
  const { t } = useTranslation();
  return (
    <span className={size === 'lg' ? 'person-chip is-lg' : 'person-chip'}>
      <span className="person-av" aria-hidden="true">
        {initials(email)}
      </span>
      <span className={mono ? 'person-mail mono' : 'person-mail'}>{email}</span>
      {onRemove ? (
        <button type="button" aria-label={t('people.chip.remove', { email })} onClick={onRemove}>
          <CloseIcon size={10} />
        </button>
      ) : null}
    </span>
  );
}
