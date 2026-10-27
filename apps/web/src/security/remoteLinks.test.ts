import { describe, expect, it } from 'vitest';

import { classifyRemoteLink, type RemoteLinkSource } from './remoteLinks';

const ADO: RemoteLinkSource = {
  service: 'Azure DevOps',
  linkHosts: ['dev.azure.com', 'visualstudio.com'],
  organizations: ['Empresa'],
};

const of = (href: string) => classifyRemoteLink(new URL(href), [ADO]);

describe('classifyRemoteLink (A1)', () => {
  it('is the company only for a registered organization of the service', () => {
    expect(of('https://dev.azure.com/empresa/Plataforma/_wiki/wikis/x/12')).toEqual({
      kind: 'own',
      host: 'dev.azure.com',
      label: 'dev.azure.com/empresa',
      org: 'empresa',
      service: 'Azure DevOps',
    });
    expect(of('https://empresa.visualstudio.com/Plataforma').kind).toBe('own');
  });

  it('marks another organization of the same service', () => {
    const link = of('https://dev.azure.com/plataforma-tableros/_signin');
    expect(link.kind).toBe('other-org');
    expect(link.org).toBe('plataforma-tableros');
    expect(link.label).toBe('dev.azure.com/plataforma-tableros');
    expect(of('https://dev.azure.com/').kind).toBe('other-org');
    expect(of('https://otra.visualstudio.com/').kind).toBe('other-org');
  });

  it('marks any other domain, look-alikes included', () => {
    for (const href of [
      'https://azure-devops-signin.example.net/login',
      'https://dev.azure.com.example.net/empresa',
      'https://devazure.com/empresa',
      'https://evil-visualstudio.com/empresa',
    ]) {
      const link = of(href);
      expect(link.kind, href).toBe('other');
      expect(link.org, href).toBeNull();
    }
  });

  it('never reads an organization out of a malformed segment', () => {
    expect(of('https://dev.azure.com/%3Cscript%3E/').kind).toBe('other-org');
    expect(of('https://dev.azure.com/%3Cscript%3E/').org).toBeNull();
  });

  it('without sources everything is another domain', () => {
    expect(classifyRemoteLink(new URL('https://dev.azure.com/empresa'), []).kind).toBe('other');
  });
});
