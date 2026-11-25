import { describe, expect, it } from 'vitest';
import { analyse } from '@/modules/renewal-agent/compare';
import { toRoleDocs } from '@/modules/renewal-agent';
import { buildExplanation, selectExplainItems, type ExplainFinding } from '@/modules/renewal-agent/explain';
import { listFixtureCases, loadFixtureDocuments } from '@/modules/renewal-agent/fixtures';
import { CLARIFY_PREFIX } from '@/modules/renewal-agent/types';

async function completeFindings(): Promise<ExplainFinding[]> {
  const c = (await listFixtureCases()).find((x) => x.name === 'complete')!;
  const a = analyse(toRoleDocs(await loadFixtureDocuments(c)));
  return a.findings.map((f) => ({ id: f.key, classification: f.classification, status: 'open', attributes: f.attributes ?? null }));
}

describe('customer explanation', () => {
  it('English: a draft needing approval, lists every material change with old and new values', async () => {
    const e = buildExplanation(await completeFindings(), 'en');
    expect(e.text).toMatch(/^DRAFT - for internal review only\. Do not send to the customer until a supervisor has approved/);
    expect(e.changes.map((c) => c.field).sort()).toEqual(['copay', 'deductible', 'exclusion', 'premium', 'sub_limit']);
    expect(e.text).toContain('Dear Anita Deshpande');
    expect(e.text).toContain('Rs 24,500 before and Rs 28,900 now');
    expect(e.text).toContain('0% (all claims) before and 20% (claims for insured persons aged 61+) now');
    expect(e.text).toContain('Infertility and assisted reproduction treatment');
    // rephrasings and unchanged terms are not presented as changes
    expect(e.text).not.toContain('Initial waiting period');
    expect(e.text).not.toMatch(/\b(is|are|will be) (not )?covered\b/i);
  });

  it('Hindi: correct Devanagari, a visible draft banner, each change, no placeholders', async () => {
    const e = buildExplanation(await completeFindings(), 'hi');
    const t = e.text;
    expect(t).toBe(t.normalize('NFC'));
    expect(t.startsWith('मसौदा (ड्राफ़्ट): यह संदेश अभी ग्राहक को भेजने के लिए नहीं है।')).toBe(true);
    expect(t).toContain('अधिकृत व्यक्ति की मंज़ूरी ज़रूरी है');
    expect(t).toContain('प्रिय Anita Deshpande,');
    expect(t).toContain('प्रीमियम (पॉलिसी के लिए आपके द्वारा दी जाने वाली राशि): पहले ₹24,500, अब ₹28,900।');
    expect(t).toContain('को-पेमेंट (क्लेम की राशि में आपका अपना हिस्सा): पहले 0% (सभी क्लेम), अब 20% (61 वर्ष या उससे अधिक आयु के बीमित व्यक्तियों के क्लेम)।');
    expect(t).toContain('डिडक्टिबल');
    expect(t).toContain('शून्य (₹0)');
    expect(t).toContain('उप-सीमा (मोतियाबिंद की सर्जरी): पहले ₹40,000 प्रति आँख, अब ₹30,000 प्रति आँख।');
    expect(t).toContain('नया बहिष्करण');
    expect(t).toContain('क्लेम स्वीकार होगा या नहीं, यह निर्णय बीमा कंपनी का होता है');
    expect(t).not.toMatch(/undefined|NaN|\[object|\{\{/);
    // Devanagari dominates the prose; the only Latin text is names, the product and quoted document wording.
    const dev = (t.match(/[ऀ-ॿ]/g) ?? []).length;
    expect(dev).toBeGreaterThan(300);
    // no English template words leaked into the Hindi frame
    expect(t).not.toMatch(/\b(before|now|Changes|Dear|DRAFT)\b/);
  });

  it('numbers are formatted with Indian grouping', async () => {
    const e = buildExplanation(await completeFindings(), 'en');
    expect(buildExplanation(await completeFindings(), 'hi').text).toContain('₹');
    expect(e.text).toMatch(/Rs 10,000 per claim/);
  });

  it('the version changes whenever the text changes, so an approval cannot outlive an edit', async () => {
    const fs = await completeFindings();
    const v1 = buildExplanation(fs, 'en').version;
    expect(buildExplanation(fs, 'en').version).toBe(v1);
    const rejected = fs.map((f) => (f.id === 'renewal:premium' ? { ...f, status: 'dismissed' } : f));
    expect(buildExplanation(rejected, 'en').version).not.toBe(v1);
    expect(buildExplanation(fs, 'hi').version).not.toBe(v1);
    expect(v1).toMatch(/^renewal-expl-1-en:[0-9a-f]{12}$/);
  });

  it('rejected changes are left out; "needs insurer clarification" moves to its own section', async () => {
    const fs = await completeFindings();
    const decided = fs.map((f) =>
      f.id === 'renewal:copay'
        ? { ...f, status: 'overridden', decisionNote: `${CLARIFY_PREFIX.trim()} confirm age band` }
        : f.id === 'renewal:deductible'
          ? { ...f, status: 'dismissed', decisionNote: 'wrong' }
          : f,
    );
    const sel = selectExplainItems(decided);
    expect(sel.changes.map((c) => c.field)).not.toContain('copay');
    expect(sel.changes.map((c) => c.field)).not.toContain('deductible');
    expect(sel.clarifications.map((c) => c.field)).toEqual(['copay']);
    const en = buildExplanation(decided, 'en').text;
    expect(en).toContain('asking the insurer to clarify');
    expect(en).not.toContain('Deductible (the amount');
  });

  it('with nothing to explain, says so instead of inventing changes', () => {
    expect(buildExplanation([], 'en').text).toContain('did not find any confirmed change');
    expect(buildExplanation([], 'hi').text).toContain('कोई बदलाव पुष्ट नहीं दिखा');
  });
});
