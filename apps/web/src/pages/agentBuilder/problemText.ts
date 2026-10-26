import type { TFunction } from 'i18next';

import { isSecretField, isSecretKind, modelName, type Model, type Problem } from './model';

/**
 * Items of a problem as text: names for models, at most three refs and, for a secret, only its
 * kind and the field it is in (never what matched).
 */
export function problemText(t: TFunction, item: Problem, models: readonly Model[]): string {
  if (item.key === 'secret') {
    const field = item.field ?? '';
    return t('agentBuilder.problems.secret', {
      items: item.items
        .slice(0, 3)
        .map((kind) => (isSecretKind(kind) ? t(`agentBuilder.secretKinds.${kind}`) : kind))
        .join(', '),
      field: t(`agentBuilder.secretFields.${isSecretField(field) ? field : 'other'}`),
    });
  }
  const items =
    item.key === 'modelNotEnabled' || item.key === 'modelWithoutTools'
      ? item.items.map((id) => modelName(models, id))
      : item.items;
  const tools = item.tools ?? [];
  return t(`agentBuilder.problems.${item.key}`, {
    items: items.slice(0, 3).join(', '),
    // Design: the first two tools, then an ellipsis.
    tools: tools.slice(0, 2).join(', ') + (tools.length > 2 ? '…' : ''),
    count: item.count ?? items.length,
    max: item.max ?? 0,
  });
}
