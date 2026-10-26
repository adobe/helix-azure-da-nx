import { expect } from '@esm-bundle/chai';

describe('DA preview environment', () => {
  let savedPreview;

  beforeEach(() => {
    savedPreview = localStorage.getItem('da-preview');
  });

  afterEach(() => {
    if (savedPreview === null) localStorage.removeItem('da-preview');
    else localStorage.setItem('da-preview', savedPreview);
  });

  [
    ['prod', 'da-preview.az-boxa.aem.live'],
    ['stage', 'stage-preview.da.live'],
  ].forEach(([env, suffix]) => {
    it(`uses the ${env} preview suffix in both shells`, async () => {
      localStorage.setItem('da-preview', env);
      const [nx, nx2] = await Promise.all([
        import(`../../../nx/utils/utils.js?preview-test=${env}`),
        import(`../../../nx2/utils/utils.js?preview-test=${env}`),
      ]);
      expect(nx.DA_PREVIEW).to.equal(`https://${suffix}`);
      expect(nx2.DA_PREVIEW).to.equal(`https://${suffix}`);
      expect(nx.getLivePreviewUrl('org', 'site', 'feature'))
        .to.equal(`https://feature--site--org.${suffix}`);
    });
  });
});
