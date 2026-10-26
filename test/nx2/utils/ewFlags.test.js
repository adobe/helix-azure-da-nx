import { expect } from '@esm-bundle/chai';
import { AEM_API } from '../../../nx2/utils/utils.js';
import {
  calls, installFetch, restoreFetch,
} from '../../../nx2/test/mocks/fetch.js';
import {
  getEWFlags, isEWEnabled, isEwChatDisabled, getCoworkerConfig, isCoworkerEnabled, getManifestId,
} from '../../../nx2/utils/ewFlags.js';

const installFlagsByPath = (byPath) => {
  installFetch();
  window.fetch = async (url) => {
    const u = url.toString();
    calls.push({ url: u, method: 'GET' });
    const match = Object.keys(byPath).find((path) => u.includes(path));
    const body = match ? byPath[match] : [];
    if (body instanceof Error) throw body;
    if (body instanceof Response) return body.clone();
    if (typeof body === 'string') return new Response(body, { status: 200 });
    const json = u.startsWith(AEM_API) ? { flags: body } : { flags: { data: body } };
    return new Response(JSON.stringify(json), { status: 200 });
  };
};

describe('getEWFlags', () => {
  afterEach(() => restoreFetch());

  it('returns all ew.* flags merged from org and site configs', async () => {
    installFlagsByPath({
      '/flag-site1/': [{ key: 'ew.canvasDefaultView', value: 'split' }],
      '/flag-org1/': [{ key: 'ew.enabled', value: 'true' }],
    });
    const flags = await getEWFlags({ org: 'flag-org1', site: 'flag-site1' });
    expect(flags).to.deep.equal({ 'ew.enabled': 'true', 'ew.canvasDefaultView': 'split' });
  });

  it('site level flag overrides org level flag', async () => {
    installFlagsByPath({
      '/flag-site2/': [{ key: 'ew.enabled', value: 'false' }],
      '/flag-org2/': [{ key: 'ew.enabled', value: 'true' }],
    });
    const flags = await getEWFlags({ org: 'flag-org2', site: 'flag-site2' });
    expect(flags['ew.enabled']).to.equal('false');
  });

  it('returns empty object when no ew.* flags are present', async () => {
    installFlagsByPath({});
    expect(await getEWFlags({ org: 'flag-org3', site: 'flag-site3' })).to.deep.equal({});
  });

  it('ignores non-ew.* flags', async () => {
    installFlagsByPath({ '/flag-site4/': [{ key: 'other.flag', value: 'true' }] });
    expect(await getEWFlags({ org: 'flag-org4', site: 'flag-site4' })).to.deep.equal({});
  });

  it('reads flags from a multi-sheet Azure config', async () => {
    installFetch({
      body: JSON.stringify({
        config: [],
        flags: [{ key: 'ew.enabled', value: 'true' }],
      }),
    });
    expect(await getEWFlags({ org: 'flag-multi-org', site: 'flag-multi-site' }))
      .to.deep.equal({ 'ew.enabled': 'true' });
  });

  it('does not read flags from an unrelated single sheet', async () => {
    installFetch({
      body: JSON.stringify({ config: [{ key: 'ew.enabled', value: 'true' }] }),
    });
    expect(await getEWFlags({ org: 'flag-config-org', site: 'flag-config-site' }))
      .to.deep.equal({});
  });
});

describe('isEWEnabled', () => {
  afterEach(() => restoreFetch());

  it('returns true when ew.enabled flag value is "true"', async () => {
    installFlagsByPath({
      '/ew-site1/': [{ key: 'ew.enabled', value: 'true' }],
    });
    expect(await isEWEnabled({ org: 'ew-org1', site: 'ew-site1' })).to.be.true;
  });

  it('returns false when ew.enabled flag value is "false"', async () => {
    installFlagsByPath({
      '/ew-site2/': [{ key: 'ew.enabled', value: 'false' }],
    });
    expect(await isEWEnabled({ org: 'ew-org2', site: 'ew-site2' })).to.be.false;
  });
});

