import { expect } from '@esm-bundle/chai';
import { AEM_API, HLX_ADMIN } from '../../../nx2/utils/utils.js';
import {
  calls as sharedCalls,
  installFetch as installFetchOnce,
  restoreFetch as restoreFetchOnce,
} from '../../../nx2/test/mocks/fetch.js';
import {
  buildAemPathFromHashState,
  formatAemPreviewPublishError,
  getAemBranch,
  getAemBranchHref,
  requestAemRole,
  runAemPreviewOrPublish,
} from '../../../nx2/utils/aem-preview-publish.js';

const STORAGE_KEY = 'hlx6-upgrade';
const flagHlx6 = (org, site) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    ...(JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {}),
    [`/${org}/${site}`]: true,
  }));
};

let origFetch;
let calls = [];

const installFetch = (responses = []) => {
  calls = [];
  origFetch = window.fetch;
  let idx = 0;
  window.fetch = async (url, opts = {}) => {
    const u = url.toString();
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body });
    if (u.includes(`${HLX_ADMIN}/ping/`)) return new Response('', { status: 200 });
    const resp = responses[idx] ?? responses[responses.length - 1];
    idx += 1;
    return resp;
  };
};

const restoreFetch = () => {
  if (origFetch) window.fetch = origFetch;
  origFetch = null;
};

const mockIms = (profile) => {
  window.adobeIMS = { getProfile: async () => profile };
};

const clearIms = () => { delete window.adobeIMS; };

let counter = 0;
const uniq = (label) => {
  counter += 1;
  return `${label}-${counter}`;
};

const PROFILE = { userId: 'uid-1', email: 'test@adobe.com', displayName: 'Test User' };
const permUrl = (org, site) => `${AEM_API}/${org}/sites/${site}/source/.da/aem-permission-requests.json`;
const permCalls = (org, site) => calls.filter((c) => c.url === permUrl(org, site));
const EMPTY_TPL = '{"users":{"total":1,"limit":1,"offset":0,"data":[]},"data":{"total":1,"limit":1,"offset":0,"data":[{}]},":names":["users","data"],":version":3,":type":"multi-sheet"}';

