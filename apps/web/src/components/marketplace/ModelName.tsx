import type { ModelNames } from './model';

/**
 * A model of an agent (design marketplace.jsx `mkModel`): its name for creators and admins, who
 * can read the catalog, and its identifier (mono) for everyone else or when the catalog does not
 * list it any more. Both come from the API and are rendered as text.
 */
export function ModelName({ model, names }: { model: string; names: ModelNames }) {
  const name = names.get(model);
  return name === undefined ? <span className="mono">{model}</span> : <span>{name}</span>;
}