describe('isEwChatDisabled', () => {
  afterEach(() => restoreFetch());

  it('returns true when ew.disableChat is set at org level but not site level', async () => {
    installFlagsByPath({
      '/dc-site1/': [],
      '/dc-org1/': [{ key: 'ew.disableChat', value: 'true' }],
    });
    expect(await isEwChatDisabled({ org: 'dc-org1', site: 'dc-site1' })).to.be.true;
  });

  it('returns true when ew.disableChat is set at site level but not org level', async () => {
    installFlagsByPath({
      '/dc-site2/': [{ key: 'ew.disableChat', value: 'true' }],
      '/dc-org2/': [],
    });
    expect(await isEwChatDisabled({ org: 'dc-org2', site: 'dc-site2' })).to.be.true;
  });

  it('returns false when ew.disableChat flag is not set at any level', async () => {
    installFlagsByPath({});
    expect(await isEwChatDisabled({ org: 'dc-org3', site: 'dc-site3' })).to.be.false;
  });

  // see https://github.com/adobe/da-live/issues/1218
  it('returns true (fail closed) when org config is forbidden', async () => {
    installFetch();
    window.fetch = async (url) => {
      const u = url.toString();
      calls.push({ url: u, method: 'GET' });
      // Site config is readable and enables EW but does not disable chat.
      if (u.includes('/dc-site4')) {
        return new Response(
          JSON.stringify({ flags: [{ key: 'ew.enabled', value: 'true' }] }),
          { status: 200 },
        );
      }
      // Org config (which sets ew.disableChat=true) is forbidden.
      return new Response('', { status: 403 });
    };
    expect(await isEwChatDisabled({ org: 'dc-org4', site: 'dc-site4' })).to.be.true;
  });

  it('allows the site to override an explicit org disable flag', async () => {
    installFlagsByPath({
      '/dc-site-override/': [{ key: 'ew.disableChat', value: 'false' }],
      '/dc-org-override/': [{ key: 'ew.disableChat', value: 'true' }],
    });
    expect(await isEwChatDisabled({ org: 'dc-org-override', site: 'dc-site-override' })).to.be.false;
  });

  ['org', 'site'].forEach((layer) => {
    [401, 403, 404, 500, 503].forEach((status) => {
      const denied = status === 401 || status === 403;
      it(`returns ${denied} when ${layer} config returns ${status} and the other layer enables EW`, async () => {
        const org = `dc-org-${layer}-${status}`;
        const site = `dc-site-${layer}-${status}`;
        const enabled = [{ key: 'ew.enabled', value: 'true' }];
        installFlagsByPath({
          [`/${site}/`]: layer === 'site' ? new Response('', { status }) : enabled,
          [`/${org}/`]: layer === 'org' ? new Response('', { status }) : enabled,
        });

        expect(await isEwChatDisabled({ org, site })).to.equal(denied);
        expect(await getEWFlags({ org, site })).to.deep.equal({ 'ew.enabled': 'true' });
      });
    });

    [401, 403].forEach((status) => {
      it(`does not override a ${status} on ${layer} config with an explicit allow flag`, async () => {
        const org = `dc-org-allow-${layer}-${status}`;
        const site = `dc-site-allow-${layer}-${status}`;
        const allowed = [{ key: 'ew.disableChat', value: 'false' }];
        installFlagsByPath({
          [`/${site}/`]: layer === 'site' ? new Response('', { status }) : allowed,
          [`/${org}/`]: layer === 'org' ? new Response('', { status }) : allowed,
        });

        expect(await isEwChatDisabled({ org, site })).to.be.true;
      });
    });

    const failures = {
      network: new TypeError('Failed to fetch'),
      json: '{invalid json',
    };
    Object.entries(failures).forEach(([failure, body]) => {
      it(`keeps readable flags when ${layer} config has a ${failure} error`, async () => {
        const org = `dc-org-${layer}-${failure}`;
        const site = `dc-site-${layer}-${failure}`;
        const enabled = [{ key: 'ew.enabled', value: 'true' }];
        installFlagsByPath({
          [`/${site}/`]: layer === 'site' ? body : enabled,
          [`/${org}/`]: layer === 'org' ? body : enabled,
        });

        expect(await isEwChatDisabled({ org, site })).to.be.false;
        expect(await getEWFlags({ org, site })).to.deep.equal({ 'ew.enabled': 'true' });
      });

      it(`keeps chat disabled by a readable layer when ${layer} config has a ${failure} error`, async () => {
        const org = `dc-org-disabled-${layer}-${failure}`;
        const site = `dc-site-disabled-${layer}-${failure}`;
        const disabled = [{ key: 'ew.disableChat', value: 'true' }];
        installFlagsByPath({
          [`/${site}/`]: layer === 'site' ? body : disabled,
          [`/${org}/`]: layer === 'org' ? body : disabled,
        });

        expect(await isEwChatDisabled({ org, site })).to.be.true;
        expect(await getEWFlags({ org, site })).to.deep.equal({ 'ew.disableChat': 'true' });
      });

      it(`keeps chat disabled by a permission failure when ${layer} config has a ${failure} error`, async () => {
        const org = `dc-org-denied-${layer}-${failure}`;
        const site = `dc-site-denied-${layer}-${failure}`;
        const denied = new Response('', { status: 403 });
        installFlagsByPath({
          [`/${site}/`]: layer === 'site' ? body : denied,
          [`/${org}/`]: layer === 'org' ? body : denied,
        });

        expect(await isEwChatDisabled({ org, site })).to.be.true;
      });
    });
  });

  it('returns false when no org is supplied', async () => {
    expect(await isEwChatDisabled({})).to.be.false;
  });
});

