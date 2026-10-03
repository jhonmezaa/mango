import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { CodeStep } from './CodeStep';
import { PasswordInput, PasswordMeter, PasswordRule } from './fields';
import { meetsPasswordPolicy } from './validation';

/** Design `ResetStep`: recovery code plus the new password (policy checked before sending). */
export function ResetStep({
  subtitle,
  onBack,
  onResend,
  onSubmit,
}: {
  subtitle: ReactNode;
  onBack: () => void;
  onResend: () => Promise<void>;
  onSubmit: (code: string, password: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [tried, setTried] = useState(false);
  const bad = !meetsPasswordPolicy(password);

  return (
    <CodeStep
      title={t('auth.reset.title')}
      subtitle={subtitle}
      cta={t('auth.reset.submit')}
      backLabel={t('auth.reset.back')}
      onBack={onBack}
      onResend={onResend}
      onSubmit={async (code) => {
        setTried(true);
        if (bad) return;
        await onSubmit(code, password);
      }}
    >
      <div className="login-field-gap">
        <PasswordInput
          id="rs-pwd"
          value={password}
          onChange={setPassword}
          placeholder={t('auth.reset.newPassword')}
          autoComplete="new-password"
          invalid={tried && bad}
          describedBy="rs-rule"
        />
      </div>
      <PasswordMeter password={password} />
      <PasswordRule id="rs-rule" error={tried && bad} />
    </CodeStep>
  );
}
