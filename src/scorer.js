/**
 * Intent score 0-100. Explains itself: every point comes with a reason so a
 * sales rep can trust (or argue with) the ranking.
 */
export const TIERS = [
  { tier: 'hot', min: 70 },
  { tier: 'warm', min: 45 },
  { tier: 'cool', min: 0 },
];

export const tierFor = (score) => TIERS.find((t) => score >= t.min).tier;

const DAY = 86400000;

export function scoreLead(lead, { now = new Date() } = {}) {
  const reasons = [];
  const add = (points, why) => {
    if (points) reasons.push({ points, why });
    return points;
  };

  // 1. Strongest signal per category, plus a bonus for each extra category (funding + new CRO beats either alone).
  const byCategory = new Map();
  for (const s of lead.signals) {
    if (!byCategory.has(s.category) || byCategory.get(s.category).weight < s.weight) byCategory.set(s.category, s);
  }
  const ranked = [...byCategory.values()].sort((a, b) => b.weight - a.weight);
  let score = 0;
  ranked.forEach((s, i) => {
    score += add(i === 0 ? s.weight : Math.round(s.weight * 0.4), `${s.label}${s.field === 'summary' ? ' (in article body)' : ''}`);
  });

  // 2. Recency: intent decays fast.
  const ageDays = lead.published ? (now - new Date(lead.published)) / DAY : 30;
  if (ageDays <= 2) score += add(20, 'Published in the last 48 hours');
  else if (ageDays <= 7) score += add(12, 'Published this week');
  else if (ageDays <= 14) score += add(6, 'Published in the last 2 weeks');
  else if (ageDays > 30) score += add(-10, 'Older than 30 days');

  // 3. Size of the round (rough budget signal). Mega-rounds get no extra: those buyers are enterprise, not agency.
  const amount = lead.amount?.value || 0;
  if (amount >= 1e6 && amount <= 2e8) score += add(amount >= 1e7 ? 10 : 6, `Raised ${lead.amount.display}`);
  else if (amount >= 1e9) score += add(-10, `Mega deal (${lead.amount.display}): enterprise buyer, long sales cycle`);

  // 4. Same company in several stories = louder signal.
  if (lead.articles.length > 1) score += add(Math.min(10, 5 * (lead.articles.length - 1)), `Covered in ${lead.articles.length} stories`);

  // 5. Unknown company is hard to act on.
  if (!lead.company) score += add(-15, 'Company name not identified');

  // 6. Gemini's fit with your offer/ICP (0-10), when available.
  if (lead.ai && Number.isFinite(lead.ai.icp_fit)) {
    score += add(Math.round((lead.ai.icp_fit - 5) * 3), `AI fit with your ICP: ${lead.ai.icp_fit}/10`);
  }

  const final = Math.max(0, Math.min(100, Math.round(score)));
  return { score: final, tier: tierFor(final), reasons };
}