describe('getCoworkerConfig', () => {
  afterEach(() => restoreFetch());

  it('returns the coworker enablement plus alternate harness details', async () => {
    installFlagsByPath({
      '/cw-site1/': [{ key: 'ew.coworker', value: 'true' }, { key: 'ew.altHarness', value: 'act-key' }],
    });
    expect(await getCoworkerConfig({ org: 'cw-org1', site: 'cw-site1' })).to.deep.equal({
      enabled: true,
      altHarness: true,
      activationKey: 'act-key',
    });
  });

  it('returns false/null defaults when no coworker flags are set', async () => {
    installFlagsByPath({});
    expect(await getCoworkerConfig({ org: 'cw-org2', site: 'cw-site2' })).to.deep.equal({
      enabled: false,
      altHarness: false,
      activationKey: null,
    });
  });
});

describe('isCoworkerEnabled', () => {
  afterEach(() => restoreFetch());

  it('returns true when ew.coworker flag value is "true"', async () => {
    installFlagsByPath({
      '/cw-site1/': [{ key: 'ew.coworker', value: 'true' }],
    });
    expect(await isCoworkerEnabled({ org: 'cw-org1', site: 'cw-site1' })).to.be.true;
  });

  it('returns false when ew.coworker flag is not set at any level', async () => {
    installFlagsByPath({});
    expect(await isCoworkerEnabled({ org: 'cw-org2', site: 'cw-site2' })).to.be.false;
  });
});

describe('getManifestId', () => {
  afterEach(() => restoreFetch());

  it('returns the configured ew.coworkerManifest value as-is', async () => {
    installFlagsByPath({
      '/mf-site1/': [{ key: 'ew.coworkerManifest', value: 'staging-manifest' }],
    });
    expect(await getManifestId({ org: 'mf-org1', site: 'mf-site1' })).to.equal('staging-manifest');
  });

  it('returns null when ew.coworkerManifest is not set at any level', async () => {
    installFlagsByPath({});
    expect(await getManifestId({ org: 'mf-org2', site: 'mf-site2' })).to.equal(null);
  });
});