describe('aem-preview-publish.js', () => {
  afterEach(() => {
    restoreFetch();
    clearIms();
  });

  describe('buildAemPathFromHashState', () => {
    it('returns null when any segment is missing', () => {
      expect(buildAemPathFromHashState(null)).to.be.null;
      expect(buildAemPathFromHashState({ org: 'o', site: 's' })).to.be.null;
    });

    it('builds lowercased path', () => {
      expect(buildAemPathFromHashState({ org: 'Org', site: 'Site', path: '/Doc' })).to.equal('/org/site/doc');
    });
  });

  describe('formatAemPreviewPublishError', () => {
    it('returns unknown error for missing input', () => {
      expect(formatAemPreviewPublishError(null)).to.equal('Unknown error');
    });

    it('concatenates details when present', () => {
      expect(formatAemPreviewPublishError({ message: 'Err', details: 'info' })).to.equal('Err: info');
    });
  });

  describe('requestAemRole', () => {
    it('returns failure message when adobeIMS is unavailable', async () => {
      const result = await requestAemRole('myorg', 'mysite', 'preview');
      expect(result.message[0]).to.equal('Could not get user profile.');
      expect(result.message[1]).to.equal('Please sign in and try again.');
    });

    it('uses template JSON when permission file does not exist (GET 404) and returns success on POST 200', async () => {
      const org = uniq('org');
      const site = uniq('site');
      mockIms(PROFILE);
      installFetch([
        new Response('Not found', { status: 404 }),
        new Response('{}', { status: 200 }),
      ]);

      const result = await requestAemRole(org, site, 'preview');

      expect(result.message[0]).to.equal('Successfully requested role!');
      expect(result.message[1]).to.equal('An administrator will need to approve.');
      const [getCall, postCall] = permCalls(org, site);
      expect(getCall.method).to.equal('GET');
      expect(postCall.method).to.equal('POST');
    });

    it('reads existing JSON and upserts current user when GET 200', async () => {
      const org = uniq('org');
      const site = uniq('site');
      mockIms(PROFILE);
      const existing = JSON.parse(EMPTY_TPL);
      existing.users.data.push({ Id: 'other-uid', Email: 'other@test.com', Action: 'preview' });

      installFetch([
        new Response(JSON.stringify(existing), { status: 200 }),
        new Response('{}', { status: 200 }),
      ]);

      const result = await requestAemRole(org, site, 'preview');
      expect(result.message[0]).to.equal('Successfully requested role!');

      const [, postCall] = permCalls(org, site);
      expect(postCall.body).to.be.a('string');
      const saved = JSON.parse(postCall.body);

      // Verify new user entry for current userId
      expect(saved.users.data.filter((u) => u.Id === PROFILE.userId)).to.have.length(1);
      expect(saved.users.data.filter((u) => u.Id === PROFILE.userId)[0].Action).to.equal('preview');

      // Verify existing other-uid entry is still present
      expect(saved.users.data.filter((u) => u.Id === 'other-uid')).to.have.length(1);

      // Verify total entries
      expect(saved.users.data).to.have.length(2);
    });

    it('updates existing entry in place (same userId)', async () => {
      const org = uniq('org');
      const site = uniq('site');
      mockIms(PROFILE);
      const existing = JSON.parse(EMPTY_TPL);
      existing.users.data.push({ Id: PROFILE.userId, Email: PROFILE.email, Action: 'old-action' });

      installFetch([
        new Response(JSON.stringify(existing), { status: 200 }),
        new Response('{}', { status: 200 }),
      ]);

      await requestAemRole(org, site, 'preview');

      const [, postCall] = permCalls(org, site);
      const saved = JSON.parse(postCall.body);
      expect(saved.users.data.filter((u) => u.Id === PROFILE.userId)).to.have.length(1);
      expect(saved.users.data[0].Action).to.equal('preview');
    });

    it('returns failure message when POST fails', async () => {
      const org = uniq('org');
      const site = uniq('site');
      mockIms(PROFILE);
      installFetch([
        new Response('Not found', { status: 404 }),
        new Response('Server error', { status: 500 }),
      ]);

      const result = await requestAemRole(org, site, 'preview');
      expect(result.message[0]).to.equal('Could not request permissions.');
      expect(result.message[1]).to.equal('Please notify your administrator.');
    });
  });

  describe('runAemPreviewOrPublish', () => {
    afterEach(() => restoreFetchOnce());

    ['preview', 'publish'].forEach((action) => {
      it(`${action}: fetches Azure sidekick hosts and preserves the returned webPath`, async () => {
        const org = uniq('org');
        const site = uniq('site');
        const resultBody = JSON.stringify({
          preview: { url: 'https://fallback.example/page' },
          live: { url: 'https://fallback.example/page' },
          webPath: '/folder/page',
        });
        const sidekick = {
          previewHost: 'preview.example',
          liveHost: 'live.example',
          ...(action === 'publish' ? { host: 'www.example' } : {}),
        };
        installFetch([
          new Response(resultBody),
          ...(action === 'publish' ? [new Response(resultBody)] : []),
          new Response(JSON.stringify(sidekick)),
        ]);

        const result = await runAemPreviewOrPublish({ aemPath: `/${org}/${site}/page`, action });

        expect(result).to.deep.equal({
          ok: true,
          url: `https://${action === 'publish' ? 'www' : 'preview'}.example/folder/page`,
        });
        expect(calls.map(({ url, method }) => ({ url, method }))).to.deep.equal([
          { url: `${AEM_API}/${org}/sites/${site}/preview/page`, method: 'POST' },
          ...(action === 'publish' ? [{ url: `${AEM_API}/${org}/sites/${site}/live/page`, method: 'POST' }] : []),
          { url: `${AEM_API}/${org}/sites/${site}/sidekick`, method: 'GET' },
        ]);
      });
    });

    it('uses the preview response URL when Azure sidekick config is unavailable', async () => {
      const org = uniq('org');
      const site = uniq('site');
      installFetch([
        new Response(JSON.stringify({
          preview: { url: 'https://fallback.example/page' },
          webPath: '/page',
        })),
        new Response('Not found', { status: 404 }),
      ]);

      const result = await runAemPreviewOrPublish({ aemPath: `/${org}/${site}/page`, action: 'preview' });

      expect(result).to.deep.equal({ ok: true, url: 'https://fallback.example/page' });
      expect(calls[1].url).to.equal(`${AEM_API}/${org}/sites/${site}/sidekick`);
    });

    it('rejects an invalid action without making any request', async () => {
      const result = await runAemPreviewOrPublish({ aemPath: '/org/site/page', action: 'bogus' });
      expect(result.ok).to.equal(false);
      expect(result.error.message).to.equal('Invalid action');
    });

    it('preview: uses Azure without an upgrade flag and resolves json.preview.url', async () => {
      const org = uniq('org');
      const site = uniq('site');
      installFetchOnce({ body: JSON.stringify({ preview: { url: 'https://legacy-preview.example/page' } }) });

      const result = await runAemPreviewOrPublish({ aemPath: `/${org}/${site}/page`, action: 'preview' });

      expect(result.ok).to.equal(true);
      expect(result.url).to.equal('https://legacy-preview.example/page');
      expect(sharedCalls.some((c) => c.url === `${AEM_API}/${org}/sites/${site}/preview/page`)).to.equal(true);
    });

    it('preview: hlx6 hits AEM_API instead of HLX_ADMIN', async () => {
      const org = uniq('org');
      const site = uniq('site');
      flagHlx6(org, site);
      installFetchOnce({ body: JSON.stringify({ preview: { url: 'https://hlx6-preview.example/page' } }) });

      const result = await runAemPreviewOrPublish({ aemPath: `/${org}/${site}/page`, action: 'preview' });

      expect(result.ok).to.equal(true);
      expect(result.url).to.equal('https://hlx6-preview.example/page');
      expect(sharedCalls.some((c) => c.url === `${AEM_API}/${org}/sites/${site}/preview/page`)).to.equal(true);
      expect(sharedCalls.some((c) => c.url.includes(`${HLX_ADMIN}/preview/`))).to.equal(false);
    });

    it('publish: previews then publishes, resolving the URL from json.live.url', async () => {
      const org = uniq('org');
      const site = uniq('site');
      installFetchOnce({
        body: JSON.stringify({
          preview: { url: 'https://legacy-preview.example/page' },
          live: { url: 'https://legacy-live.example/page' },
        }),
      });

      const result = await runAemPreviewOrPublish({ aemPath: `/${org}/${site}/page`, action: 'publish' });

      expect(result.ok).to.equal(true);
      expect(result.url).to.equal('https://legacy-live.example/page');
      expect(sharedCalls.some((c) => c.url === `${AEM_API}/${org}/sites/${site}/preview/page`)).to.equal(true);
      expect(sharedCalls.some((c) => c.url === `${AEM_API}/${org}/sites/${site}/live/page`)).to.equal(true);
    });

    it('returns an authorization error on 401 without a details field', async () => {
      const org = uniq('org');
      const site = uniq('site');
      installFetchOnce({ status: 401 });

      const result = await runAemPreviewOrPublish({ aemPath: `/${org}/${site}/page`, action: 'preview' });

      expect(result.ok).to.equal(false);
      expect(result.error.message).to.equal('Not authorized to preview.');
      expect(result.error.details).to.be.undefined;
    });

    it('strips the admin/preview boilerplate from an x-error header on failure', async () => {
      const org = uniq('org');
      const site = uniq('site');
      installFetchOnce({
        status: 500,
        headers: { 'x-error': "[admin] Unable to preview '/org/site/page': some detail" },
      });

      const result = await runAemPreviewOrPublish({ aemPath: `/${org}/${site}/page`, action: 'preview' });

      expect(result.ok).to.equal(false);
      expect(result.error.message).to.equal('Error during preview');
      expect(result.error.details).to.equal('some detail');
    });

    it('rewrites the live/publish error action and message when publish fails', async () => {
      const org = uniq('org');
      const site = uniq('site');
      installFetch([
        new Response(JSON.stringify({ preview: { url: 'https://legacy-preview.example/page' } }), { status: 200 }),
        new Response('forbidden', { status: 403 }),
      ]);

      const result = await runAemPreviewOrPublish({ aemPath: `/${org}/${site}/page`, action: 'publish' });

      expect(result.ok).to.equal(false);
      expect(result.error.action).to.equal('publish');
      expect(result.error.message).to.equal('Not authorized to publish.');
    });

    it('returns ok:false when the response has no preview URL and no sidekick fallback resolves', async () => {
      const org = uniq('org');
      const site = uniq('site');
      installFetchOnce({ body: JSON.stringify({}) });

      const result = await runAemPreviewOrPublish({ aemPath: `/${org}/${site}/page`, action: 'preview' });

      expect(result.ok).to.equal(false);
      expect(result.error.message).to.equal('Preview URL missing from response.');
    });

    it('preview: targets the branch host when a branch is given', async () => {
      const org = uniq('org');
      const site = uniq('site');
      installFetchOnce({ body: JSON.stringify({ webPath: '/page', preview: { url: `https://main--${site}--${org}.aem.page/page` } }) });

      const result = await runAemPreviewOrPublish({ aemPath: `/${org}/${site}/page`, action: 'preview', branch: 'feat-x' });

      expect(result.url).to.equal(`https://feat-x--${site}--${org}.aem.page/page`);
      expect(sharedCalls.some((c) => c.url.includes('/sidekick/'))).to.equal(false);
    });

    it('publish: targets the branch live host when a branch is given', async () => {
      const org = uniq('org');
      const site = uniq('site');
      installFetchOnce({
        body: JSON.stringify({
          webPath: '/page',
          preview: { url: 'https://legacy-preview.example/page' },
          live: { url: 'https://legacy-live.example/page' },
        }),
      });

      const result = await runAemPreviewOrPublish({ aemPath: `/${org}/${site}/page`, action: 'publish', branch: 'feat-x' });

      expect(result.url).to.equal(`https://feat-x--${site}--${org}.aem.live/page`);
    });
  });

  describe('getAemBranch', () => {
    it('returns null for empty, main, and local', () => {
      expect(getAemBranch(null)).to.be.null;
      expect(getAemBranch('')).to.be.null;
      expect(getAemBranch('main')).to.be.null;
      expect(getAemBranch('Local')).to.be.null;
    });

    it('normalizes a branch name to its hostname form', () => {
      expect(getAemBranch('Feat/My_Branch')).to.equal('feat-my-branch');
    });
  });

  describe('getAemBranchHref', () => {
    it('builds preview and live branch URLs', () => {
      const args = { aemPath: '/org/site/a/b', branch: 'dev', webPath: '/a/b' };
      expect(getAemBranchHref({ ...args, tier: 'preview' })).to.equal('https://dev--site--org.aem.page/a/b');
      expect(getAemBranchHref({ ...args, tier: 'live' })).to.equal('https://dev--site--org.aem.live/a/b');
    });

    it('returns null without a branch or webPath', () => {
      expect(getAemBranchHref({ aemPath: '/org/site/a', branch: null, tier: 'preview', webPath: '/a' })).to.be.null;
      expect(getAemBranchHref({ aemPath: '/org/site/a', branch: 'dev', tier: 'preview' })).to.be.null;
    });
  });
});
