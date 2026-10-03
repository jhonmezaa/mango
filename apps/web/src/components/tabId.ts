/** Id of a tab of `Tabs`: its panel points back with `aria-labelledby={tabId(idPrefix, id)}`. */
export function tabId(idPrefix: string, id: string): string {
  return `${idPrefix}-tab-${id}`;
}
